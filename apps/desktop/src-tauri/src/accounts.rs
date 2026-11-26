//! Several accounts in one installation (debug builds, where the profile folder is known).
//!
//! One folder is one account: `seed.v1`, `attempts.v1`, `instance.lock` and `networks/<network>/<contract>/` (mail
//! database and wallet). The profile folder itself is account 1, exactly as before: nothing is moved or migrated.
//! Further accounts live in `<profile>/accounts/<id>/`, where `<id>` is 32 lowercase hex characters generated here.
//!
//! `<profile>/current-account` names the account opened at startup. Missing, unreadable, malformed or pointing at a
//! folder that does not exist: account 1. The folder is fixed for the whole run; switching writes this file and
//! restarts the app.
//!
//! Ids coming from the UI are only accepted with that exact shape (or `main`), so no path is ever taken from the UI
//! and `..`, `/` or `\` cannot reach the file system. Only accounts with a `seed.v1` are listed: a folder prepared for
//! a new account that was then abandoned stays hidden, and if it holds nothing but `instance.lock` it is removed at
//! the next startup.
//!
//! An account may have a name, chosen when creating or restoring it or later in Settings: `account-name` in its folder
//! (for account 1, the profile folder). It is stored without encryption, because the list shows it before unlocking. It
//! is only ever read as text and cleaned again on reading (see [`clean_name`]): it never becomes part of a path.
//!
//! Without a name the UI shows the automatic one, "Perfil N" or "Profile N" in the language of the moment. Its number is
//! fixed the first time the account is named (also when left empty): `account-number` keeps it, so it does not change
//! when other accounts are removed. Before that file existed the UI saved the automatic name as text in `account-name`;
//! a name that is exactly `Perfil <n>` or `Profile <n>` is therefore read as the automatic one with that number, whoever
//! wrote it (see [`auto_number_in`]). Neither file (account 1 from before names existed, or saving failed): the number
//! is [`AccountView::number`], the place in the list, and for accounts other than 1 it is fixed at the next startup.
//!
//! The window size and position survive the restart through `<profile>/window-state`, written just before
//! restarting and read (and removed) at startup.
//!
//! Deleting an account (see [`Accounts::prepare_delete`] and [`Accounts::delete`]) removes only that account's files on
//! this device, by validated id, never by a path or a name from the UI. An account under `accounts/` loses its whole
//! folder; account 1 only what is its own in the profile folder ([`MAIN_OWNED`]), never `accounts/`, `current-account`
//! or anything unknown. Links are never followed: `accounts/` and the account's folder must be real folders, and a link
//! inside is removed as a link. The account's lock is held throughout (taken here, or the one this process holds as its
//! open account), so an account open in another window is not touched. The seed goes last but one: if anything fails
//! before, the account is still listed, opens with the same password and the deletion can be repeated.

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use ts_rs::TS;

use crate::crypto::random_bytes;
use crate::fsutil;
use crate::instance::{LOCK_FILE_NAME, LockError, ProfileLock};
use crate::keys::{self, ATTEMPTS_FILE_NAME, KeyError, SEED_FILE_NAME};

/// Folder, inside the profile, that holds the accounts after the first.
pub const ACCOUNTS_DIR: &str = "accounts";
/// File, inside the profile, naming the account to open at startup.
pub const CURRENT_FILE: &str = "current-account";
/// File, inside the profile, with the window size and position to restore after a restart.
pub const WINDOW_FILE: &str = "window-state";
/// File, inside an account's folder, with the name chosen for it.
pub const NAME_FILE: &str = "account-name";
/// File, inside an account's folder, with the number of its automatic name ("Perfil 4"), fixed once written.
pub const NUMBER_FILE: &str = "account-number";
/// Longest name, in characters (Unicode scalar values) after cleaning.
pub const MAX_NAME_CHARS: usize = 40;
/// Longer input is refused before looking at it (40 characters of 4 bytes each, with room for spaces to trim).
const MAX_NAME_INPUT_BYTES: usize = 1024;
/// Id of account 1 (the profile folder itself).
pub const MAIN_ID: &str = "main";
/// Random bytes in a new account id (32 hex characters).
const ID_BYTES: usize = 16;
/// Small files here are a few dozen bytes (a name, at most 160): anything longer is not read in full.
const MAX_SMALL_FILE: u64 = 256;
/// Folder, inside an account's folder, with the mail database and the wallet of each network (`AppConfig::scope_dir`).
pub const NETWORKS_DIR: &str = "networks";
/// File, inside the profile, asking the next startup to show the profile list first: written before restarting after
/// deleting the open account, read and removed at startup.
pub const SHOW_ACCOUNTS_FILE: &str = "show-accounts";
/// What belongs to account 1 in the profile folder (plus the temp files of those files, and its `instance.lock`, which
/// stays). Everything else there (`accounts/`, `current-account`, `window-state`, anything unknown) is left alone.
pub const MAIN_OWNED: &[&str] = &[SEED_FILE_NAME, ATTEMPTS_FILE_NAME, NAME_FILE, NUMBER_FILE, NETWORKS_DIR];

/// An account: the profile folder itself or one under `accounts/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountId {
    Main,
    Extra(String),
}

impl AccountId {
    /// Accepts `main` or exactly 32 lowercase hex characters, nothing else.
    pub fn parse(text: &str) -> Option<Self> {
        if text == MAIN_ID {
            return Some(AccountId::Main);
        }
        let hex = text.len() == ID_BYTES * 2 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        hex.then(|| AccountId::Extra(text.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        match self {
            AccountId::Main => MAIN_ID,
            AccountId::Extra(id) => id,
        }
    }

    fn generate() -> Self {
        AccountId::Extra(hex::encode(random_bytes::<ID_BYTES>()))
    }
}

/// An account as the UI sees it: no address, only the name chosen for it (if any), its number, when it was created and
/// whether it is the one this window has open.
#[derive(Serialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct AccountView {
    pub id: String,
    /// The name written by the user, already cleaned. `None`: the UI shows the automatic name with [`Self::auto_number`],
    /// in the language of the moment.
    pub name: Option<String>,
    /// The place in the list: account 1 is the profile folder, the rest by creation order.
    pub number: u32,
    /// The number of the automatic name ("Perfil 4"): the one fixed for this account, or else [`Self::number`].
    pub auto_number: u32,
    /// Creation time in Unix seconds (the account folder's), if the file system knows it.
    #[ts(type = "number | null")]
    pub created_at: Option<i64>,
    /// The account this window opened at startup.
    pub current: bool,
}

/// The accounts of a profile folder and the one opened at startup.
#[derive(Debug, Clone)]
pub struct Accounts {
    root: PathBuf,
    current: AccountId,
}

impl Accounts {
    /// At startup: the account named in `current-account` (account 1 if that fails), after removing abandoned folders
    /// of other accounts that hold nothing but their lock file.
    pub fn at_startup(root: PathBuf) -> Self {
        let current = read_current(&root);
        remove_abandoned(&root, &current);
        let accounts = Accounts { root, current };
        accounts.fix_missing_numbers();
        accounts
    }

