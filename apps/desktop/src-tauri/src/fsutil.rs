//! Private file and directory permissions, shared by the local store and `keys`.
//!
//! Unix:
//! - Directories are created 0700. An existing one is rejected if group/others can write to it or another user owns
//!   it; otherwise it is forced to 0700.
//! - Files are opened with `O_NOFOLLOW | O_NONBLOCK` (symlinks are rejected, FIFOs do not block) and all checks
//!   (regular file, owner, mode) run on the open descriptor, not the path. A mode looser than 0600 is reported as
//!   [`InsecurePermissions`] and never silently fixed.
//!
//! Windows: symlinks and junctions are rejected for the directory and every file (files are checked on the open
//! handle, as on Unix). The actual DACL of the directory and of each opened file is also checked on the handle:
//! - Private: the owner and every granted entry belong to the current user, SYSTEM or Administrators (the latter two
//!   are root-equivalent and can take any file anyway). Deny entries do not count as access.
//! - Anything else (Everyone, Users, Authenticated Users, another user…) is locked down by the app itself: full
//!   control for the user and SYSTEM only, inheritance from above disabled, owner set to the user, inheritable into
//!   directories. Then it is checked again; if that fails, access is refused ([`InsecurePermissions`]).
//! - Every directory check also walks its contents (up to 32 levels, not following links or junctions) and locks
//!   down whatever is open, so a half-finished lockdown is redone in full next time. New entries inherit.
//!
//! Safeguards: only the given path and its contents are changed, never parent directories; a drive root or a path
//! with fewer than two components is rejected untouched; a file with more than one name (a hard link, possibly to a
//! file elsewhere) is rejected rather than locked down.
//!
//! Limits (Windows): intermediate and parent directories are not checked; SYSTEM and Administrators can always read;
//! files not opened through here (e.g. the wallet's) are only locked down when their directory is checked; a synced
//! directory (OneDrive) may have copies off this machine that these permissions do not protect.

use std::fmt;
use std::io;
use std::path::Path;

/// Insecure permissions. Carried inside a `PermissionDenied` `io::Error`; [`is_insecure`] recognises it.
#[derive(Debug)]
pub struct InsecurePermissions(pub &'static str);

impl fmt::Display for InsecurePermissions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "insecure permissions: {}", self.0)
    }
}

impl std::error::Error for InsecurePermissions {}

/// Whether the error is an [`InsecurePermissions`].
pub fn is_insecure(error: &io::Error) -> bool {
    error.get_ref().is_some_and(|inner| inner.is::<InsecurePermissions>())
}

fn insecure(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, InsecurePermissions(reason))
}

/// Creates the directory (and missing parents) as 0700 and checks or enforces its mode (see the module docs).
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    imp::ensure_dir(dir)
}

/// Creates an empty 0600 file if missing; otherwise validates it (regular, ours, no more than 0600).
pub fn ensure_private_file(path: &Path) -> io::Result<()> {
    imp::open_file(path, true).map(drop)
}

/// Validates an existing file without creating it. Missing: `NotFound`.
pub fn check_private_file(path: &Path) -> io::Result<()> {
    open_private_file(path).map(drop)
}

/// Opens an existing, validated file for reading (used for the seed): the descriptor read from is the one that was
/// checked, not a second open of the path. Missing: `NotFound`.
pub fn open_private_file(path: &Path) -> io::Result<std::fs::File> {
    imp::open_file(path, false)
}

