use std::path::PathBuf;

/// The shard a message file belongs in: the first two characters of its name.
///
/// Stored messages are named with random hex, so this spreads them evenly over
/// 256 directories. Names that don't start with two hex digits (draft
/// snapshots, files a test writes) get a stable hash instead, so they still
/// land in one of the shards.
fn shard_of(name: &str) -> String {
    let bytes = name.as_bytes();
    if bytes.len() >= 2 {
        let (first, second) = (bytes[0], bytes[1]);
        if first.is_ascii_hexdigit() && second.is_ascii_hexdigit() {
            return name[..2].to_ascii_lowercase();
        }
    }
    let mut hash: u32 = 2_166_136_261;
    for byte in bytes {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    format!("{:02x}", hash & 0xff)
}

#[derive(Debug, Clone)]
pub struct Paths {
    /// Durable application state. Databases, raw mail, drafts, queues, and
    /// settings live here and must survive process death and cache eviction.
    pub data_dir: PathBuf,
    /// Reconstructable data such as downloaded attachment bodies and preview
    /// scratch files. Hosts may place this in an OS-managed cache directory.
    pub cache_dir: PathBuf,
}

impl Paths {
    /// Resolve desktop directories. Mobile hosts inject their sandbox paths
    /// through `Paths::new`; silently using the process working directory is
    /// never safe there.
    #[cfg(desktop)]
    pub fn default_dirs() -> crate::error::Result<Self> {
        let data_root = dirs::data_dir().ok_or_else(|| {
            crate::error::CoreError::Other(
                "the operating system has no application data directory".into(),
            )
        })?;
        let cache_root = dirs::cache_dir().ok_or_else(|| {
            crate::error::CoreError::Other(
                "the operating system has no application cache directory".into(),
            )
        })?;
        Ok(Self::new(
            data_root.join("flectar-mail"),
            cache_root.join("flectar-mail"),
        ))
    }

    pub fn new(data_dir: PathBuf, cache_dir: PathBuf) -> Self {
        Self {
            data_dir,
            cache_dir,
        }
    }
    pub fn for_tests(root: &std::path::Path) -> Self {
        Self::new(root.to_path_buf(), root.join("cache"))
    }

    pub fn db_file(&self) -> PathBuf {
        self.data_dir.join("flectar-mail.db")
    }

    /// Calendar data lives in its own SQLite database so large mailbox writes,
    /// FTS maintenance, and mail backfills never contend with calendar reads or
    /// sync bookkeeping.
    pub fn calendar_db_file(&self) -> PathBuf {
        self.data_dir.join("flectar-calendar.db")
    }

    pub fn files_db_file(&self) -> PathBuf {
        self.data_dir.join("flectar-files.db")
    }

    /// Which keyring service holds this profile's secrets, on desktops.
    pub fn keyring_file(&self) -> PathBuf {
        self.data_dir.join("keyring.json")
    }
    pub fn files_cache_dir(&self, account_id: i64) -> PathBuf {
        self.cache_dir.join("files").join(account_id.to_string())
    }
    pub fn files_staging_dir(&self, account_id: i64) -> PathBuf {
        self.data_dir
            .join("file_transfers")
            .join(account_id.to_string())
    }

    /// Small, reconstructable projection of the last visible mailbox page.
    /// The native shell may paint this before the databases finish opening;
    /// SQLite remains authoritative and replaces it during normal startup.
    pub fn warm_start_file(&self) -> PathBuf {
        self.cache_dir.join("warm-start-mailbox.json")
    }

    /// Superseded reconstructable caches that can be removed without reading.
    ///
    /// TODO(warm-start-v2-cleanup): After the first public release using the
    /// stable `warm-start-mailbox.json` filename has been superseded by a later
    /// release, remove this method, its startup cleanup loop, and the matching
    /// path test. Keeping it longer is harmless; removing it sooner only leaves
    /// the old, unread v2 cache orphaned on direct upgrades from older builds.
    pub fn obsolete_warm_start_files(&self) -> [PathBuf; 1] {
        [self.cache_dir.join("warm-start-mailbox-v2.json")]
    }

    /// Directory holding every account's [`Self::mail_dir`].
    pub fn mail_root(&self) -> PathBuf {
        self.data_dir.join("mail")
    }

    /// Directory for raw .eml files of one account.
    ///
    /// Files are not kept directly in here: `mail_file` puts each in a shard
    /// one level down, so a mailbox with tens of thousands of messages never
    /// makes a directory whose entries a backup, a virus scan or Explorer has
    /// to walk in one go.
    pub fn mail_dir(&self, account_id: i64) -> PathBuf {
        self.mail_root().join(account_id.to_string())
    }

    /// The shard directory a stored message file belongs in: the first two
    /// characters of its name, which is random hex, so the shards stay even.
    pub fn mail_shard(&self, account_id: i64, name: &str) -> PathBuf {
        self.mail_dir(account_id).join(shard_of(name))
    }

    /// Where a message file called `name` lives, inside its account's shard.
    pub fn mail_file(&self, account_id: i64, name: &str) -> PathBuf {
        self.mail_shard(account_id, name).join(name)
    }

    /// The shard a file that sits directly in the account directory belongs
    /// in. Used by the one-time layout migration.
    pub fn shard_for_flat_file(&self, account_id: i64, path: &std::path::Path) -> Option<PathBuf> {
        let name = path.file_name()?.to_str()?;
        Some(self.mail_file(account_id, name))
    }

    /// Directory for the raw messages being copied or moved to another
    /// account.
    pub fn transfers_dir(&self) -> PathBuf {
        self.data_dir.join("transfers")
    }

    /// Directory for extracted attachment files.
    pub fn attachments_dir(&self, account_id: i64) -> PathBuf {
        self.cache_dir
            .join("attachments")
            .join(account_id.to_string())
    }

    /// Root for app-managed copies of outgoing (draft) attachments. Files
    /// picked in the composer are staged here so dispatch only ever reads
    /// files the app itself wrote, never an arbitrary caller-supplied path.
    pub fn draft_attachments_dir(&self) -> PathBuf {
        self.data_dir.join("draft_attachments")
    }

    /// Directory holding local embedding-model weights (`<models_dir>/<key>`).
    pub fn models_dir(&self) -> PathBuf {
        self.cache_dir.join("models")
    }

    pub fn temp_dir(&self) -> PathBuf {
        self.cache_dir.join("tmp")
    }

    pub fn ensure(&self) -> std::io::Result<()> {
        for directory in [
            &self.data_dir,
            &self.cache_dir,
            &self.mail_root(),
            &self.draft_attachments_dir(),
            &self.temp_dir(),
        ] {
            std::fs::create_dir_all(directory)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.data_dir, std::fs::Permissions::from_mode(0o700))?;
            std::fs::set_permissions(&self.cache_dir, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_mail_files_live_in_a_shard_named_by_their_prefix() {
        let root = std::path::Path::new("/private/app");
        let paths = Paths::new(root.join("data"), root.join("cache"));
        let name = "0123456789abcdef0123456789abcdef.eml";

        assert_eq!(
            paths.mail_file(7, name),
            root.join("data/mail/7/01").join(name)
        );
        // Stable: the migration and the writers must agree about the shard.
        assert_eq!(paths.mail_file(7, name), paths.mail_file(7, name));
        // Names that don't start with hex still land in one of the 256 buckets.
        let other = paths.mail_file(7, "draft-1.outgoing.eml");
        assert_eq!(other.parent().unwrap().file_name().unwrap().len(), 2);
    }

    #[test]
    fn platform_paths_separate_durable_and_reconstructable_state() {
        let root = std::path::Path::new("/private/app");
        let paths = Paths::new(root.join("data"), root.join("cache"));

        assert_eq!(paths.db_file(), root.join("data/flectar-mail.db"));
        assert_eq!(
            paths.calendar_db_file(),
            root.join("data/flectar-calendar.db")
        );
        assert_eq!(
            paths.warm_start_file(),
            root.join("cache/warm-start-mailbox.json")
        );
        assert_eq!(
            paths.obsolete_warm_start_files(),
            [root.join("cache/warm-start-mailbox-v2.json")]
        );
        assert_eq!(paths.mail_dir(7), root.join("data/mail/7"));
        assert_eq!(
            paths.draft_attachments_dir(),
            root.join("data/draft_attachments")
        );
        assert_eq!(paths.attachments_dir(7), root.join("cache/attachments/7"));
        assert_eq!(paths.temp_dir(), root.join("cache/tmp"));
    }
}
