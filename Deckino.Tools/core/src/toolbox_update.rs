use std::path::Path;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use anyhow::{Result, anyhow};
use tokio_util::sync::CancellationToken;
use velopack::bundle::Manifest;
use velopack::sources::UpdateSource;
use velopack::{UpdateCheck, UpdateManager, VelopackAsset, VelopackAssetFeed};

pub use velopack::UpdateInfo;

use crate::credentials::DpapiSyncCredentialStore;
use crate::object_store::RailwayS3ObjectStore;

// The Toolbox updates itself from the dataset bucket. The publish script packs each release with Velopack and uploads
// it under toolbox/ (the feed the C# Toolbox used, so its installs updated into this one); an installed Toolbox checks
// there with the bucket connection saved on Dataset Sync, and the sidebar's update button downloads the release and then
// restarts into it. A downloaded update that was not restarted into installs at the next start (Velopack's auto-apply
// on startup, VelopackApp in main). A development build (not installed) never checks.
pub struct ToolboxUpdateService {
    credentials: Arc<DpapiSyncCredentialStore>,
    /// Err: not installed (a development build), with Velopack's reason.
    manager: std::result::Result<UpdateManager, String>,
    /// The running download's token, which the bucket source reads.
    cancel: Arc<Mutex<CancellationToken>>,
}

impl ToolboxUpdateService {
    pub const PREFIX: &str = "toolbox/";

    pub fn new(credentials: Arc<DpapiSyncCredentialStore>) -> Self {
        let cancel = Arc::new(Mutex::new(CancellationToken::new()));
        let source = BucketSource { credentials: credentials.clone(), cancel: cancel.clone() };
        let manager = UpdateManager::new(source, None, None).map_err(|error| error.to_string());
        Self { credentials, manager, cancel }
    }

    pub fn is_installed(&self) -> bool {
        self.manager.is_ok()
    }

    pub fn current_version(&self) -> String {
        match &self.manager {
            Ok(manager) => format!("v{}", manager.get_current_version_as_string()),
            Err(_) => format!("v{}", env!("CARGO_PKG_VERSION")),
        }
    }

    pub fn is_bucket_connected(&self) -> bool {
        self.credentials.load().is_some()
    }

    fn manager(&self) -> Result<UpdateManager> {
        self.manager.clone().map_err(|reason| anyhow!("This application is not properly installed: {reason}"))
    }

    /// The newest release in the bucket when it is newer than this one.
    pub async fn check(&self) -> Result<Option<UpdateInfo>> {
        let manager = self.manager()?;
        let check = tokio::task::spawn_blocking(move || manager.check_for_updates()).await??;
        Ok(match check {
            UpdateCheck::UpdateAvailable(update) => Some(*update),
            UpdateCheck::RemoteIsEmpty | UpdateCheck::NoUpdateAvailable => None,
        })
    }

    pub async fn download(
        &self,
        update: &UpdateInfo,
        report_percent: &(dyn Fn(i32) + Send + Sync),
        cancel: &CancellationToken,
    ) -> Result<()> {
        let manager = self.manager()?;
        *self.cancel.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = cancel.clone();
        let (sender, receiver) = std::sync::mpsc::channel::<i16>();
        let (forward, mut percents) = tokio::sync::mpsc::unbounded_channel::<i16>();
        // Velopack reports on a std channel; it closes when the download ends and drops the sender.
        let relay = tokio::task::spawn_blocking(move || {
            while let Ok(percent) = receiver.recv() {
                let _ = forward.send(percent);
            }
        });
        let update = update.clone();
        let download = tokio::task::spawn_blocking(move || manager.download_updates(&update, Some(sender)));
        while let Some(percent) = percents.recv().await {
            report_percent(percent as i32);
        }
        relay.await?;
        download.await??;
        Ok(())
    }

    /// Installs the downloaded update and starts the new version once the Toolbox has quit. The caller quits it the
    /// normal way, so the window's shutdown stops the Python helpers, which would otherwise hold the install folder.
    pub fn install_after_exit(&self, update: &UpdateInfo) -> Result<()> {
        self.manager()?.wait_exit_then_apply_updates(&update.TargetFullRelease, false, true, Vec::<String>::new())?;
        Ok(())
    }
}

// The release feed and packages, read with the bucket connection instead of a public URL: the bucket is private.
// Velopack calls these synchronously, from the blocking threads the service runs it on.
struct BucketSource {
    credentials: Arc<DpapiSyncCredentialStore>,
    cancel: Arc<Mutex<CancellationToken>>,
}

impl BucketSource {
    fn download(
        &self,
        name: &str,
        destination: &Path,
        report_percent: &(dyn Fn(i32) + Sync),
        cancel: &CancellationToken,
    ) -> Result<()> {
        let store = RailwayS3ObjectStore::connect(&self.credentials)?;
        let key = format!("{}{name}", ToolboxUpdateService::PREFIX);
        tokio::runtime::Handle::try_current()?.block_on(store.download_with_progress(
            &key,
            destination,
            report_percent,
            cancel,
        ))
    }
}

fn velopack_error(error: anyhow::Error) -> velopack::Error {
    velopack::Error::Other(format!("{error:#}"))
}

impl UpdateSource for BucketSource {
    fn get_release_feed(
        &self,
        channel: &str,
        _app: &Manifest,
        _staged_user_id: &str,
    ) -> std::result::Result<VelopackAssetFeed, velopack::Error> {
        let feed = std::env::temp_dir().join(format!("deckino-tools-feed-{}.json", uuid::Uuid::new_v4().simple()));
        // Never the download's token (CancellationToken.None in the C# Toolbox): a cancelled download must not fail
        // every later check.
        let result = self
            .download(&format!("releases.{channel}.json"), &feed, &|_| {}, &CancellationToken::new())
            .map_err(velopack_error)
            .and_then(|_| Ok(serde_json::from_str(&std::fs::read_to_string(&feed)?)?));
        let _ = std::fs::remove_file(&feed);
        result
    }

    fn download_release_entry(
        &self,
        asset: &VelopackAsset,
        local_file: &Path,
        progress_sender: Option<Sender<i16>>,
    ) -> std::result::Result<(), velopack::Error> {
        let report = |percent: i32| {
            if let Some(sender) = &progress_sender {
                let _ = sender.send(percent as i16);
            }
        };
        let cancel = self.cancel.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        self.download(&asset.FileName, local_file, &report, &cancel).map_err(velopack_error)
    }
}
