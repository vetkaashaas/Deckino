use std::path::PathBuf;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};

/// The Railway bucket connection, saved on Dataset Sync. PascalCase on disk: the C# Toolbox's file.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct DatasetSyncCredentials {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub force_path_style: bool,
    pub access_key_id: String,
    pub secret_access_key: String,
}

impl DatasetSyncCredentials {
    pub fn is_complete(&self) -> bool {
        reqwest::Url::parse(&self.endpoint).is_ok()
            && !self.bucket.trim().is_empty()
            && !self.region.trim().is_empty()
            && !self.access_key_id.trim().is_empty()
            && !self.secret_access_key.trim().is_empty()
    }
}

const ENTROPY: &[u8] = b"Deckino.CameraDatasetSync.v1";

/// The connection encrypted for this Windows user (DPAPI, CurrentUser), in the same file and format as the C# Toolbox.
pub struct DpapiSyncCredentialStore {
    path: PathBuf,
}

impl DpapiSyncCredentialStore {
    /// `path`: None for the usual %LocalAppData%\Deckino\dataset-sync.credentials.
    pub fn new(path: Option<PathBuf>) -> Self {
        let path =
            path.unwrap_or_else(|| crate::paths::local_app_data().join("Deckino").join("dataset-sync.credentials"));
        Self { path }
    }

    pub fn load(&self) -> Option<DatasetSyncCredentials> {
        let encrypted = std::fs::read(&self.path).ok()?;
        let clear = unprotect(&encrypted).ok()?;
        serde_json::from_slice(&clear).ok()
    }

    pub fn save(&self, credentials: &DatasetSyncCredentials) -> Result<()> {
        if !credentials.is_complete() {
            bail!("The dataset sync credentials are incomplete.");
        }
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let encrypted = protect(&serde_json::to_vec(credentials)?)?;
        let temporary = self.path.with_extension(format!("credentials.tmp-{}", uuid::Uuid::new_v4().simple()));
        std::fs::write(&temporary, encrypted)?;
        let moved = std::fs::rename(&temporary, &self.path);
        let _ = std::fs::remove_file(&temporary);
        Ok(moved?)
    }
}

fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 }
}

fn take(output: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    unsafe {
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as _)));
        bytes
    }
}

fn protect(clear: &[u8]) -> Result<Vec<u8>> {
    let (input, entropy) = (blob(clear), blob(ENTROPY));
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)?;
    }
    Ok(take(output))
}

fn unprotect(encrypted: &[u8]) -> Result<Vec<u8>> {
    let (input, entropy) = (blob(encrypted), blob(ENTROPY));
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)?;
    }
    Ok(take(output))
}
