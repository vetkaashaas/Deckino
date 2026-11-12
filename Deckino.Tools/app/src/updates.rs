//! The sidebar's footer work (the C# ShellViewModel): from the first window on, look for a Toolbox update now and
//! every minute (the training PC stays open for days), and once share the newest finished training runs the bucket
//! doesn't have yet. The update button's first click downloads; the second restarts into the new version.

use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use deckino_core::services::Services;
use deckino_core::toolbox_update::UpdateInfo;
use futures::StreamExt;
use gpui_kit::*;
use tokio_util::sync::CancellationToken;

use crate::rt;
use crate::shell::UpdateStatus;

const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(60);

pub struct Updates {
    services: Arc<Services>,
    status: Entity<UpdateStatus>,
    update: Option<UpdateInfo>,
    check_failed: bool, // logs the first failed check only, not one a minute while offline
    downloaded: bool,
    downloading: bool,
}

fn version(update: &UpdateInfo) -> String {
    update.TargetFullRelease.Version.to_string()
}

impl Updates {
    pub fn start(services: Arc<Services>, status: Entity<UpdateStatus>, cx: &mut App) -> Entity<Updates> {
        let updates = cx.new(|_| Updates {
            services,
            status,
            update: None,
            check_failed: false,
            downloaded: false,
            downloading: false,
        });
        let weak = updates.downgrade();
        updates.update(cx, |this, cx| {
            this.status.update(cx, |status, _| {
                status.on_click = Some(Rc::new(move |_, cx| {
                    let _ = weak.update(cx, |this, cx| this.click(cx));
                }));
            });
        });
        let entity = updates.clone();
        cx.spawn(async move |cx| {
            Self::check(&entity, cx).await;
            let services = entity.read_with(cx, |this, _| this.services.clone());
            let runs = services.clone();
            // Runs deleted on another PC go first: this PC might otherwise upload one of them again.
            match rt::spawn(async move { runs.training_run_sync.apply_deletions(&CancellationToken::new()).await })
                .await
            {
                Ok(versions) => {
                    for version in versions {
                        services
                            .log
                            .information("training-runs", &format!("Deleted {version}: deleted on another PC."));
                    }
                }
                Err(error) => services.log.error(
                    "training-runs",
                    "Deleting runs deleted on another PC failed; the next start tries again.",
                    Some(&error),
                ),
            }
            let runs = services.clone();
            match rt::spawn(async move { runs.training_run_sync.upload_missing(&CancellationToken::new()).await }).await
            {
                Ok(versions) => {
                    for version in versions {
                        services.log.information("training-runs", &format!("Uploaded {version} to the bucket."));
                    }
                }
                Err(error) => services.log.error(
                    "training-runs",
                    "Uploading the newest training runs failed; the next start tries again.",
                    Some(&error),
                ),
            }
            if !services.toolbox_update.is_installed() {
                return;
            }
            loop {
                cx.background_executor().timer(UPDATE_CHECK_INTERVAL).await;
                Self::check(&entity, cx).await;
            }
        })
        .detach();
        updates
    }

    fn set(&self, cx: &mut App, edit: impl FnOnce(&mut UpdateStatus)) {
        self.status.update(cx, |status, cx| {
            edit(status);
            cx.notify();
        });
    }

    async fn check(entity: &Entity<Updates>, cx: &mut AsyncApp) {
        let services = entity.read_with(cx, |this, _| this.services.clone());
        let updates = &services.toolbox_update;
        if !updates.is_installed() {
            entity.update(cx, |this, cx| this.set(cx, |status| status.version_status = "Development build".into()));
            return;
        }
        if entity.read_with(cx, |this, _| this.update.is_some()) {
            return; // the button already offers it
        }
        let current = updates.current_version();
        if !updates.is_bucket_connected() {
            entity.update(cx, |this, cx| {
                this.set(cx, |status| {
                    status.version_status = format!("{current} · connect the bucket for updates").into()
                })
            });
            return;
        }
        let checker = services.clone();
        let result = rt::spawn(async move { checker.toolbox_update.check().await }).await;
        entity.update(cx, |this, cx| match result {
            Ok(update) => {
                this.check_failed = false;
                let text = update.as_ref().map(|update| format!("Update to v{}", version(update)));
                this.update = update;
                this.set(cx, |status| {
                    status.version_status = current.clone().into();
                    if let Some(text) = text {
                        status.button_text = Some(text.into());
                        status.button_enabled = true;
                    }
                });
            }
            Err(error) => {
                if !this.check_failed {
                    this.services.log.error(
                        "update",
                        "Toolbox update check failed; it retries every minute.",
                        Some(&error),
                    );
                }
                this.check_failed = true;
                this.set(cx, |status| {
                    status.version_status = format!("{current} · update check failed; see the log").into()
                });
            }
        });
    }

