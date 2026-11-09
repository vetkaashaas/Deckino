use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Utc;

/// The Toolbox's own log: one file a day in the training logs folder.
pub struct ApplicationLogService {
    pub logs_root: PathBuf,
    pub current_log_path: PathBuf,
    write_lock: Mutex<()>,
}

impl ApplicationLogService {
    pub fn new(logs_root: impl Into<PathBuf>) -> Self {
        let logs_root = logs_root.into();
        let current_log_path = logs_root.join(format!("deckino-tools-{}.log", Utc::now().format("%Y%m%d")));
        Self { logs_root, current_log_path, write_lock: Mutex::new(()) }
    }

    pub fn information(&self, area: &str, message: &str) {
        self.write("INFO", area, message);
    }

    pub fn error(&self, area: &str, message: &str, error: Option<&anyhow::Error>) {
        match error {
            Some(error) => self.write("ERROR", area, &format!("{message}\r\n{error:?}")),
            None => self.write("ERROR", area, message),
        }
    }

    pub fn clear_current_log(&self) {
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let _ = std::fs::create_dir_all(&self.logs_root);
        let _ = std::fs::write(&self.current_log_path, "");
    }

    // Logging must never prevent the application from opening or shutting down.
    fn write(&self, level: &str, area: &str, message: &str) {
        let entry = format!("[{}] [{level}] [{area}] {message}\r\n", Utc::now().to_rfc3339());
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let _ = std::fs::create_dir_all(&self.logs_root);
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&self.current_log_path) {
            let _ = file.write_all(entry.as_bytes());
        }
    }
}