    /// Writes `account-number` for the accounts that have no automatic number fixed yet (created before that file
    /// existed, or whose naming failed), with their place in the list now, so removing an earlier account later does
    /// not change it. Account 1 is always 1 and is left alone. Best effort: errors are ignored.
    fn fix_missing_numbers(&self) {
        let Ok(list) = self.list() else { return };
        for view in list {
            let Some(id) = AccountId::parse(&view.id).filter(|id| *id != AccountId::Main) else { continue };
            let dir = self.dir(&id);
            let fixed = read_number(&dir).is_some() || read_name(&dir).as_deref().and_then(auto_number_in).is_some();
            if !fixed {
                let _ = write_small_file(&dir, NUMBER_FILE, view.auto_number.to_string().as_bytes());
            }
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn current(&self) -> &AccountId {
        &self.current
    }

    /// The folder of an account (never taken from the UI: ids are validated by [`AccountId::parse`]).
    pub fn dir(&self, id: &AccountId) -> PathBuf {
        match id {
            AccountId::Main => self.root.clone(),
            AccountId::Extra(id) => self.root.join(ACCOUNTS_DIR).join(id),
        }
    }

    pub fn current_dir(&self) -> PathBuf {
        self.dir(&self.current)
    }

    pub fn has_seed(&self, id: &AccountId) -> bool {
        has_seed(&self.dir(id))
    }

    /// The accounts with a seed: account 1 first, then the others by creation time.
    pub fn list(&self) -> io::Result<Vec<AccountView>> {
        let mut extras: Vec<(Option<i64>, String)> = Vec::new();
        for (id, dir) in extra_dirs(&self.root)? {
            if has_seed(&dir) {
                extras.push((created_at(&dir), id));
            }
        }
        // Unknown creation times go last; equal ones by id, so the order never changes between calls.
        extras.sort_by(|a, b| (a.0.is_none(), a.0, &a.1).cmp(&(b.0.is_none(), b.0, &b.1)));
        let mut list = Vec::with_capacity(extras.len() + 1);
        if has_seed(&self.root) {
            list.push(self.view(AccountId::Main, 1, created_at(&self.root)));
        }
        for (number, (created, id)) in (2u32..).zip(extras) {
            list.push(self.view(AccountId::Extra(id), number, created));
        }
        Ok(list)
    }

    fn view(&self, id: AccountId, number: u32, created_at: Option<i64>) -> AccountView {
        let current = id == self.current;
        let dir = self.dir(&id);
        let fixed = || read_number(&dir).unwrap_or(number);
        let (name, auto_number) = match read_name(&dir) {
            Some(name) => match auto_number_in(&name) {
                Some(n) => (None, n),
                None => (Some(name), fixed()),
            },
            None => (None, fixed()),
        };
        AccountView { id: id.as_str().to_owned(), name, number, auto_number, created_at, current }
    }

    /// Names an account that already has a seed (so a folder abandoned before that keeps holding only its lock) and
    /// returns it as listed now. Its automatic number is fixed first (`account-number`). An empty name (after
    /// [`clean_name`]) removes `account-name`: the automatic name applies again, with that same number. A name that
    /// is the automatic one ("Perfil 7" or "Profile 7") is saved as the automatic name with that number. Too long:
    /// `InvalidInput`, and nothing changes.
    pub fn set_name(&self, id: &AccountId, name: &str) -> io::Result<AccountView> {
        if !self.has_seed(id) {
            return Err(io::Error::from(io::ErrorKind::NotFound));
        }
        let clean = clean_name(name)?;
        let view = self.list()?.into_iter().find(|a| a.id == id.as_str()).ok_or(io::ErrorKind::NotFound)?;
        let typed_number = clean.as_deref().and_then(auto_number_in);
        let custom = clean.filter(|_| typed_number.is_none());
        let auto_number = typed_number.unwrap_or(view.auto_number);
        let dir = self.dir(id);
        write_small_file(&dir, NUMBER_FILE, auto_number.to_string().as_bytes())?;
        match &custom {
            Some(name) => write_small_file(&dir, NAME_FILE, name.as_bytes())?,
            None => match fs::remove_file(dir.join(NAME_FILE)) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                _ => {}
            },
        }
        Ok(AccountView { name: custom, auto_number, ..view })
    }

    /// Makes `id` the account opened at the next startup. Only a listed account (one with a seed) can be chosen.
    pub fn choose(&self, id: &AccountId) -> io::Result<()> {
        if !self.list()?.iter().any(|a| a.id == id.as_str()) {
            return Err(io::Error::from(io::ErrorKind::NotFound));
        }
        write_small_file(&self.root, CURRENT_FILE, id.as_str().as_bytes())
    }

    /// Prepares an empty, private folder for a new account and makes it the one opened at the next startup.
    pub fn create(&self) -> io::Result<AccountId> {
        let id = AccountId::generate();
        let dir = self.dir(&id);
        if dir.symlink_metadata().is_ok() {
            return Err(io::Error::from(io::ErrorKind::AlreadyExists));
        }
        fsutil::ensure_private_dir(&dir)?;
        write_small_file(&self.root, CURRENT_FILE, id.as_str().as_bytes())?;
        Ok(id)
    }

    // ---------- Deleting an account ----------

    /// First step of deleting `id`: checks it is a listed account in a real folder and holds its lock until
    /// [`Self::delete`]. `lock_held`: this process already holds it (its open account). Another window holding it:
    /// `InUse`, and nothing is touched.
    pub fn prepare_delete(&self, id: &AccountId, lock_held: bool) -> Result<Deletion, DeleteError> {
        let dir = self.dir(id);
        if let AccountId::Extra(_) = id {
            // Neither `accounts/` nor the account's folder may be a link (or a junction): what is removed must be
            // inside the profile folder.
            if !is_real_dir(&self.root.join(ACCOUNTS_DIR)) || !is_real_dir(&dir) {
                return Err(DeleteError::NotFound);
            }
        }
        if !has_seed(&dir) {
            return Err(DeleteError::NotFound);
        }
        let lock = if lock_held {
            None
        } else {
            Some(ProfileLock::acquire(&dir).map_err(|e| match e {
                LockError::InUse => DeleteError::InUse,
                LockError::Io(e) => DeleteError::Io(e),
            })?)
        };
        Ok(Deletion { id: id.clone(), dir, _lock: lock })
    }

    /// Removes the account's files (see the module docs), the seed last but one and then its failed attempts. Account
    /// 1 keeps its `instance.lock` in the profile folder. Another account's folder is removed too. If this process still
    /// holds its lock (its open account, until the restart) and the system refuses to remove an open file (Windows), the
    /// folder stays with that file only and the next startup removes it as abandoned. If `current-account` named it,
    /// account 1 opens next.
    pub fn delete(&self, deletion: Deletion) -> io::Result<()> {
        let Deletion { id, dir, _lock: lock } = deletion;
        let main = id == AccountId::Main;
        // Checked again: the password check took seconds, and meanwhile a folder could have been swapped for a link.
        if !main && (!is_real_dir(&self.root.join(ACCOUNTS_DIR)) || !is_real_dir(&dir)) {
            return Err(io::Error::from(io::ErrorKind::NotFound));
        }
        let mut failed = None;
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                // Not ours under account 1; under another account, removed like the rest.
                if !main && let Err(e) = remove_entry(&entry.path()) {
                    failed.get_or_insert(e);
                }
                continue;
            };
            let keep_for_now = [SEED_FILE_NAME, ATTEMPTS_FILE_NAME, LOCK_FILE_NAME].contains(&name);
            if keep_for_now || (main && !main_owned(name)) {
                continue;
            }
            if let Err(e) = remove_entry(&entry.path()) {
                failed.get_or_insert(e);
            }
        }
        // Something stayed: the seed too, so the account is still there and the deletion can be repeated.
        if let Some(e) = failed {
            return Err(e);
        }
        remove_file_if_present(&dir.join(SEED_FILE_NAME))?;
        keys::forget_attempts(&dir);
        if self.current_file_names(&id) {
            let _ = fs::remove_file(self.root.join(CURRENT_FILE));
        }
        if main {
            return Ok(());
        }
        // Without the seed the account is no longer listed: what follows is tidying up.
        drop(lock);
        let _ = fs::remove_file(dir.join(LOCK_FILE_NAME));
        let _ = fs::remove_dir(&dir);
        log::info!("[accounts] deleted an account");
        Ok(())
    }

    /// After deleting the open account: the account to open on restarting. The first listed one that no other window
    /// has open (or, if all are, the first one), and the profile list is shown first. With none left, account 1 (no
    /// seed: the welcome screen). Returns whether any account is left.
    pub fn choose_after_delete(&self) -> io::Result<bool> {
        let list = self.list()?;
        let free = list.iter().find(|a| {
            AccountId::parse(&a.id).is_some_and(|id| ProfileLock::acquire(&self.dir(&id)).is_ok())
        });
        let Some(next) = free.or(list.first()) else {
            write_small_file(&self.root, CURRENT_FILE, MAIN_ID.as_bytes())?;
            return Ok(false);
        };
        write_small_file(&self.root, CURRENT_FILE, next.id.as_bytes())?;
        write_small_file(&self.root, SHOW_ACCOUNTS_FILE, b"1")?;
        Ok(true)
    }

