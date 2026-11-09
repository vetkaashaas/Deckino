use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct SyncOptions {
    pub data_root: PathBuf,
    // Image downloads are latency-bound (about a second each from Scryfall's CDN), so many run at once:
    // measured ~25 images/s at 32, ~50 at 64 and ~90 at 128, where 56k faces take about 10 minutes.
    pub image_concurrency: usize,
    pub request_interval_ms: u64,
    pub import_batch_size: usize,
}

impl SyncOptions {
    pub fn new(data_root: impl Into<PathBuf>) -> Self {
        Self { data_root: data_root.into(), image_concurrency: 128, request_interval_ms: 60, import_batch_size: 500 }
    }

    pub fn bulk_directory(&self) -> PathBuf {
        self.data_root.join("bulk")
    }
}