    fn click(&mut self, cx: &mut Context<Self>) {
        let Some(update) = self.update.clone() else {
            return;
        };
        // Downloading, or asking whether to restart: one at a time.
        if self.downloading {
            return;
        }
        let current = self.services.toolbox_update.current_version();
        if self.downloaded {
            // A restart would kill a training run or import; the update still installs at the next start.
            if self.services.coordinator.is_busy() {
                self.set(cx, |status| {
                    status.version_status = format!("{current} · finish or cancel the running job, then restart").into()
                });
                return;
            }
            // A restart closes the window, so it asks what closing asks (remove_window skips the close handler).
            match crate::ask_before_closing(&self.services, cx) {
                None => self.restart(&update, cx),
                Some(answer) => {
                    self.downloading = true;
                    cx.spawn(async move |this, cx| {
                        let accepted = answer.await.unwrap_or(false);
                        let _ = this.update(cx, |this, cx| {
                            this.downloading = false;
                            if accepted {
                                this.restart(&update, cx);
                            }
                        });
                    })
                    .detach();
                }
            }
            return;
        }
        self.downloading = true;
        self.set(cx, |status| {
            status.button_text = Some("Downloading 0%".into());
            status.button_enabled = false;
        });
        let services = self.services.clone();
        let (progress, mut percents) = rt::channel::<i32>();
        let target = update.clone();
        let download = rt::spawn(async move {
            services
                .toolbox_update
                .download(
                    &target,
                    &move |percent| {
                        let _ = progress.unbounded_send(percent);
                    },
                    &CancellationToken::new(),
                )
                .await
        });
        cx.spawn(async move |this, cx| {
            while let Some(percent) = percents.next().await {
                let _ = this.update(cx, |this, cx| {
                    this.set(cx, |status| status.button_text = Some(format!("Downloading {percent}%").into()))
                });
            }
            let result = download.await;
            let _ = this.update(cx, |this, cx| {
                this.downloading = false;
                match result {
                    Ok(()) => {
                        this.downloaded = true;
                        this.set(cx, |status| {
                            status.button_text = Some("Restart to update".into());
                            status.button_enabled = true;
                            status.version_status = format!("{current} · or it installs at the next start").into();
                        });
                    }
                    Err(error) => {
                        this.services.log.error("update", "Downloading the Toolbox update failed.", Some(&error));
                        this.set(cx, |status| {
                            status.button_text = Some(format!("Update to v{}", version(&update)).into());
                            status.button_enabled = true;
                            status.version_status = format!("{current} · download failed; see the log").into();
                        });
                    }
                }
            });
        })
        .detach();
    }

    fn restart(&mut self, update: &UpdateInfo, cx: &mut Context<Self>) {
        self.services.log.information("update", &format!("Restarting into v{}.", version(update)));
        if let Err(error) = self.services.toolbox_update.install_after_exit(update) {
            self.services.log.error("update", "Starting the update failed.", Some(&error));
            return;
        }
        // The Python helpers would otherwise hold the install folder (remove_window skips the close handler).
        crate::stop_services(&self.services);
        // Deferred: this runs inside the window's own click, and GPUI can't update a window mid-dispatch.
        cx.defer(|cx| {
            for window in cx.windows() {
                let _ = window.update(cx, |_, window, _| window.remove_window());
            }
        });
    }
}