    /// Whether `current-account` names `id`.
    fn current_file_names(&self, id: &AccountId) -> bool {
        read_small_file(&self.root.join(CURRENT_FILE)).is_some_and(|text| text.trim() == id.as_str())
    }
}

/// An account being deleted: its folder checked and its lock held (see [`Accounts::prepare_delete`]).
#[derive(Debug)]
pub struct Deletion {
    id: AccountId,
    dir: PathBuf,
    _lock: Option<ProfileLock>,
}

impl Deletion {
    /// The account's folder (for checking its password).
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

/// Why an account cannot be deleted.
#[derive(Debug)]
pub enum DeleteError {
    /// Another window has it open.
    InUse,
    /// Not a listed account, or its folder is not a real folder inside the profile folder.
    NotFound,
    /// The password check failed (wrong password, a wait pending...).
    Key(KeyError),
    Io(io::Error),
}

/// Whether `path` is a folder itself, not a link or a junction to one.
fn is_real_dir(path: &Path) -> bool {
    path.symlink_metadata().is_ok_and(|m| m.file_type().is_dir())
}

/// Whether `name`, in the profile folder, belongs to account 1: [`MAIN_OWNED`] and the temp files of its files.
fn main_owned(name: &str) -> bool {
    MAIN_OWNED.contains(&name)
        || ([SEED_FILE_NAME, ATTEMPTS_FILE_NAME, NAME_FILE, NUMBER_FILE].iter().any(|base| name.starts_with(&format!("{base}.")))
            && name.ends_with(".tmp"))
}

/// Removes a file, a folder with its contents or a link, never following links (`remove_dir_all` removes a link
/// itself, not what it points to). A link to a folder on Windows (or a junction) is removed with `remove_dir`.
fn remove_entry(path: &Path) -> io::Result<()> {
    let kind = path.symlink_metadata()?.file_type();
    if kind.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path).or_else(|e| if kind.is_symlink() { fs::remove_dir(path) } else { Err(e) })
    }
}

fn remove_file_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Whether the previous run asked to show the profile list first (see [`SHOW_ACCOUNTS_FILE`]). The file is removed: it
/// only applies once.
pub fn take_show_accounts(root: &Path) -> bool {
    let path = root.join(SHOW_ACCOUNTS_FILE);
    let found = path.symlink_metadata().is_ok_and(|m| m.is_file());
    let _ = fs::remove_file(&path);
    found
}

/// Characters that show nothing or reorder the text around them (zero-width ones, direction marks and overrides, the
/// soft hyphen, the byte order mark): a name could otherwise look like another one or be invisible.
fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}'
            | '\u{FEFF}'
    )
}

/// A name as it is stored and shown: invisible characters removed, control characters and any run of spaces, tabs or
/// line breaks turned into a single space, and the ends trimmed. `None` if nothing is left (the default name applies).
/// More than [`MAX_NAME_CHARS`] characters: `InvalidInput` (never cut silently).
pub fn clean_name(text: &str) -> io::Result<Option<String>> {
    let too_long = || io::Error::from(io::ErrorKind::InvalidInput);
    if text.len() > MAX_NAME_INPUT_BYTES {
        return Err(too_long());
    }
    let spaced: String =
        text.chars().filter(|&c| !is_invisible(c)).map(|c| if c.is_control() { ' ' } else { c }).collect();
    let name = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(too_long());
    }
    Ok((!name.is_empty()).then_some(name))
}

/// The name saved in an account's folder, cleaned again (the file may have been edited by hand). Missing, not a plain
/// file, not UTF-8, too long or empty: `None`.
fn read_name(dir: &Path) -> Option<String> {
    let path = dir.join(NAME_FILE);
    if !path.symlink_metadata().is_ok_and(|m| m.is_file()) {
        return None;
    }
    clean_name(&read_small_file(&path)?).ok().flatten()
}

/// A positive number written plainly: digits only, no sign and no leading zero.
fn parse_number(digits: &str) -> Option<u32> {
    let plain = !digits.starts_with('0') && !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit());
    plain.then(|| digits.parse().ok()).flatten()
}

/// The number in an automatic name exactly as the UI wrote it before `account-number` existed, in either language:
/// "Perfil 4" or "Profile 4" (a cleaned name). Anything else (other case, extra words, "Perfil 04"): `None`.
fn auto_number_in(name: &str) -> Option<u32> {
    parse_number(name.strip_prefix("Perfil ").or_else(|| name.strip_prefix("Profile "))?)
}

/// The number fixed for an account's automatic name. Missing, not a plain file or not a plain number: `None`.
fn read_number(dir: &Path) -> Option<u32> {
    let path = dir.join(NUMBER_FILE);
    if !path.symlink_metadata().is_ok_and(|m| m.is_file()) {
        return None;
    }
    parse_number(read_small_file(&path)?.trim())
}

fn has_seed(dir: &Path) -> bool {
    dir.join(SEED_FILE_NAME).symlink_metadata().is_ok_and(|m| m.is_file())
}

