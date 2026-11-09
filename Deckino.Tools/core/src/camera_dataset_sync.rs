//! CameraDatasetSyncModels.cs: what the camera dataset sync reports. The credentials live in `credentials.rs`, the
//! bucket and its objects in `object_store.rs`.
use std::path::PathBuf;

use chrono::{DateTime, Utc};

/// A file changed on both sides since the last sync: the remote copy waits beside the local one for review.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DatasetSyncConflict {
    pub object_key: String,
    pub relative_path: String,
    pub remote_copy_path: PathBuf,
    pub local_sha256: String,
    pub remote_sha256: String,
    pub created_utc: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DatasetSyncSnapshot {
    pub is_configured: bool,
    pub is_running: bool,
    pub local_files: usize,
    pub remote_files: usize,
    pub pending_uploads: usize,
    pub failed_operations: usize,
    pub conflict_count: usize,
    pub last_successful_sync_utc: Option<DateTime<Utc>>,
    pub status: String,
}

impl DatasetSyncSnapshot {
    pub fn safe_to_switch(&self) -> bool {
        self.is_configured
            && !self.is_running
            && self.pending_uploads == 0
            && self.failed_operations == 0
            && self.conflict_count == 0
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DatasetSyncResult {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted: usize,
    pub conflicts: usize,
    pub errors: Vec<String>,
}