#[cfg(unix)]
mod imp {
    use super::{Path, insecure, io};
    use std::fs::{DirBuilder, File, OpenOptions};
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};

    const FLAGS: i32 = libc::O_NOFOLLOW | libc::O_NONBLOCK;

    /// Effective uid of the process (works on macOS and with `PR_SET_DUMPABLE = 0`, where `/proc/self` fails).
    pub(super) fn process_uid() -> u32 {
        // SAFETY: geteuid takes no pointers, cannot fail and has no side effects.
        unsafe { libc::geteuid() }
    }

    fn check_owner(meta: &std::fs::Metadata) -> io::Result<()> {
        if meta.uid() == process_uid() { Ok(()) } else { Err(insecure("owner differs from the current user")) }
    }

    pub fn ensure_dir(dir: &Path) -> io::Result<()> {
        DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        let meta = std::fs::metadata(dir)?;
        if !meta.is_dir() {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        check_owner(&meta)?;
        if meta.mode() & 0o022 != 0 {
            return Err(insecure("folder writable by group or others"));
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
    }

    fn open_error(error: io::Error) -> io::Error {
        if error.raw_os_error() == Some(libc::ELOOP) {
            insecure("symbolic link")
        } else {
            error
        }
    }

    /// Checks on the already open descriptor.
    fn verify(file: &File) -> io::Result<()> {
        let meta = file.metadata()?;
        if !meta.is_file() {
            return Err(insecure("not a regular file"));
        }
        check_owner(&meta)?;
        if meta.mode() & 0o077 != 0 {
            return Err(insecure("file more open than 0600"));
        }
        Ok(())
    }

    pub fn open_file(path: &Path, create: bool) -> io::Result<File> {
        let mut options = OpenOptions::new();
        options.read(true).custom_flags(FLAGS);
        if create {
            options.append(true).create(true).mode(0o600);
        }
        let file = options.open(path).map_err(open_error)?;
        verify(&file)?;
        Ok(file)
    }
}

#[cfg(windows)]
mod imp {
    use super::{Path, insecure, io};
    use std::ffi::c_void;
    use std::fs::{File, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{HANDLE, LocalFree};
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT, SetSecurityInfo};
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_REVISION, ACL_SIZE_INFORMATION, AclSizeInformation,
        AddAccessAllowedAceEx, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, GetAce, GetAclInformation,
        GetLengthSid, GetTokenInformation, InitializeAcl, IsValidSid, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ALL_ACCESS, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, GetFileInformationByHandle, READ_CONTROL, SYNCHRONIZE, WRITE_DAC, WRITE_OWNER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// On Windows `is_symlink` is true for both symlinks and junctions (`mklink /J`).
    const LINK: &str = "symbolic link or junction";

    // ---- Classification (pure: SIDs and entries already read, no Windows calls) ----

    /// Binary SID (Windows layout: revision, sub-authority count, authority, sub-authorities).
    pub(super) type Sid = Vec<u8>;

    /// S-1-5-18 (SYSTEM).
    pub(super) const SYSTEM: &[u8] = &[1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0];
    /// S-1-5-32-544 (Administrators).
    pub(super) const ADMINISTRATORS: &[u8] = &[1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x20, 0x02, 0, 0];
    /// S-1-3-0 (CREATOR OWNER): inherit-only; once inherited it becomes whoever creates the file.
    const CREATOR_OWNER: &[u8] = &[1, 1, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0];
    /// S-1-3-4 (OWNER RIGHTS): the owner's rights, and the owner is already required to be trusted.
    const OWNER_RIGHTS: &[u8] = &[1, 1, 0, 0, 0, 0, 0, 3, 4, 0, 0, 0];

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum EntryKind {
        Allow,
        Deny,
        /// A granted entry of a type that is not parsed (object, conditional…): treated as open.
        Unreadable,
    }

    #[derive(Clone, Debug)]
    pub(super) struct Entry {
        pub kind: EntryKind,
        pub mask: u32,
        pub sid: Sid,
    }

    /// Owner and DACL of an object. `dacl: None` is a null DACL: full access for everyone.
    #[derive(Clone, Debug)]
    pub(super) struct Security {
        pub owner: Sid,
        pub dacl: Option<Vec<Entry>>,
    }

    fn trusted(sid: &[u8], user: &[u8]) -> bool {
        sid == user || sid == SYSTEM || sid == ADMINISTRATORS
    }

    /// `None` if private, otherwise the reason. Inherit-only entries count too, since they would reach anything
    /// created inside. `SYNCHRONIZE` alone grants nothing.
    pub(super) fn open_reason(security: &Security, user: &[u8]) -> Option<&'static str> {
        if !trusted(&security.owner, user) {
            return Some("owner differs from the current user");
        }
        let Some(dacl) = &security.dacl else {
            return Some("no permission list: access for everyone");
        };
        for entry in dacl {
            match entry.kind {
                EntryKind::Deny => {}
                EntryKind::Unreadable => return Some("permission granted of a kind the app cannot read"),
                EntryKind::Allow => {
                    let grants = entry.mask & !SYNCHRONIZE != 0;
                    let fine = trusted(&entry.sid, user) || entry.sid == CREATOR_OWNER || entry.sid == OWNER_RIGHTS;
                    if grants && !fine {
                        return Some("access for other users or groups");
                    }
                }
            }
        }
        None
    }

    // ---- Reading and changing permissions (Windows API, on open handles) ----

    /// What to lock down: the opened and checked object, its path, the user and whether it is a directory.
    pub(super) struct Target<'a> {
        pub object: &'a File,
        pub path: &'a Path,
        pub user: &'a [u8],
        pub change_owner: bool,
        pub is_dir: bool,
    }

    /// Locks down the opened object ([`close_object`]). Tests replace it to simulate failures.
    pub(super) type Apply = fn(&Target) -> io::Result<()>;

    fn win32(ok: i32) -> io::Result<()> {
        if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
    }

    fn status(code: u32) -> io::Result<()> {
        if code == 0 { Ok(()) } else { Err(io::Error::from_raw_os_error(code as i32)) }
    }

    /// Copies a SID handed out by Windows.
    ///
    /// # Safety
    /// `sid` is null or points to a SID in memory that stays valid for the duration of the call.
    unsafe fn copy_sid(sid: PSID) -> io::Result<Sid> {
        // SAFETY: per the contract; IsValidSid is checked before reading the length.
        unsafe {
            if sid.is_null() || IsValidSid(sid) == 0 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid SID"));
            }
            Ok(std::slice::from_raw_parts(sid.cast::<u8>(), GetLengthSid(sid) as usize).to_vec())
        }
    }

    /// SID of the process user (from the token, not the name).
    pub(super) fn current_user() -> io::Result<Sid> {
        let mut raw: HANDLE = null_mut();
        // SAFETY: GetCurrentProcess is a pseudo-handle; `raw` receives an owned handle that is closed on drop.
        win32(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) })?;
        // SAFETY: valid, freshly opened handle owned by nobody else.
        let token = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut needed = 0u32;
        // SAFETY: first call only queries the size (fails on purpose with an empty buffer).
        unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut needed) };
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8).max(1)];
        let size = (buffer.len() * 8) as u32;
        // SAFETY: buffer is 8-byte aligned and of the requested size.
        let info = buffer.as_mut_ptr().cast();
        win32(unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, info, size, &mut needed) })?;
        // SAFETY: Windows wrote a TOKEN_USER at the start of the buffer; its SID points into the same buffer.
        unsafe { copy_sid((*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid) }
    }

    /// Frees the descriptor allocated by GetSecurityInfo.
    struct Descriptor(PSECURITY_DESCRIPTOR);

    impl Drop for Descriptor {
        fn drop(&mut self) {
            // SAFETY: allocated by GetSecurityInfo with LocalAlloc and freed only here.
            unsafe { LocalFree(self.0) };
        }
    }

    /// The entries of an ACL.
    ///
    /// # Safety
    /// `acl` points to a valid ACL for the duration of the call.
    unsafe fn entries(acl: *const ACL) -> io::Result<Vec<Entry>> {
        const ALLOWED: u8 = 0; // ACCESS_ALLOWED_ACE_TYPE
        const DENIED: [u8; 4] = [1, 6, 10, 12]; // ACCESS_DENIED_ACE_TYPE and its object/callback variants
        let mut info = ACL_SIZE_INFORMATION::default();
        let size = size_of::<ACL_SIZE_INFORMATION>() as u32;
        // SAFETY: per the contract; `info` has the given size.
        win32(unsafe { GetAclInformation(acl, (&raw mut info).cast(), size, AclSizeInformation) })?;
        (0..info.AceCount)
            .map(|index| {
                let mut ace: *mut c_void = null_mut();
                // SAFETY: index is below the entry count; GetAce returns a pointer into the ACL.
                win32(unsafe { GetAce(acl, index, &mut ace) })?;
                // SAFETY: every entry starts with ACE_HEADER.
                let kind = unsafe { (*ace.cast::<ACE_HEADER>()).AceType };
                if DENIED.contains(&kind) {
                    return Ok(Entry { kind: EntryKind::Deny, mask: 0, sid: Vec::new() });
                }
                if kind != ALLOWED {
                    return Ok(Entry { kind: EntryKind::Unreadable, mask: 0, sid: Vec::new() });
                }
                let ace = ace.cast::<ACCESS_ALLOWED_ACE>();
                // SAFETY: a type 0 entry is an ACCESS_ALLOWED_ACE; the SID starts at `SidStart`.
                unsafe {
                    let sid = copy_sid((&raw mut (*ace).SidStart).cast())?;
                    Ok(Entry { kind: EntryKind::Allow, mask: (*ace).Mask, sid })
                }
            })
            .collect()
    }

    /// Owner and DACL of the opened object (the handle needs `READ_CONTROL`).
    pub(super) fn read_security(object: &File) -> io::Result<Security> {
        let mut owner: PSID = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let what = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
        // SAFETY: open handle; the out pointers point into `descriptor`, which is freed at the end.
        status(unsafe {
            let handle = object.as_raw_handle();
            let (owner, dacl, descriptor) = (&mut owner, &mut dacl, &mut descriptor);
            GetSecurityInfo(handle, SE_FILE_OBJECT, what, owner, null_mut(), dacl, null_mut(), descriptor)
        })?;
        let _descriptor = Descriptor(descriptor);
        // SAFETY: `owner` and `dacl` point into `descriptor`, alive until the end of the function.
        unsafe {
            let owner = copy_sid(owner)?;
            let dacl = if dacl.is_null() { None } else { Some(entries(dacl)?) };
            Ok(Security { owner, dacl })
        }
    }

    /// On-disk identity of the object (volume and index) and its number of names (hard links).
    fn file_info(file: &File) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: open handle and a structure of the expected size.
        win32(unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) })?;
        Ok(info)
    }

    fn same_object(a: &File, b: &File) -> io::Result<bool> {
        let (a, b) = (file_info(a)?, file_info(b)?);
        Ok((a.dwVolumeSerialNumber, a.nFileIndexHigh, a.nFileIndexLow)
            == (b.dwVolumeSerialNumber, b.nFileIndexHigh, b.nFileIndexLow))
    }

    /// New protected DACL (no inheritance from above): full control for the user and SYSTEM, inheritable into
    /// directories. To write it the path is opened again (not following links) and must be the same object that was
    /// checked; otherwise nothing is touched. (`ReOpenFile` cannot reopen directories.)
    pub(super) fn close_object(target: &Target) -> io::Result<()> {
        let mut user = target.user.to_vec();
        let mut system = SYSTEM.to_vec();
        let inherit = if target.is_dir { OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE } else { 0 };
        let ace_size = |sid: &[u8]| size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>() + sid.len();
        let size = size_of::<ACL>() + ace_size(&user) + ace_size(&system);
        let mut buffer = vec![0u32; size.div_ceil(4)];
        let acl = buffer.as_mut_ptr().cast::<ACL>();
        // SAFETY: buffer is 4-byte aligned with room for the header and both entries.
        unsafe {
            win32(InitializeAcl(acl, (buffer.len() * 4) as u32, ACL_REVISION))?;
            for sid in [&mut user, &mut system] {
                win32(AddAccessAllowedAceEx(acl, ACL_REVISION, inherit, FILE_ALL_ACCESS, sid.as_mut_ptr().cast()))?;
            }
        }
        let mut access = READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES;
        let mut what = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
        let mut owner: PSID = null_mut();
        if target.change_owner {
            access |= WRITE_OWNER;
            what |= OWNER_SECURITY_INFORMATION;
            owner = user.as_mut_ptr().cast();
        }
        let writable = OpenOptions::new()
            .access_mode(access)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(target.path)?;
        if !same_object(&writable, target.object)? {
            return Err(io::Error::other("the path is no longer the checked object"));
        }
        // SAFETY: open handle; `owner` (if non-null) and `acl` stay alive during the call.
        let handle = writable.as_raw_handle();
        status(unsafe { SetSecurityInfo(handle, SE_FILE_OBJECT, what, owner, null_mut(), acl, null()) })
    }

    /// Makes the opened object private (see the module docs). Returns `true` if it had to be locked down.
    fn make_private(object: &File, path: &Path, is_dir: bool, apply: Apply) -> io::Result<bool> {
        let user = current_user()?;
        let before = read_security(object)?;
        let Some(reason) = open_reason(&before, &user) else {
            return Ok(false);
        };
        if !is_dir && file_info(object)?.nNumberOfLinks != 1 {
            return Err(insecure("file open to others and with more than one name (hard link)"));
        }
        let target = Target { object, path, user: &user, change_owner: before.owner != user, is_dir };
        if let Err(error) = apply(&target) {
            log::warn!("[fsutil] could not restrict the permissions ({reason}): {error}");
            return Err(insecure(reason));
        }
        match open_reason(&read_security(object)?, &user) {
            None => Ok(true),
            Some(reason) => Err(insecure(reason)),
        }
    }

    /// Drive root, fewer than two components, or `..`: rejected before creating or touching anything.
    pub(super) fn check_path(dir: &Path) -> io::Result<()> {
        use std::path::Component;
        let absolute = std::path::absolute(dir)?;
        let components = absolute.components();
        let parent = components.clone().any(|component| component == Component::ParentDir);
        let depth = components.filter(|component| matches!(component, Component::Normal(_))).count();
        if parent || depth < 2 {
            let reason = "data folder at the root of a drive or too short";
            return Err(io::Error::new(io::ErrorKind::InvalidInput, reason));
        }
        Ok(())
    }

    /// Opens the directory or file itself (not a link target) only to read its attributes and permissions.
    pub(super) fn open_object(path: &Path) -> io::Result<File> {
        OpenOptions::new()
            .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
    }

    /// Directory levels walked inside the profile directory; anything deeper is rejected without touching more.
    pub(super) const MAX_DEPTH: usize = 32;

    /// Walks the directory's contents (`depth`: its level, 0 for the profile) and locks down only what is open. Runs
    /// on every check, so a half-finished lockdown is redone next time. Links and junctions are neither followed nor
    /// touched; entries vanishing during the walk (SQLite temp files) are skipped.
    fn close_contents(dir: &Path, apply: Apply, depth: usize) -> io::Result<()> {
        if depth >= MAX_DEPTH {
            return Err(insecure("too many folder levels inside the data folder"));
        }
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            let object = match open_object(&path) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                result => result?,
            };
            let kind = object.metadata()?.file_type();
            if kind.is_symlink() {
                continue;
            }
            make_private(&object, &path, kind.is_dir(), apply)?;
            if kind.is_dir() {
                close_contents(&path, apply, depth + 1)?;
            }
        }
        Ok(())
    }

    /// A child that cannot be entered (no right to read its permissions) counts as insecure.
    fn contents_error(error: io::Error) -> io::Error {
        if error.kind() == io::ErrorKind::PermissionDenied && !super::is_insecure(&error) {
            log::warn!("[fsutil] could not check the folder contents: {error}");
            return insecure("something inside the data folder cannot be checked");
        }
        error
    }

    pub fn ensure_dir(dir: &Path) -> io::Result<()> {
        ensure_dir_with(dir, close_object)
    }

    pub(super) fn ensure_dir_with(dir: &Path, apply: Apply) -> io::Result<()> {
        check_path(dir)?;
        std::fs::create_dir_all(dir)?;
        let meta = std::fs::symlink_metadata(dir)?;
        if meta.file_type().is_symlink() {
            return Err(insecure(LINK));
        }
        if !meta.is_dir() {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        // Everything else works on the open handle: if the path became a link meanwhile, the handle is the link.
        let object = open_object(dir)?;
        let kind = object.metadata()?.file_type();
        if kind.is_symlink() {
            return Err(insecure(LINK));
        }
        if !kind.is_dir() {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        // Directory first (anything created meanwhile already inherits), then always its contents.
        make_private(&object, dir, true, apply)?;
        close_contents(dir, apply, 0).map_err(contents_error)
    }

    pub fn open_file(path: &Path, create: bool) -> io::Result<File> {
        open_file_with(path, create, close_object)
    }

    pub(super) fn open_file_with(path: &Path, create: bool, apply: Apply) -> io::Result<File> {
        let mut options = OpenOptions::new();
        options.read(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        if create {
            options.append(true).create(true);
        }
        // A junction is a directory and cannot be opened as a file (access denied); report it as what it is.
        let file = options.open(path).map_err(|error| {
            let is_link = std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink());
            if is_link { insecure(LINK) } else { error }
        })?;
        // Check the opened object, not the path: if it is a link, the handle is the link and it is rejected.
        let kind = file.metadata()?.file_type();
        if kind.is_symlink() {
            return Err(insecure(LINK));
        }
        if !kind.is_file() {
            return Err(insecure("not a regular file"));
        }
        make_private(&file, path, false, apply)?;
        Ok(file)
    }
}

#[cfg(not(any(unix, windows)))]
mod imp {
    use super::{Path, io};
    use std::fs::{File, OpenOptions};

    pub fn ensure_dir(dir: &Path) -> io::Result<()> {
        std::fs::create_dir_all(dir)
    }

    pub fn open_file(path: &Path, create: bool) -> io::Result<File> {
        let mut options = OpenOptions::new();
        options.read(true);
        if create {
            options.append(true).create(true);
        }
        options.open(path)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    fn chmod(p: &Path, m: u32) {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
    }

    #[test]
    fn creates_dir_0700_and_file_0600() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("a").join("b");
        ensure_private_dir(&dir).unwrap();
        let file = dir.join("f");
        ensure_private_file(&file).unwrap();
        assert_eq!((mode(&dir), mode(&file)), (0o700, 0o600));
    }

    #[test]
    fn existing_readable_dir_is_forced_to_0700() {
        let tmp = tempfile::TempDir::new().unwrap();
        chmod(tmp.path(), 0o755);
        ensure_private_dir(tmp.path()).unwrap();
        assert_eq!(mode(tmp.path()), 0o700);
    }

    #[test]
    fn dir_writable_by_group_or_others_is_rejected() {
        for bad in [0o770, 0o707, 0o777] {
            let tmp = tempfile::TempDir::new().unwrap();
            chmod(tmp.path(), bad);
            let err = ensure_private_dir(tmp.path()).unwrap_err();
            assert!(is_insecure(&err), "{bad:o}");
            assert_eq!(mode(tmp.path()), bad, "not silently fixed");
        }
    }

    #[test]
    fn dir_that_is_a_file_is_rejected() {
        let tmp = tempfile::TempDir::new().unwrap();
        let file = tmp.path().join("f");
        std::fs::write(&file, b"x").unwrap();
        assert!(ensure_private_dir(&file).is_err());
    }

    #[test]
    fn open_file_is_an_insecure_permissions_error_and_is_not_silently_fixed() {
        let tmp = tempfile::TempDir::new().unwrap();
        let file = tmp.path().join("f");
        std::fs::write(&file, b"x").unwrap();
        for bad in [0o644, 0o640, 0o604, 0o660] {
            chmod(&file, bad);
            for result in [ensure_private_file(&file), check_private_file(&file)] {
                let err = result.unwrap_err();
                assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
                assert!(is_insecure(&err));
            }
            assert_eq!(mode(&file), bad);
        }
    }

    #[test]
    fn symlink_is_rejected_by_both_checks() {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("t");
        std::fs::write(&target, b"x").unwrap();
        chmod(&target, 0o600);
        let link = tmp.path().join("l");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        for result in [ensure_private_file(&link), check_private_file(&link)] {
            let err = result.unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
            assert!(is_insecure(&err));
        }
    }

    #[test]
    fn fifo_is_rejected_without_blocking() {
        let tmp = tempfile::TempDir::new().unwrap();
        let fifo = tmp.path().join("fifo");
        let c_path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        assert!(is_insecure(&check_private_file(&fifo).unwrap_err()));
    }

    #[test]
    fn existing_private_file_is_kept_and_check_does_not_create() {
        let tmp = tempfile::TempDir::new().unwrap();
        let file = tmp.path().join("f");
        assert_eq!(check_private_file(&file).unwrap_err().kind(), io::ErrorKind::NotFound);
        assert!(!file.exists());
        ensure_private_file(&file).unwrap();
        ensure_private_file(&file).unwrap();
        check_private_file(&file).unwrap();
    }

    #[test]
    fn open_private_file_reads_the_checked_file() {
        use std::io::Read;
        let tmp = tempfile::TempDir::new().unwrap();
        let file = tmp.path().join("f");
        assert_eq!(open_private_file(&file).unwrap_err().kind(), io::ErrorKind::NotFound);
        ensure_private_file(&file).unwrap();
        std::fs::write(&file, b"hola").unwrap();
        let mut text = String::new();
        open_private_file(&file).unwrap().read_to_string(&mut text).unwrap();
        assert_eq!(text, "hola");
        chmod(&file, 0o640);
        assert!(is_insecure(&open_private_file(&file).unwrap_err()));
    }

    #[test]
    fn owner_is_the_effective_user() {
        use std::os::unix::fs::MetadataExt;
        let tmp = tempfile::TempDir::new().unwrap();
        assert_eq!(std::fs::metadata(tmp.path()).unwrap().uid(), imp::process_uid());
    }

    #[test]
    fn insecure_permissions_message_is_clear() {
        let text = InsecurePermissions("file more open than 0600").to_string();
        assert!(text.starts_with("insecure permissions"));
    }
}

#[cfg(all(test, windows))]
mod tests_windows {
    use super::*;

    /// A junction (`mklink /J`): needs neither administrator rights nor developer mode.
    fn junction(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "mklink /J");
    }

    fn assert_insecure(result: io::Result<()>) {
        let err = result.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(is_insecure(&err), "{err}");
    }

    #[test]
    fn plain_dir_and_file_are_accepted() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("a").join("b");
        ensure_private_dir(&dir).unwrap();
        ensure_private_dir(&dir).unwrap();
        let file = dir.join("f");
        assert_eq!(check_private_file(&file).unwrap_err().kind(), io::ErrorKind::NotFound);
        assert!(!file.exists());
        ensure_private_file(&file).unwrap();
        ensure_private_file(&file).unwrap();
        check_private_file(&file).unwrap();
        open_private_file(&file).unwrap();
    }

    #[test]
    fn junction_as_profile_dir_is_rejected() {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("destino");
        std::fs::create_dir(&target).unwrap();
        let link = tmp.path().join("perfil");
        junction(&link, &target);
        assert_insecure(ensure_private_dir(&link));
    }

    #[test]
    fn junction_in_place_of_a_file_is_rejected() {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("destino");
        std::fs::create_dir(&target).unwrap();
        let link = tmp.path().join("f");
        junction(&link, &target);
        for result in [ensure_private_file(&link), check_private_file(&link), open_private_file(&link).map(drop)] {
            assert_insecure(result);
        }
    }

    #[test]
    fn dir_that_is_a_file_is_rejected() {
        let tmp = tempfile::TempDir::new().unwrap();
        let file = tmp.path().join("f");
        std::fs::write(&file, b"x").unwrap();
        assert!(ensure_private_dir(&file).is_err());
    }

    /// Creating a symlink on Windows needs developer mode or administrator rights; without them the test cannot set
    /// up the case and says so instead of failing.
    #[test]
    fn file_symlink_is_rejected_when_it_can_be_created() {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("t");
        std::fs::write(&target, b"x").unwrap();
        let link = tmp.path().join("l");
        if let Err(err) = std::os::windows::fs::symlink_file(&target, &link) {
            eprintln!("no permission to create symbolic links ({err}): case not tested");
            return;
        }
        for result in [ensure_private_file(&link), check_private_file(&link)] {
            assert_insecure(result);
        }
        let dir_link = tmp.path().join("dl");
        std::os::windows::fs::symlink_dir(tmp.path(), &dir_link).unwrap();
        assert_insecure(ensure_private_dir(&dir_link));
    }

    // ---- Permissions (DACL). Everything in our own temp directories (`tempfile`, under `std::env::temp_dir`). ----

    use imp::{ADMINISTRATORS, Entry, EntryKind, SYSTEM, Security, open_reason};

    /// S-1-5-21-1-2-3-1001: a test user.
    const USER: &[u8] = &[1, 5, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0xE9, 3, 0, 0];
    /// S-1-5-21-1-2-3-1002: another user.
    const OTHER: &[u8] = &[1, 5, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0xEA, 3, 0, 0];
    const EVERYONE: &[u8] = &[1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
    const USERS: &[u8] = &[1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x21, 0x02, 0, 0];
    const AUTHENTICATED: &[u8] = &[1, 1, 0, 0, 0, 0, 0, 5, 11, 0, 0, 0];
    const CREATOR_OWNER: &[u8] = &[1, 1, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0];
    const FULL: u32 = 0x001F_01FF;
    const READ: u32 = 0x0012_0089;
    const SYNCHRONIZE: u32 = 0x0010_0000;

    fn allow(sid: &[u8], mask: u32) -> Entry {
        Entry { kind: EntryKind::Allow, mask, sid: sid.to_vec() }
    }

    fn security(owner: &[u8], dacl: Vec<Entry>) -> Security {
        Security { owner: owner.to_vec(), dacl: Some(dacl) }
    }

    #[test]
    fn classification_accepts_user_system_and_administrators_only() {
        let private = security(USER, vec![allow(USER, FULL), allow(SYSTEM, FULL), allow(ADMINISTRATORS, FULL)]);
        assert_eq!(open_reason(&private, USER), None);
        assert_eq!(open_reason(&security(USER, vec![]), USER), None, "empty list: nobody else gets in");
        assert_eq!(open_reason(&security(ADMINISTRATORS, vec![allow(USER, FULL)]), USER), None);
        assert_eq!(open_reason(&security(USER, vec![allow(CREATOR_OWNER, FULL)]), USER), None);
        for sid in [EVERYONE, USERS, AUTHENTICATED, OTHER] {
            let open = security(USER, vec![allow(USER, FULL), allow(sid, READ)]);
            assert!(open_reason(&open, USER).is_some(), "{sid:?}");
        }
        assert!(open_reason(&security(OTHER, vec![allow(USER, FULL)]), USER).is_some(), "foreign owner");
        let null = Security { owner: USER.to_vec(), dacl: None };
        assert!(open_reason(&null, USER).is_some(), "null list: access for everyone");
        let odd = Entry { kind: EntryKind::Unreadable, mask: 0, sid: Vec::new() };
        assert!(open_reason(&security(USER, vec![odd]), USER).is_some());
    }

    #[test]
    fn classification_ignores_denied_entries_and_bare_synchronize() {
        let deny = Entry { kind: EntryKind::Deny, mask: FULL, sid: EVERYONE.to_vec() };
        assert_eq!(open_reason(&security(USER, vec![deny, allow(USER, FULL)]), USER), None);
        assert_eq!(open_reason(&security(USER, vec![allow(EVERYONE, SYNCHRONIZE)]), USER), None);
        assert_eq!(open_reason(&security(USER, vec![allow(EVERYONE, 0)]), USER), None);
    }

    fn icacls(args: &[&str]) -> String {
        let out = std::process::Command::new("icacls").args(args).output().unwrap();
        assert!(out.status.success(), "icacls {args:?}: {}", String::from_utf8_lossy(&out.stdout));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// Opens to Authenticated Users (read; on directories, inheritable and applied to existing contents).
    fn open_to_authenticated(path: &Path) {
        let grant = if path.is_dir() { "*S-1-5-11:(OI)(CI)(R)" } else { "*S-1-5-11:(R)" };
        let path = path.to_str().unwrap();
        icacls(&[path, "/grant", grant, "/T", "/Q"]);
    }

    fn acl_text(path: &Path) -> String {
        icacls(&[path.to_str().unwrap()])
    }

    fn is_private(path: &Path) -> bool {
        let object = imp::open_object(path).unwrap();
        open_reason(&imp::read_security(&object).unwrap(), &imp::current_user().unwrap()).is_none()
    }

    fn refuse(_: &imp::Target) -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    }

    fn do_nothing(_: &imp::Target) -> io::Result<()> {
        Ok(())
    }

    fn must_not_run(_: &imp::Target) -> io::Result<()> {
        panic!("already private: must not be touched")
    }

    #[test]
    fn already_private_dir_is_accepted_untouched() {
        // The temp directory inherits user, SYSTEM and Administrators (like a manually locked-down profile).
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("perfil");
        imp::ensure_dir_with(&dir, must_not_run).unwrap();
        let before = acl_text(&dir);
        imp::ensure_dir_with(&dir, must_not_run).unwrap();
        assert_eq!(acl_text(&dir), before);
    }

    #[test]
    fn open_dir_is_closed_and_new_contents_inherit() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("perfil");
        std::fs::create_dir(&dir).unwrap();
        open_to_authenticated(&dir);
        assert!(!is_private(&dir));
        ensure_private_dir(&dir).unwrap();
        assert!(is_private(&dir));
        assert!(!acl_text(&dir).contains("(I)"), "no inheritance from above");
        // Idempotent: the second run touches nothing.
        imp::ensure_dir_with(&dir, must_not_run).unwrap();
        let file = dir.join("f");
        ensure_private_file(&file).unwrap();
        let child = dir.join("networks").join("x");
        imp::ensure_dir_with(&child, must_not_run).unwrap();
        assert!(is_private(&file) && is_private(&child) && is_private(&dir.join("networks")));
    }

    #[test]
    fn existing_contents_of_an_open_dir_are_closed_too() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("perfil");
        let sub = dir.join("networks");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(dir.join("seed.v1"), b"x").unwrap();
        std::fs::write(sub.join("mail.db"), b"x").unwrap();
        open_to_authenticated(&dir);
        for path in [&dir, &sub, &dir.join("seed.v1"), &sub.join("mail.db")] {
            assert!(!is_private(path), "{}", path.display());
        }
        ensure_private_dir(&dir).unwrap();
        for path in [&dir, &sub, &dir.join("seed.v1"), &sub.join("mail.db")] {
            assert!(is_private(path), "{}", path.display());
        }
    }

    #[test]
    fn junction_inside_an_open_dir_is_not_followed() {
        let tmp = tempfile::TempDir::new().unwrap();
        let outside = tmp.path().join("fuera");
        let dir = tmp.path().join("perfil");
        std::fs::create_dir(&outside).unwrap();
        std::fs::create_dir(&dir).unwrap();
        open_to_authenticated(&outside);
        open_to_authenticated(&dir);
        junction(&dir.join("enlace"), &outside);
        let before = acl_text(&outside);
        ensure_private_dir(&dir).unwrap();
        assert!(is_private(&dir));
        assert_eq!(acl_text(&outside), before, "what is outside is not touched");
    }

    #[test]
    fn dir_that_cannot_be_closed_is_refused() {
        for apply in [refuse as imp::Apply, do_nothing] {
            let tmp = tempfile::TempDir::new().unwrap();
            let dir = tmp.path().join("perfil");
            std::fs::create_dir(&dir).unwrap();
            open_to_authenticated(&dir);
            let before = acl_text(&dir);
            assert_insecure(imp::ensure_dir_with(&dir, apply));
            assert_eq!(acl_text(&dir), before);
        }
    }

    #[test]
    fn open_file_is_closed_or_refused() {
        let tmp = tempfile::TempDir::new().unwrap();
        let file = tmp.path().join("seed.v1");
        std::fs::write(&file, b"x").unwrap();
        open_to_authenticated(&file);
        let before = acl_text(&file);
        assert_insecure(imp::open_file_with(&file, false, refuse).map(drop));
        assert_eq!(acl_text(&file), before);
        check_private_file(&file).unwrap();
        assert!(is_private(&file));
        imp::open_file_with(&file, false, must_not_run).unwrap();
    }

    #[test]
    fn open_file_with_two_names_is_refused_untouched() {
        let tmp = tempfile::TempDir::new().unwrap();
        let file = tmp.path().join("f");
        std::fs::write(&file, b"x").unwrap();
        std::fs::hard_link(&file, tmp.path().join("g")).unwrap();
        open_to_authenticated(&file);
        let before = acl_text(&file);
        assert_insecure(check_private_file(&file));
        assert_eq!(acl_text(&file), before);
    }

    /// Nothing outside %TEMP% is created or changed: the root goes through the injectable variant with `must_not_run`
    /// (if the check broke, the test fails before touching permissions) and short paths only through `check_path`.
    #[test]
    fn drive_root_and_short_paths_are_refused_without_touching_anything() {
        let temp = std::env::temp_dir();
        let root = temp.ancestors().last().unwrap().to_path_buf();
        let err = imp::ensure_dir_with(&root, must_not_run).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        let short = root.join(format!("nightmail-prueba-{}", std::process::id()));
        for path in [&root, &short] {
            let err = imp::check_path(path).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{}", path.display());
        }
        imp::check_path(&temp.join("nightmail-prueba")).unwrap();
    }

    /// A file with two names, the second outside the directory.
    fn file_with_outside_name(dir: &Path, outside: &Path) -> std::path::PathBuf {
        let file = dir.join("z-seed.v1");
        std::fs::write(&file, b"x").unwrap();
        std::fs::hard_link(&file, outside).unwrap();
        file
    }

    #[test]
    fn half_done_close_is_an_error_and_the_next_check_finishes_it() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("perfil");
        let sub = dir.join("networks");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("mail.db"), b"x").unwrap();
        let outside = tmp.path().join("fuera");
        let file = file_with_outside_name(&dir, &outside);
        // Explicit (non-inherited) entry on the file: locking down the directory only rewrites inherited entries.
        open_to_authenticated(&dir);
        open_to_authenticated(&file);
        assert_insecure(ensure_private_dir(&dir));
        assert!(!is_private(&file), "with two names it is not restricted");
        std::fs::remove_file(&outside).unwrap();
        ensure_private_dir(&dir).unwrap();
        for path in [&dir, &sub, &sub.join("mail.db"), &file] {
            assert!(is_private(path), "{}", path.display());
        }
    }

    #[test]
    fn open_child_of_an_already_private_dir_is_closed() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("perfil");
        ensure_private_dir(&dir).unwrap();
        let file = dir.join("networks").join("wallet.state");
        std::fs::create_dir(dir.join("networks")).unwrap();
        std::fs::write(&file, b"x").unwrap();
        open_to_authenticated(&file);
        assert!(is_private(&dir) && !is_private(&file));
        ensure_private_dir(&dir).unwrap();
        assert!(is_private(&file));
    }

    #[test]
    fn too_deep_contents_are_refused_without_touching_more() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("p");
        let mut deepest = dir.clone();
        for _ in 0..imp::MAX_DEPTH - 1 {
            deepest.push("d");
        }
        std::fs::create_dir_all(&deepest).unwrap();
        imp::ensure_dir_with(&dir, must_not_run).unwrap();
        let too_deep = deepest.join("d");
        std::fs::create_dir(&too_deep).unwrap();
        std::fs::write(too_deep.join("f"), b"x").unwrap();
        open_to_authenticated(&too_deep.join("f"));
        assert_insecure(imp::ensure_dir_with(&dir, must_not_run));
        assert!(!is_private(&too_deep.join("f")), "what is further down is not touched");
    }
}