/// The folders under `accounts/` with a valid id (anything else there is ignored, links included).
fn extra_dirs(root: &Path) -> io::Result<Vec<(String, PathBuf)>> {
    let entries = match fs::read_dir(root.join(ACCOUNTS_DIR)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut found = Vec::new();
    for entry in entries {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
        if AccountId::parse(&name).is_some_and(|id| id != AccountId::Main)
            && entry.file_type().is_ok_and(|t| t.is_dir())
        {
            found.push((name, entry.path()));
        }
    }
    Ok(found)
}

/// The folder's creation time (or, where the file system does not keep it, the seed's last change).
fn created_at(dir: &Path) -> Option<i64> {
    let time = fs::metadata(dir)
        .and_then(|m| m.created())
        .or_else(|_| fs::metadata(dir.join(SEED_FILE_NAME)).and_then(|m| m.modified()))
        .ok()?;
    i64::try_from(time.duration_since(UNIX_EPOCH).ok()?.as_secs()).ok()
}

/// The account to open: the one in `current-account` if it is valid and its folder exists, otherwise account 1.
fn read_current(root: &Path) -> AccountId {
    let Some(text) = read_small_file(&root.join(CURRENT_FILE)) else { return AccountId::Main };
    match AccountId::parse(text.trim()) {
        Some(AccountId::Extra(id)) => {
            let exists = root.join(ACCOUNTS_DIR).join(&id).symlink_metadata().is_ok_and(|m| m.is_dir());
            if exists { AccountId::Extra(id) } else { AccountId::Main }
        }
        _ => AccountId::Main,
    }
}

/// Removes folders of other accounts that hold nothing but `instance.lock` (a new account that was abandoned before
/// creating or restoring it). One that another window has open is left alone. Best effort: errors are ignored.
fn remove_abandoned(root: &Path, current: &AccountId) {
    let Ok(dirs) = extra_dirs(root) else { return };
    for (id, dir) in dirs {
        if AccountId::Extra(id) == *current || !only_lock_file(&dir) {
            continue;
        }
        match ProfileLock::acquire(&dir) {
            Ok(lock) => drop(lock),
            Err(_) => continue,
        }
        let _ = fs::remove_file(dir.join(LOCK_FILE_NAME));
        // Fails, and keeps the folder, if anything appeared in it meanwhile.
        if fs::remove_dir(&dir).is_ok() {
            log::info!("[accounts] removed an abandoned empty account folder");
        }
    }
}

fn only_lock_file(dir: &Path) -> bool {
    let Ok(mut entries) = fs::read_dir(dir) else { return false };
    entries.all(|e| e.is_ok_and(|e| e.file_name() == LOCK_FILE_NAME))
}

fn read_small_file(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut text = String::new();
    file.take(MAX_SMALL_FILE).read_to_string(&mut text).ok()?;
    Some(text)
}

/// Replaces `dir/name` whole (temp file, fsync and `rename`), private to the user.
fn write_small_file(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    let temporary = dir.join(format!("{name}.{}.tmp", hex::encode(random_bytes::<8>())));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options.open(&temporary).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    let result = written.and_then(|()| fs::rename(&temporary, dir.join(name)));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

// ---------- Window size and position across the restart ----------

/// Where the window was just before restarting: physical pixels, as the window reports them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WindowPlace {
    pub position: Option<(i32, i32)>,
    pub size: Option<(u32, u32)>,
    pub maximized: bool,
}

/// Sizes outside this range are not applied (a damaged file must not shrink or blow up the window).
const SIZE_RANGE: std::ops::RangeInclusive<u32> = 200..=20_000;
/// Positions outside this range are not applied.
const POSITION_RANGE: std::ops::RangeInclusive<i32> = -20_000..=20_000;

impl WindowPlace {
    pub fn to_text(self) -> String {
        let mut text = String::new();
        if let Some((x, y)) = self.position {
            text.push_str(&format!("position {x} {y}\n"));
        }
        if let Some((w, h)) = self.size {
            text.push_str(&format!("size {w} {h}\n"));
        }
        if self.maximized {
            text.push_str("maximized\n");
        }
        text
    }

    /// Reads what [`Self::to_text`] wrote. Unknown or out-of-range lines are skipped.
    pub fn parse(text: &str) -> Self {
        let mut place = WindowPlace::default();
        for line in text.lines() {
            let words: Vec<&str> = line.split_whitespace().collect();
            match words.as_slice() {
                ["position", x, y] => {
                    if let (Ok(x), Ok(y)) = (x.parse::<i32>(), y.parse::<i32>())
                        && POSITION_RANGE.contains(&x)
                        && POSITION_RANGE.contains(&y)
                    {
                        place.position = Some((x, y));
                    }
                }
                ["size", w, h] => {
                    if let (Ok(w), Ok(h)) = (w.parse::<u32>(), h.parse::<u32>())
                        && SIZE_RANGE.contains(&w)
                        && SIZE_RANGE.contains(&h)
                    {
                        place.size = Some((w, h));
                    }
                }
                ["maximized"] => place.maximized = true,
                _ => {}
            }
        }
        place
    }
}

/// A screen's rectangle in physical pixels: top-left corner and size.
pub type ScreenRect = ((i32, i32), (u32, u32));

/// Whether a window whose outer top-left corner is at `position` can still be grabbed: a point of its title bar lies
/// on one of `screens`. A screen unplugged since the place was saved must not leave the window out of reach.
pub fn reachable(position: (i32, i32), screens: &[ScreenRect]) -> bool {
    // Inside the title bar, past the invisible resize border some systems count in the outer position.
    let (x, y) = (i64::from(position.0) + 64, i64::from(position.1) + 16);
    screens.iter().any(|&((left, top), (width, height))| {
        let (left, top) = (i64::from(left), i64::from(top));
        x >= left && x < left + i64::from(width) && y >= top && y < top + i64::from(height)
    })
}

/// Saves the window place for the next startup.
pub fn save_window_place(root: &Path, place: WindowPlace) -> io::Result<()> {
    write_small_file(root, WINDOW_FILE, place.to_text().as_bytes())
}

/// The window place saved before a restart, if any. The file is removed: it only applies once.
pub fn take_window_place(root: &Path) -> Option<WindowPlace> {
    let path = root.join(WINDOW_FILE);
    let text = read_small_file(&path);
    let _ = fs::remove_file(&path);
    text.map(|text| WindowPlace::parse(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(dir: &Path) {
        fsutil::ensure_private_dir(dir).unwrap();
        fs::write(dir.join(SEED_FILE_NAME), b"seed").unwrap();
    }

    fn ids(accounts: &Accounts) -> Vec<String> {
        accounts.list().unwrap().into_iter().map(|a| a.id).collect()
    }

    #[test]
    fn the_existing_profile_is_account_1_without_moving_anything() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        assert_eq!(accounts.current(), &AccountId::Main);
        assert_eq!(accounts.current_dir(), dir.path());
        let list = accounts.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].id.as_str(), list[0].number, list[0].current), (MAIN_ID, 1, true));
        assert!(list[0].created_at.is_some());
        // Nothing was created or moved: the seed stays where it was and there is no `accounts/` or `current-account`.
        let names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, [SEED_FILE_NAME]);
    }

    #[test]
    fn folders_without_a_seed_are_not_listed() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let with_seed = "a".repeat(32);
        let without = "b".repeat(32);
        seed(&dir.path().join(ACCOUNTS_DIR).join(&with_seed));
        let empty = dir.path().join(ACCOUNTS_DIR).join(&without);
        fsutil::ensure_private_dir(&empty).unwrap();
        fs::write(empty.join("something"), b"x").unwrap();
        // Badly named entries are ignored too.
        fsutil::ensure_private_dir(&dir.path().join(ACCOUNTS_DIR).join("not-an-id")).unwrap();
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        assert_eq!(ids(&accounts), [MAIN_ID.to_owned(), with_seed]);
        let numbers: Vec<u32> = accounts.list().unwrap().iter().map(|a| a.number).collect();
        assert_eq!(numbers, [1, 2]);
    }

    #[test]
    fn a_broken_current_account_file_opens_account_1() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let missing = "c".repeat(32);
        for text in ["", "rubbish", "../../etc", "ABCDEF", missing.as_str(), "main\n"] {
            fs::write(dir.path().join(CURRENT_FILE), text).unwrap();
            let accounts = Accounts::at_startup(dir.path().to_path_buf());
            assert_eq!(accounts.current(), &AccountId::Main, "{text:?}");
        }
        // A directory in its place, too.
        fs::remove_file(dir.path().join(CURRENT_FILE)).unwrap();
        fs::create_dir(dir.path().join(CURRENT_FILE)).unwrap();
        assert_eq!(Accounts::at_startup(dir.path().to_path_buf()).current(), &AccountId::Main);
    }

    #[test]
    fn a_valid_current_account_file_opens_that_account() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let id = "0123456789abcdef0123456789abcdef";
        seed(&dir.path().join(ACCOUNTS_DIR).join(id));
        fs::write(dir.path().join(CURRENT_FILE), format!("{id}\n")).unwrap();
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        assert_eq!(accounts.current(), &AccountId::Extra(id.to_owned()));
        assert_eq!(accounts.current_dir(), dir.path().join(ACCOUNTS_DIR).join(id));
        let current: Vec<bool> = accounts.list().unwrap().iter().map(|a| a.current).collect();
        assert_eq!(current, [false, true]);
    }

    #[test]
    fn ids_that_could_be_paths_are_rejected() {
        for bad in [
            "..",
            "../x",
            "/etc",
            "a/b",
            "a\\b",
            "..\\..",
            "",
            "MAIN",
            "0123456789ABCDEF0123456789ABCDEF",
            "0123456789abcdef0123456789abcde",
            "0123456789abcdef0123456789abcdef0",
            "0123456789abcdef/123456789abcdef",
            "0123456789abcdef.123456789abcdef",
            "0123456789abcdef\\123456789abcdef",
            "0123456789abcdeg0123456789abcdef",
        ] {
            assert_eq!(AccountId::parse(bad), None, "{bad:?}");
        }
        assert_eq!(AccountId::parse("main"), Some(AccountId::Main));
        let good = "0123456789abcdef0123456789abcdef";
        assert_eq!(AccountId::parse(good), Some(AccountId::Extra(good.to_owned())));
    }

    #[test]
    fn only_listed_accounts_can_be_chosen() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        let unknown = AccountId::Extra("d".repeat(32));
        assert_eq!(accounts.choose(&unknown).unwrap_err().kind(), io::ErrorKind::NotFound);
        assert!(!dir.path().join(CURRENT_FILE).exists());
        accounts.choose(&AccountId::Main).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join(CURRENT_FILE)).unwrap(), MAIN_ID);
    }

    #[test]
    fn a_new_account_gets_a_private_folder_and_opens_next() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        let id = accounts.create().unwrap();
        assert!(matches!(&id, AccountId::Extra(hex) if AccountId::parse(hex) == Some(id.clone())));
        let folder = accounts.dir(&id);
        assert!(folder.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&folder).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(fs::metadata(dir.path().join(CURRENT_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Not listed until it has a seed, but it is the one opened next.
        assert_eq!(ids(&accounts), [MAIN_ID]);
        assert_eq!(Accounts::at_startup(dir.path().to_path_buf()).current(), &id);
        // No temp files left behind.
        let leftovers = fs::read_dir(dir.path()).unwrap().filter(|e| {
            e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp")
        });
        assert_eq!(leftovers.count(), 0);
    }

    #[test]
    fn an_abandoned_new_account_is_removed_at_the_next_startup_unless_open() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        let id = accounts.create().unwrap();
        let folder = accounts.dir(&id);
        // Opened (lock taken) and then abandoned: back to account 1.
        let lock = ProfileLock::acquire(&folder).unwrap();
        accounts.choose(&AccountId::Main).unwrap();
        // While another window holds it, it stays.
        Accounts::at_startup(dir.path().to_path_buf());
        assert!(folder.is_dir());
        drop(lock);
        // It is still the current one: kept.
        write_small_file(dir.path(), CURRENT_FILE, id.as_str().as_bytes()).unwrap();
        Accounts::at_startup(dir.path().to_path_buf());
        assert!(folder.is_dir());
        // Not current, holding only its lock file: removed.
        accounts.choose(&AccountId::Main).unwrap();
        Accounts::at_startup(dir.path().to_path_buf());
        assert!(!folder.exists());
    }

    #[test]
    fn an_abandoned_folder_with_anything_else_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let folder = dir.path().join(ACCOUNTS_DIR).join("e".repeat(32));
        drop(ProfileLock::acquire(&folder).unwrap());
        fs::write(folder.join("attempts.v1"), b"x").unwrap();
        Accounts::at_startup(dir.path().to_path_buf());
        assert!(folder.join(LOCK_FILE_NAME).exists());
    }

    #[test]
    fn accounts_are_numbered_by_creation_order() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        let mut created = Vec::new();
        for _ in 0..3 {
            let id = accounts.create().unwrap();
            seed(&accounts.dir(&id));
            created.push(id.as_str().to_owned());
            // Creation times in whole seconds: the order must not hang on the id when they differ.
            std::thread::sleep(std::time::Duration::from_millis(1100));
        }
        let list = Accounts::at_startup(dir.path().to_path_buf()).list().unwrap();
        let order: Vec<&str> = list.iter().skip(1).map(|a| a.id.as_str()).collect();
        assert_eq!(order, created.iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!(list.iter().map(|a| a.number).collect::<Vec<_>>(), [1, 2, 3, 4]);
    }

    #[test]
    fn the_window_place_round_trips_once() {
        let dir = tempfile::tempdir().unwrap();
        let place = WindowPlace { position: Some((-1200, 40)), size: Some((1280, 860)), maximized: true };
        save_window_place(dir.path(), place).unwrap();
        assert_eq!(take_window_place(dir.path()), Some(place));
        assert_eq!(take_window_place(dir.path()), None, "it applies once");
    }

    #[test]
    fn a_position_off_every_screen_is_not_used() {
        let screens = [((0, 0), (1920, 1080)), ((1920, -200), (2560, 1440))];
        assert!(reachable((100, 100), &screens));
        assert!(reachable((-7, 0), &screens), "snapped to the left edge");
        assert!(reachable((3000, -150), &screens), "on the second screen, above the first one's top");
        assert!(!reachable((-5000, 100), &screens), "on a screen that is no longer there");
        assert!(!reachable((100, 1075), &screens), "title bar below the bottom edge");
        assert!(!reachable((100, 100), &[]), "no screen known");
    }

    #[test]
    fn a_damaged_window_place_applies_nothing_odd() {
        let place = WindowPlace::parse("size 10 10\nposition 99999999 3\nsize x y\nposition 1 2 3\nwhatever\n");
        assert_eq!(place, WindowPlace::default());
        let place = WindowPlace::parse("size 1000 700\n");
        assert_eq!(place, WindowPlace { position: None, size: Some((1000, 700)), maximized: false });
    }

    // ---------- Names ----------

    fn names(accounts: &Accounts) -> Vec<Option<String>> {
        accounts.list().unwrap().into_iter().map(|a| a.name).collect()
    }

    #[test]
    fn an_account_without_a_name_file_has_no_name() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        seed(&dir.path().join(ACCOUNTS_DIR).join("a".repeat(32)));
        assert_eq!(names(&Accounts::at_startup(dir.path().to_path_buf())), [None, None]);
    }

    #[test]
    fn a_name_is_saved_in_the_account_folder_and_listed() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        let id = accounts.create().unwrap();
        seed(&accounts.dir(&id));
        accounts.set_name(&AccountId::Main, "  Trabajo  ").unwrap();
        accounts.set_name(&id, "Personal ñ 😀").unwrap();
        assert_eq!(names(&accounts), [Some("Trabajo".to_owned()), Some("Personal ñ 😀".to_owned())]);
        // Account 1's file is in the profile folder, the other's in its own; nothing else (no temp files).
        assert_eq!(fs::read_to_string(dir.path().join(NAME_FILE)).unwrap(), "Trabajo");
        assert_eq!(fs::read_to_string(accounts.dir(&id).join(NAME_FILE)).unwrap(), "Personal ñ 😀");
        let mut files: Vec<_> = fs::read_dir(accounts.dir(&id)).unwrap().map(|e| e.unwrap().file_name()).collect();
        files.sort();
        assert_eq!(files, [NAME_FILE, NUMBER_FILE, SEED_FILE_NAME]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(dir.path().join(NAME_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Renamed, then emptied: back to the default name, and the file is gone.
        accounts.set_name(&id, "Otro").unwrap();
        assert_eq!(names(&accounts)[1].as_deref(), Some("Otro"));
        accounts.set_name(&id, " \t\n ").unwrap();
        assert_eq!(names(&accounts)[1], None);
        assert!(!accounts.dir(&id).join(NAME_FILE).exists());
        accounts.set_name(&id, "").unwrap();
    }

    #[test]
    fn an_account_without_a_seed_cannot_be_named() {
        let dir = tempfile::tempdir().unwrap();
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        assert_eq!(accounts.set_name(&AccountId::Main, "x").unwrap_err().kind(), io::ErrorKind::NotFound);
        seed(dir.path());
        let id = accounts.create().unwrap();
        assert_eq!(accounts.set_name(&id, "x").unwrap_err().kind(), io::ErrorKind::NotFound);
        // So an abandoned new account still holds nothing but its lock and is removed.
        assert!(!accounts.dir(&id).join(NAME_FILE).exists());
    }

    #[test]
    fn names_are_cleaned_and_limited() {
        assert_eq!(clean_name("").unwrap(), None);
        assert_eq!(clean_name("   ").unwrap(), None);
        assert_eq!(clean_name("\u{200B}\u{FEFF}").unwrap(), None, "only invisible characters");
        assert_eq!(clean_name("  a   b  ").unwrap().as_deref(), Some("a b"));
        assert_eq!(clean_name("a\nb\r\nc\td\0e\u{7}f\u{85}g").unwrap().as_deref(), Some("a b c d e f g"));
        assert_eq!(clean_name("ad\u{202E}nimda\u{200F}").unwrap().as_deref(), Some("adnimda"), "no direction override");
        // Never a path, never markup: those characters are kept as text (the UI escapes them).
        assert_eq!(clean_name("../../etc/passwd").unwrap().as_deref(), Some("../../etc/passwd"));
        assert_eq!(clean_name("<b>x</b> & \"y\"").unwrap().as_deref(), Some("<b>x</b> & \"y\""));
        // 40 characters fit (counted as characters, not bytes); 41 do not, and nothing is cut.
        let forty = "ñ".repeat(MAX_NAME_CHARS);
        assert_eq!(clean_name(&forty).unwrap().as_deref(), Some(forty.as_str()));
        assert_eq!(clean_name(&format!("  {forty}  ")).unwrap().as_deref(), Some(forty.as_str()), "spaces do not count");
        let emoji = "😀".repeat(MAX_NAME_CHARS);
        assert_eq!(clean_name(&emoji).unwrap().as_deref(), Some(emoji.as_str()));
        for long in ["a".repeat(MAX_NAME_CHARS + 1), "x".repeat(10_000), format!("{} ", " ".repeat(2000))] {
            assert_eq!(clean_name(&long).unwrap_err().kind(), io::ErrorKind::InvalidInput);
        }
    }

    #[test]
    fn a_too_long_name_is_refused_and_the_old_one_stays() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        accounts.set_name(&AccountId::Main, "Casa").unwrap();
        let error = accounts.set_name(&AccountId::Main, &"a".repeat(MAX_NAME_CHARS + 1)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(names(&accounts), [Some("Casa".to_owned())]);
    }

    #[test]
    fn a_damaged_name_file_shows_the_default_name() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        let path = dir.path().join(NAME_FILE);
        for bytes in [&b""[..], b"  \n", b"\xff\xfe not utf-8", "a".repeat(200).as_bytes()] {
            fs::write(&path, bytes).unwrap();
            assert_eq!(names(&accounts), [None], "{bytes:?}");
        }
        // Edited by hand with control characters: cleaned on reading too.
        fs::write(&path, "Mi\r\nperfil\u{202E}\n").unwrap();
        assert_eq!(names(&accounts), [Some("Mi perfil".to_owned())]);
        // A folder in its place is not read.
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_eq!(names(&accounts), [None]);
    }

    // ---------- Automatic names ----------

    /// (name, auto_number) of each listed account.
    fn shown(accounts: &Accounts) -> Vec<(Option<String>, u32)> {
        accounts.list().unwrap().into_iter().map(|a| (a.name, a.auto_number)).collect()
    }

    /// Account 1 plus `n` more, created in order (distinct creation times are not needed: equal ones go by id).
    fn with_extras(dir: &Path, n: usize) -> (Accounts, Vec<AccountId>) {
        seed(dir);
        let mut ids = Vec::new();
        for i in 0..n {
            let id = AccountId::Extra(format!("{i:0>32}"));
            seed(&dir.join(ACCOUNTS_DIR).join(id.as_str()));
            ids.push(id);
        }
        (Accounts::at_startup(dir.to_path_buf()), ids)
    }

    #[test]
    fn left_empty_the_automatic_number_is_fixed_and_survives_removing_other_accounts() {
        let dir = tempfile::tempdir().unwrap();
        let (accounts, ids) = with_extras(dir.path(), 2);
        let view = accounts.set_name(&ids[1], "").unwrap();
        assert_eq!((view.name, view.number, view.auto_number), (None, 3, 3));
        // Stored as a mark with the number, never as a text in some language.
        assert_eq!(fs::read_to_string(accounts.dir(&ids[1]).join(NUMBER_FILE)).unwrap(), "3");
        assert!(!accounts.dir(&ids[1]).join(NAME_FILE).exists());
        // Another account goes away: the place in the list changes, the automatic number does not.
        fs::remove_dir_all(accounts.dir(&ids[0])).unwrap();
        let list = accounts.list().unwrap();
        assert_eq!((list[1].number, list[1].auto_number, list[1].name.as_deref()), (2, 3, None));
    }

    #[test]
    fn without_any_file_the_automatic_number_is_the_place_in_the_list() {
        let dir = tempfile::tempdir().unwrap();
        let (accounts, _) = with_extras(dir.path(), 1);
        assert_eq!(shown(&accounts), [(None, 1), (None, 2)]);
    }

    #[test]
    fn at_startup_an_account_without_a_fixed_number_gets_its_place_now() {
        let dir = tempfile::tempdir().unwrap();
        let (accounts, ids) = with_extras(dir.path(), 3);
        // Account 1 needs no file. Account 3 has an old automatic name: its number is already in it.
        assert!(!dir.path().join(NUMBER_FILE).exists());
        for id in &ids {
            fs::remove_file(accounts.dir(id).join(NUMBER_FILE)).unwrap();
        }
        fs::write(accounts.dir(&ids[1]).join(NAME_FILE), "Perfil 9").unwrap();
        fs::write(accounts.dir(&ids[2]).join(NAME_FILE), "Casa").unwrap();
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        assert!(!dir.path().join(NUMBER_FILE).exists());
        assert_eq!(fs::read_to_string(accounts.dir(&ids[0]).join(NUMBER_FILE)).unwrap(), "2");
        assert!(!accounts.dir(&ids[1]).join(NUMBER_FILE).exists());
        assert_eq!(fs::read_to_string(accounts.dir(&ids[2]).join(NUMBER_FILE)).unwrap(), "4");
        // An earlier account goes away: the numbers stay.
        fs::remove_dir_all(accounts.dir(&ids[0])).unwrap();
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        assert_eq!(shown(&accounts), [(None, 1), (None, 9), (Some("Casa".to_owned()), 4)]);
    }

    #[test]
    fn the_old_saved_automatic_name_is_read_as_automatic_in_both_languages() {
        let dir = tempfile::tempdir().unwrap();
        let (accounts, ids) = with_extras(dir.path(), 2);
        // Written by the previous version: the text in the language of that moment, with the number of then.
        fs::write(dir.path().join(NAME_FILE), "Perfil 1").unwrap();
        fs::write(accounts.dir(&ids[0]).join(NAME_FILE), "Profile 7").unwrap();
        fs::write(accounts.dir(&ids[1]).join(NAME_FILE), "Perfil 3\n").unwrap();
        assert_eq!(shown(&accounts), [(None, 1), (None, 7), (None, 3)]);
        // Only that exact shape: anything else is a name the user wrote and stays as it is.
        for custom in ["perfil 2", "Perfil", "Perfil 2b", "Perfil 02", "Perfil -2", "Perfil 0", "Mi Perfil 2", "Perfiles 2", "Perfil 99999999999"] {
            fs::write(dir.path().join(NAME_FILE), custom).unwrap();
            assert_eq!(shown(&accounts)[0], (Some(custom.to_owned()), 1), "{custom}");
        }
    }

    #[test]
    fn emptying_an_old_automatic_name_keeps_its_number() {
        let dir = tempfile::tempdir().unwrap();
        let (accounts, ids) = with_extras(dir.path(), 1);
        fs::write(accounts.dir(&ids[0]).join(NAME_FILE), "Perfil 5").unwrap();
        let view = accounts.set_name(&ids[0], "  ").unwrap();
        assert_eq!((view.name, view.auto_number), (None, 5));
        assert_eq!(fs::read_to_string(accounts.dir(&ids[0]).join(NUMBER_FILE)).unwrap(), "5");
        assert!(!accounts.dir(&ids[0]).join(NAME_FILE).exists(), "migrated: only the mark is left");
        assert_eq!(shown(&accounts)[1], (None, 5));
    }

    #[test]
    fn a_written_name_and_back_to_automatic_keeps_the_number() {
        let dir = tempfile::tempdir().unwrap();
        let (accounts, ids) = with_extras(dir.path(), 2);
        // Named when created (number 3 then), renamed later, then emptied once its place in the list changed.
        let view = accounts.set_name(&ids[1], "Trabajo").unwrap();
        assert_eq!((view.name.as_deref(), view.auto_number), (Some("Trabajo"), 3));
        assert_eq!(accounts.set_name(&ids[1], "Casa").unwrap().name.as_deref(), Some("Casa"));
        fs::remove_dir_all(accounts.dir(&ids[0])).unwrap();
        assert_eq!(accounts.list().unwrap()[1].number, 2, "now second in the list");
        let view = accounts.set_name(&ids[1], "").unwrap();
        assert_eq!((view.name, view.number, view.auto_number), (None, 2, 3));
    }

    #[test]
    fn typing_the_automatic_name_by_hand_makes_it_automatic() {
        let dir = tempfile::tempdir().unwrap();
        let (accounts, ids) = with_extras(dir.path(), 1);
        let view = accounts.set_name(&ids[0], "  Profile   4 ").unwrap();
        assert_eq!((view.name, view.auto_number), (None, 4));
        assert_eq!(shown(&accounts)[1], (None, 4));
        assert!(!accounts.dir(&ids[0]).join(NAME_FILE).exists());
    }

    #[test]
    fn a_damaged_number_file_falls_back_to_the_place_in_the_list() {
        let dir = tempfile::tempdir().unwrap();
        let (accounts, ids) = with_extras(dir.path(), 1);
        let path = accounts.dir(&ids[0]).join(NUMBER_FILE);
        for bytes in [&b""[..], b"0", b"-3", b"03", b"3x", b"\xff", b"99999999999", "9".repeat(300).as_bytes()] {
            fs::write(&path, bytes).unwrap();
            assert_eq!(shown(&accounts)[1], (None, 2), "{bytes:?}");
        }
        fs::write(&path, "6\n").unwrap();
        assert_eq!(shown(&accounts)[1], (None, 6));
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_eq!(shown(&accounts)[1], (None, 2), "a folder in its place is not read");
    }

    #[test]
    fn a_refused_name_changes_neither_file() {
        let dir = tempfile::tempdir().unwrap();
        let (accounts, _) = with_extras(dir.path(), 0);
        let error = accounts.set_name(&AccountId::Main, &"a".repeat(MAX_NAME_CHARS + 1)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(!dir.path().join(NUMBER_FILE).exists());
        assert!(!dir.path().join(NAME_FILE).exists());
        // Cleaned as before saving: invisible characters out, spaces joined.
        let view = accounts.set_name(&AccountId::Main, "\u{200B} Mi \t perfil\u{202E} ").unwrap();
        assert_eq!(view.name.as_deref(), Some("Mi perfil"));
    }

    // ---------- Deleting ----------

    const PASSWORD: &str = "una contraseña";

    /// An account with a real seed (fast Argon2id), some mail data and a name.
    fn real_account(dir: &Path) {
        fsutil::ensure_private_dir(dir).unwrap();
        keys::create_with(dir, PASSWORD, &keys::TEST_POLICY).unwrap();
        let scope = dir.join(NETWORKS_DIR).join("undeployed").join("abc");
        fs::create_dir_all(scope.join("wallet")).unwrap();
        fs::write(scope.join("mail.db"), b"db").unwrap();
        fs::write(scope.join("wallet").join("state"), b"w").unwrap();
        fs::write(dir.join(NAME_FILE), b"Trabajo").unwrap();
    }

    /// What the command does for an account that is not open: lock, password, removal.
    fn delete_with(accounts: &Accounts, id: &AccountId, password: &str, lock_held: bool) -> Result<(), DeleteError> {
        let deletion = accounts.prepare_delete(id, lock_held)?;
        keys::check_password_with(deletion.dir(), password, &keys::TEST_POLICY).map_err(DeleteError::Key)?;
        accounts.delete(deletion).map_err(DeleteError::Io)
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> =
            fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn an_account_is_deleted_with_its_password_and_the_others_stay() {
        let dir = tempfile::tempdir().unwrap();
        real_account(dir.path());
        let (one, two) = (AccountId::Extra("a".repeat(32)), AccountId::Extra("b".repeat(32)));
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        real_account(&accounts.dir(&one));
        real_account(&accounts.dir(&two));
        delete_with(&accounts, &one, PASSWORD, false).unwrap();
        assert!(!accounts.dir(&one).exists(), "its whole folder is gone");
        assert_eq!(ids(&accounts), [MAIN_ID.to_owned(), "b".repeat(32)]);
        // The others keep everything, and still open with their password.
        assert!(accounts.dir(&two).join(NETWORKS_DIR).join("undeployed/abc/mail.db").is_file());
        assert!(dir.path().join(NETWORKS_DIR).join("undeployed/abc/mail.db").is_file());
        keys::check_password_with(&accounts.dir(&two), PASSWORD, &keys::TEST_POLICY).unwrap();
    }

    #[test]
    fn a_wrong_password_deletes_nothing_and_counts_as_a_failed_attempt() {
        let dir = tempfile::tempdir().unwrap();
        real_account(dir.path());
        let id = AccountId::Extra("c".repeat(32));
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        real_account(&accounts.dir(&id));
        let before = entries(&accounts.dir(&id));
        let error = delete_with(&accounts, &id, "otra", false).unwrap_err();
        assert!(matches!(error, DeleteError::Key(KeyError::Locked)), "{error:?}");
        // Only the failed-attempt counter appeared (the same one unlocking uses), and the lock file.
        let mut expected = before.clone();
        expected.extend([ATTEMPTS_FILE_NAME.to_owned(), LOCK_FILE_NAME.to_owned()]);
        expected.sort();
        expected.dedup();
        assert_eq!(entries(&accounts.dir(&id)), expected);
        assert_eq!(ids(&accounts).len(), 2);
        // From the 5th failure on, a wait: then even the right password is not checked.
        for _ in 0..4 {
            let _ = delete_with(&accounts, &id, "otra", false);
        }
        let error = delete_with(&accounts, &id, PASSWORD, false).unwrap_err();
        assert!(matches!(error, DeleteError::Key(KeyError::TooManyAttempts { .. })), "{error:?}");
        assert!(accounts.has_seed(&id));
    }

    #[test]
    fn only_listed_accounts_can_be_deleted() {
        let dir = tempfile::tempdir().unwrap();
        real_account(dir.path());
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        // Never a path: these do not even parse as ids.
        for bad in ["../x", "..", "accounts/../main", "/tmp", "a\\b"] {
            assert_eq!(AccountId::parse(bad), None, "{bad:?}");
        }
        // A valid id without a folder, or a folder without a seed.
        let missing = AccountId::Extra("d".repeat(32));
        assert!(matches!(accounts.prepare_delete(&missing, false), Err(DeleteError::NotFound)));
        let empty = accounts.create().unwrap();
        fs::write(accounts.dir(&empty).join("algo"), b"x").unwrap();
        assert!(matches!(accounts.prepare_delete(&empty, false), Err(DeleteError::NotFound)));
        assert!(accounts.dir(&empty).join("algo").exists());
    }

    #[cfg(unix)]
    #[test]
    fn links_are_never_followed() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        real_account(dir.path());
        real_account(outside.path());
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        // The account's folder is a link to a folder elsewhere: refused, the other folder untouched.
        fs::create_dir_all(dir.path().join(ACCOUNTS_DIR)).unwrap();
        let linked = AccountId::Extra("e".repeat(32));
        std::os::unix::fs::symlink(outside.path(), accounts.dir(&linked)).unwrap();
        assert!(matches!(accounts.prepare_delete(&linked, false), Err(DeleteError::NotFound)));
        assert!(outside.path().join(SEED_FILE_NAME).is_file());
        // A link inside the account's folder is removed as a link: what it points to stays.
        let id = AccountId::Extra("f".repeat(32));
        real_account(&accounts.dir(&id));
        std::os::unix::fs::symlink(outside.path(), accounts.dir(&id).join("enlace")).unwrap();
        std::os::unix::fs::symlink(outside.path().join(SEED_FILE_NAME), accounts.dir(&id).join("enlace-fichero")).unwrap();
        delete_with(&accounts, &id, PASSWORD, false).unwrap();
        assert!(!accounts.dir(&id).exists());
        assert!(outside.path().join(SEED_FILE_NAME).is_file());
        assert!(outside.path().join(NETWORKS_DIR).join("undeployed/abc/mail.db").is_file());
        fs::remove_file(accounts.dir(&linked)).unwrap();
        // `accounts/` itself a link: refused too.
        fs::remove_dir_all(dir.path().join(ACCOUNTS_DIR)).unwrap();
        let other = tempfile::tempdir().unwrap();
        real_account(&other.path().join("0".repeat(32)));
        std::os::unix::fs::symlink(other.path(), dir.path().join(ACCOUNTS_DIR)).unwrap();
        let through = AccountId::Extra("0".repeat(32));
        assert!(matches!(accounts.prepare_delete(&through, false), Err(DeleteError::NotFound)));
        assert!(other.path().join("0".repeat(32)).join(SEED_FILE_NAME).is_file());
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_swapped_for_a_link_after_the_check_is_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        real_account(dir.path());
        real_account(outside.path());
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        let id = AccountId::Extra("7".repeat(32));
        real_account(&accounts.dir(&id));
        let deletion = accounts.prepare_delete(&id, false).unwrap();
        // While the password is being checked, the folder becomes a link to another account's folder.
        fs::rename(accounts.dir(&id), dir.path().join("apartada")).unwrap();
        std::os::unix::fs::symlink(outside.path(), accounts.dir(&id)).unwrap();
        assert_eq!(accounts.delete(deletion).unwrap_err().kind(), io::ErrorKind::NotFound);
        // What `real_account` left there, untouched.
        assert_eq!(entries(outside.path()), [NAME_FILE, NETWORKS_DIR, SEED_FILE_NAME]);
        assert!(outside.path().join(NETWORKS_DIR).join("undeployed/abc/mail.db").is_file());
    }

    #[test]
    fn deleting_account_1_removes_only_its_own_files() {
        let dir = tempfile::tempdir().unwrap();
        real_account(dir.path());
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        let other = AccountId::Extra("1".repeat(32));
        real_account(&accounts.dir(&other));
        accounts.choose(&other).unwrap();
        save_window_place(dir.path(), WindowPlace::default()).unwrap();
        fs::write(dir.path().join("desconocido"), b"x").unwrap();
        fs::write(dir.path().join("seed.v1.0011223344556677.tmp"), b"old").unwrap();
        fs::write(dir.path().join(format!("{NAME_FILE}.8899aabbccddeeff.tmp")), b"old").unwrap();
        fs::write(dir.path().join(format!("{SHOW_ACCOUNTS_FILE}.0011223344556677.tmp")), b"x").unwrap();
        // Its name and the number of its automatic name, as Settings leaves them.
        accounts.set_name(&AccountId::Main, "Perfil 7").unwrap();
        accounts.set_name(&AccountId::Main, "Casa").unwrap();
        assert_eq!(fs::read_to_string(dir.path().join(NUMBER_FILE)).unwrap(), "7");
        fs::write(dir.path().join(format!("{NUMBER_FILE}.8899aabbccddeeff.tmp")), b"7").unwrap();
        delete_with(&accounts, &AccountId::Main, PASSWORD, false).unwrap();
        // Its seed, data, name and temp files are gone. The profile folder's own files, the other account and anything
        // unknown stay, and so does account 1's lock file.
        let not_its_own = format!("{SHOW_ACCOUNTS_FILE}.0011223344556677.tmp");
        assert_eq!(entries(dir.path()), [ACCOUNTS_DIR, CURRENT_FILE, "desconocido", LOCK_FILE_NAME, &not_its_own, WINDOW_FILE]);
        assert_eq!(ids(&accounts), ["1".repeat(32)]);
        assert!(accounts.dir(&other).join(NETWORKS_DIR).join("undeployed/abc/mail.db").is_file());
        assert_eq!(fs::read_to_string(dir.path().join(CURRENT_FILE)).unwrap(), other.as_str());
        // A new account 1 created there later inherits neither the old name nor the old number.
        keys::create_with(dir.path(), PASSWORD, &keys::TEST_POLICY).unwrap();
        let first = &Accounts::at_startup(dir.path().to_path_buf()).list().unwrap()[0];
        assert_eq!((first.id.as_str(), first.name.as_deref(), first.auto_number), (MAIN_ID, None, 1));
    }

    #[test]
    fn an_account_open_in_another_window_is_not_touched() {
        let dir = tempfile::tempdir().unwrap();
        real_account(dir.path());
        let id = AccountId::Extra("2".repeat(32));
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        real_account(&accounts.dir(&id));
        let before = entries(&accounts.dir(&id));
        let window = ProfileLock::acquire(&accounts.dir(&id)).unwrap();
        assert!(matches!(delete_with(&accounts, &id, PASSWORD, false), Err(DeleteError::InUse)));
        let window_main = ProfileLock::acquire(dir.path()).unwrap();
        assert!(matches!(delete_with(&accounts, &AccountId::Main, PASSWORD, false), Err(DeleteError::InUse)));
        let mut expected = before;
        expected.push(LOCK_FILE_NAME.to_owned());
        expected.sort();
        assert_eq!(entries(&accounts.dir(&id)), expected);
        assert!(accounts.has_seed(&AccountId::Main));
        drop((window, window_main));
        delete_with(&accounts, &id, PASSWORD, false).unwrap();
    }

    #[test]
    fn deleting_the_open_account_restarts_into_the_list_or_the_welcome_screen() {
        let dir = tempfile::tempdir().unwrap();
        real_account(dir.path());
        let id = AccountId::Extra("3".repeat(32));
        real_account(&dir.path().join(ACCOUNTS_DIR).join(id.as_str()));
        fs::write(dir.path().join(CURRENT_FILE), id.as_str()).unwrap();
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        assert_eq!(accounts.current(), &id);
        // This process holds the open account's lock (as `AppState::profile_lock`).
        let own = ProfileLock::acquire(&accounts.current_dir()).unwrap();
        delete_with(&accounts, &id, PASSWORD, true).unwrap();
        // While the lock is held the folder may stay with that file only (Windows). The next account is the one left,
        // with the list first.
        assert!(!accounts.dir(&id).exists() || entries(&accounts.dir(&id)) == [LOCK_FILE_NAME]);
        assert!(accounts.choose_after_delete().unwrap());
        drop(own);
        assert_eq!(fs::read_to_string(dir.path().join(CURRENT_FILE)).unwrap(), MAIN_ID);
        let next = Accounts::at_startup(dir.path().to_path_buf());
        assert_eq!(next.current(), &AccountId::Main);
        assert!(!next.dir(&id).exists(), "the leftover folder is removed at startup");
        assert!(take_show_accounts(dir.path()));
        assert!(!take_show_accounts(dir.path()), "only once");
        // Then account 1, open too: nothing is left, so the welcome screen and no list.
        let own = ProfileLock::acquire(dir.path()).unwrap();
        delete_with(&next, &AccountId::Main, PASSWORD, true).unwrap();
        assert!(!next.choose_after_delete().unwrap());
        drop(own);
        assert_eq!(fs::read_to_string(dir.path().join(CURRENT_FILE)).unwrap(), MAIN_ID);
        assert!(!take_show_accounts(dir.path()));
        assert!(next.list().unwrap().is_empty());
    }

    #[test]
    fn after_deleting_the_open_account_one_free_of_other_windows_opens() {
        let dir = tempfile::tempdir().unwrap();
        real_account(dir.path());
        let (gone, other) = (AccountId::Extra("4".repeat(32)), AccountId::Extra("5".repeat(32)));
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        real_account(&accounts.dir(&gone));
        real_account(&accounts.dir(&other));
        let _main_elsewhere = ProfileLock::acquire(dir.path()).unwrap();
        delete_with(&accounts, &gone, PASSWORD, false).unwrap();
        assert!(accounts.choose_after_delete().unwrap());
        assert_eq!(fs::read_to_string(dir.path().join(CURRENT_FILE)).unwrap(), other.as_str());
    }

    #[test]
    fn a_deleted_account_named_in_current_account_no_longer_opens() {
        let dir = tempfile::tempdir().unwrap();
        real_account(dir.path());
        let id = AccountId::Extra("6".repeat(32));
        let accounts = Accounts::at_startup(dir.path().to_path_buf());
        real_account(&accounts.dir(&id));
        accounts.choose(&id).unwrap();
        delete_with(&accounts, &id, PASSWORD, false).unwrap();
        assert!(!dir.path().join(CURRENT_FILE).exists());
        assert_eq!(Accounts::at_startup(dir.path().to_path_buf()).current(), &AccountId::Main);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_name_file_is_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let elsewhere = dir.path().join("elsewhere");
        fs::write(&elsewhere, "Secreto").unwrap();
        std::os::unix::fs::symlink(&elsewhere, dir.path().join(NAME_FILE)).unwrap();
        assert_eq!(names(&Accounts::at_startup(dir.path().to_path_buf())), [None]);
    }
}
