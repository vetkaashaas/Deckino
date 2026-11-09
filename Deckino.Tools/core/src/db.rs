use std::path::{Path, PathBuf};

use anyhow::Result;
use rusqlite::Connection;

/// The schema, shared with the C# Toolbox: the same files, so both open the same database.
const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../schema/001_baseline.sql")),
    (2, include_str!("../schema/002_sync_state.sql")),
    (3, include_str!("../schema/003_oracle_identity.sql")),
    (4, include_str!("../schema/004_paper_availability.sql")),
    (5, include_str!("../schema/005_artwork_identity.sql")),
    (6, include_str!("../schema/006_extraction_assets.sql")),
    (7, include_str!("../schema/007_card_images.sql")),
];

#[derive(Clone, Debug)]
pub struct Database {
    path: PathBuf,
}

impl Database {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn default_path() -> PathBuf {
        crate::paths::resolve_data_root().join("deckino.db")
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn initialize(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut connection = self.open()?;
        connection.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)", [])?;
        let current: i64 =
            connection.query_row("SELECT COALESCE(MAX(version), 0) FROM schema_version", [], |row| row.get(0))?;
        for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version > current) {
            let transaction = connection.transaction()?;
            transaction.execute_batch(sql)?;
            transaction.execute("INSERT INTO schema_version (version) VALUES (?1)", [version])?;
            transaction.commit()?;
        }
        Ok(())
    }

    pub fn open(&self) -> Result<Connection> {
        let connection = Connection::open(&self.path)?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;")?;
        Ok(connection)
    }
}
