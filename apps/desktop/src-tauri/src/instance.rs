//! One instance per profile. Two windows on the same profile would share the encrypted database, the password
//! attempt counter and the bonos, and could corrupt them. The first instance takes an OS lock on
//! `<profile>/instance.lock` and holds it for its lifetime; a second one does not start the core and the UI reports
//! `profileInUse`.
//!
//! This is an OS lock (`File::try_lock`: `LockFileEx` on Windows, `flock` elsewhere), not a pid file, so the OS
//! releases it when the process dies, even after a crash, and stale locks cannot exist. The file is intentionally
//! left on disk: deleting it on exit would race with another process opening it.

use std::fs::{File, TryLockError};
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

use crate::app::CoreError;
use crate::fsutil;

/// Lock file name inside the profile directory.
pub const LOCK_FILE_NAME: &str = "instance.lock";

/// A held lock, released on drop or when the process exits.
#[derive(Debug)]
pub struct ProfileLock {
    _file: File,
}

#[derive(Debug)]
pub enum LockError {
    /// Another live instance holds the profile.
    InUse,
    /// The lock directory or file could not be prepared.
    Io(io::Error),
}

impl From<io::Error> for LockError {
    fn from(e: io::Error) -> Self {
        LockError::Io(e)
    }
}

impl LockError {
    /// What the UI sees: profile in use, non-private files, or a storage failure.
    pub fn core_error(&self) -> CoreError {
        match self {
            LockError::InUse => CoreError::ProfileInUse,
            LockError::Io(e) if fsutil::is_insecure(e) => CoreError::InsecureFiles,
            LockError::Io(_) => CoreError::Storage,
        }
    }
}

impl ProfileLock {
    /// Takes the profile lock without waiting. `InUse` if someone else holds it, including another value in this process.
    pub fn acquire(profile_dir: &Path) -> Result<Self, LockError> {
        // The profile directory also holds the seed, so it must be private (as `keys` leaves it).
        fsutil::ensure_private_dir(profile_dir)?;
        let path = profile_dir.join(LOCK_FILE_NAME);
        fsutil::ensure_private_file(&path)?;
        let file = fsutil::open_private_file(&path)?;
        match file.try_lock() {
            Ok(()) => Ok(ProfileLock { _file: file }),
            Err(TryLockError::WouldBlock) => Err(LockError::InUse),
            Err(TryLockError::Error(e)) => Err(LockError::Io(e)),
        }
    }

    /// Like [`Self::acquire`], but while the profile is in use it keeps trying for up to `wait`: an app opened again
    /// right after closing starts while the previous run is still finishing and holds the lock for a moment.
    pub fn acquire_waiting(profile_dir: &Path, wait: Duration) -> Result<Self, LockError> {
        retry_while_in_use(|| Self::acquire(profile_dir), wait, RETRY_EVERY)
    }
}

/// How often [`ProfileLock::acquire_waiting`] tries again.
const RETRY_EVERY: Duration = Duration::from_millis(100);

/// Calls `attempt` until it stops answering `InUse` or `wait` has passed (then the last `InUse` is returned).
fn retry_while_in_use<T>(
    mut attempt: impl FnMut() -> Result<T, LockError>,
    wait: Duration,
    every: Duration,
) -> Result<T, LockError> {
    let deadline = Instant::now() + wait;
    loop {
        match attempt() {
            Err(LockError::InUse) if Instant::now() < deadline => std::thread::sleep(every),
            other => return other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_is_held_by_one_instance_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let first = ProfileLock::acquire(dir.path()).unwrap();
        assert!(matches!(ProfileLock::acquire(dir.path()), Err(LockError::InUse)));
        assert!(matches!(ProfileLock::acquire(dir.path()), Err(LockError::InUse)), "and it is still taken");
        drop(first);
        ProfileLock::acquire(dir.path()).expect("once released it can be taken again");
    }

    #[test]
    fn a_lock_file_left_on_disk_blocks_nobody() {
        // What blocks is the OS lock, not the file's existence: a leftover file is simply taken.
        // (This does not simulate a real crash; the lock is released by hand here.)
        let dir = tempfile::tempdir().unwrap();
        drop(ProfileLock::acquire(dir.path()).unwrap());
        assert!(dir.path().join(LOCK_FILE_NAME).exists());
        ProfileLock::acquire(dir.path()).expect("the orphan file does not block");
    }

    #[test]
    fn different_profiles_do_not_block_each_other() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let _a = ProfileLock::acquire(a.path()).unwrap();
        ProfileLock::acquire(b.path()).expect("another profile is free");
    }

    #[test]
    fn creates_the_profile_folder_if_missing() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("nuevo").join("perfil");
        let _lock = ProfileLock::acquire(&profile).unwrap();
        assert!(profile.join(LOCK_FILE_NAME).is_file());
    }

    #[test]
    fn waits_for_a_lock_that_is_released_soon() {
        let dir = tempfile::tempdir().unwrap();
        let first = ProfileLock::acquire(dir.path()).unwrap();
        // The previous process finishing: it lets go after a moment.
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(first);
        });
        ProfileLock::acquire_waiting(dir.path(), Duration::from_secs(3)).expect("taken once the other lets go");
        releaser.join().unwrap();
    }

    #[test]
    fn gives_up_on_a_lock_still_held_after_the_wait() {
        let dir = tempfile::tempdir().unwrap();
        let _first = ProfileLock::acquire(dir.path()).unwrap();
        let start = Instant::now();
        let error = ProfileLock::acquire_waiting(dir.path(), Duration::from_millis(250)).unwrap_err();
        assert!(matches!(error, LockError::InUse));
        assert!(start.elapsed() >= Duration::from_millis(250));
    }

    #[test]
    fn other_lock_errors_are_not_retried() {
        let mut calls = 0;
        let result: Result<(), LockError> = retry_while_in_use(
            || {
                calls += 1;
                Err(LockError::Io(io::Error::other("disk")))
            },
            Duration::from_secs(3),
            Duration::from_millis(1),
        );
        assert!(matches!(result, Err(LockError::Io(_))));
        assert_eq!(calls, 1);
    }

    #[test]
    fn each_failure_reaches_the_ui_with_its_code() {
        assert_eq!(LockError::InUse.core_error(), CoreError::ProfileInUse);
        assert_eq!(LockError::Io(io::Error::other("disk")).core_error(), CoreError::Storage);
    }

    #[cfg(unix)]
    #[test]
    fn a_lock_file_that_is_not_private_is_not_used() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LOCK_FILE_NAME);
        std::fs::write(&path, b"").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let error = ProfileLock::acquire(dir.path()).unwrap_err();
        assert_eq!(error.core_error(), CoreError::InsecureFiles);
    }
}
