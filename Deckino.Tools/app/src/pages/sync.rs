//! Scryfall Sync (the C# SyncViewModel and Sync.tsx): keeps the local Scryfall catalogue current and caches the
//! full-card image of every paper face.

use deckino_core::n0;
use std::future::Future;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use anyhow::Result;
use deckino_core::bulk_data_sync::{BulkSyncPhase, BulkSyncStatus, round_trip_utc};
use deckino_core::card_images::{CardImageCacheStatus, CardImageProgress, CardImageReconcileStatus};
use deckino_core::error::{check, is_cancelled};
use deckino_core::services::Services;
use futures::StreamExt;
use futures::channel::mpsc::UnboundedSender;
use gpui_kit::component::Disableable;
use gpui_kit::component::progress::Progress;
use gpui_kit::*;
use tokio_util::sync::CancellationToken;

use crate::events;
use crate::rt;
use crate::shell::PageEntry;
use crate::ui::{self, IconName, LogView, Tone};

const DISPLAY_NAME: &str = "Scryfall Sync";
const DESCRIPTION: &str =
    "Keeps the local Scryfall catalogue current and caches the full-card image of every paper face.";
const MAXIMUM_LOG_LINES: usize = 400;
// Failures logged by name per run; a lost connection fails thousands, which the run summary counts instead.
const LOGGED_FAILURES: i64 = 100;

// ProductionStageStatus, as ui::status_tone reads it.
const PENDING: &str = "Pending";
const RUNNING: &str = "Running";
const PASSED: &str = "Passed";
const WARNING: &str = "Warning";
const FAILED: &str = "Failed";
const CANCELLED: &str = "Cancelled";

const CHECK: usize = 0;
const DOWNLOAD: usize = 1;
const IMPORT: usize = 2;
const RECONCILE: usize = 3;
const IMAGES: usize = 4;

pub fn entry(services: Arc<Services>, _window: &mut Window, cx: &mut App) -> PageEntry {
    let view = cx.new(|cx| SyncPage::new(services, cx));
    let page = view.clone();
    PageEntry {
        key: "sync",
        name: "Scryfall Sync".into(),
        icon: IconName::CloudDownload,
        view: view.into(),
        opened: Some(Rc::new(move |_, cx| page.update(cx, |page, cx| page.refresh(cx)))),
        left: None,
    }
}

/// One step of a Scryfall sync: its state, a one-line result, its own progress and how long it took.
struct SyncStage {
    name: &'static str,
    status: &'static str,
    detail: String,
    duration: String,
    // Below zero while the stage runs without a measurable total; the bar is hidden then.
    progress_percent: f64,
    elapsed: Duration,
    running_since: Option<Instant>,
}

impl SyncStage {
    fn new(name: &'static str) -> Self {
        Self {
            name,
            status: PENDING,
            detail: "Waiting".into(),
            duration: String::new(),
            progress_percent: -1.,
            elapsed: Duration::ZERO,
            running_since: None,
        }
    }

    fn reset(&mut self) {
        *self = Self::new(self.name);
    }

    // A stage can run more than once in a sync (two bulk files are downloaded and imported in turn), so its clock
    // keeps adding up until the next reset.
    fn start(&mut self, detail: impl Into<String>) {
        if self.status == RUNNING {
            return;
        }
        self.running_since = Some(Instant::now());
        self.status = RUNNING;
        self.detail = detail.into();
        self.progress_percent = -1.;
    }

    fn finish(&mut self, status: &'static str, detail: impl Into<String>) {
        if let Some(since) = self.running_since.take() {
            self.elapsed += since.elapsed();
        }
        self.status = status;
        self.detail = detail.into();
        self.duration = if self.elapsed > Duration::ZERO { format_duration(self.elapsed) } else { String::new() };
    }

    fn view(&self) -> ui::Stage {
        ui::Stage {
            id: None,
            name: self.name.into(),
            status: self.status.into(),
            detail: self.detail.clone().into(),
            duration: (!self.duration.is_empty()).then(|| self.duration.clone().into()),
            progress_percent: (self.progress_percent >= 0.).then_some(self.progress_percent as f32),
            shows_progress: self.status == RUNNING && self.progress_percent >= 0.,
        }
    }
}

pub struct SyncPage {
    services: Arc<Services>,
    stages: [SyncStage; 5],
    log: Entity<LogView>,
    busy: bool,
    active_run: Option<CancellationToken>,
    checked_freshness: bool,
    freshness_text: String,
    freshness_tone: Tone,
    status: String,
    last_run_text: String,
    error_message: String,
    error_detail: Option<String>,
    printings: String,
    oracle_cards: String,
    sets: String,
    images_cached: String,
    images_caption: String,
    images_percent: f64,
    images_failed: String,
    disk_used: String,
    // Shows Retry failed in the header while failed faces wait for another attempt.
    has_failures: bool,
    failures_logged: i64,
}

/// What the database said on a refresh of the counts.
struct Counts {
    catalogue: (i64, i64, i64),
    cache: CardImageCacheStatus,
    /// The newest sync_state.synced_at and its age in seconds, when asked for.
    synced: Option<(Option<String>, Option<f64>)>,
}

impl SyncPage {
    fn new(services: Arc<Services>, cx: &mut Context<Self>) -> Self {
        let logs_root = services.log.logs_root.clone();
        Self {
            services,
            stages: [
                SyncStage::new("Check Scryfall"),
                SyncStage::new("Download bulk files"),
                SyncStage::new("Import catalogue"),
                SyncStage::new("Prepare image cache"),
                SyncStage::new("Download card images"),
            ],
            log: cx.new(|_| LogView::new("Activity log", Some(logs_root)).bounded(MAXIMUM_LOG_LINES)),
            busy: false,
            active_run: None,
            checked_freshness: false,
            freshness_text: "Not checked".into(),
            freshness_tone: Tone::Neutral,
            status: "Ready.".into(),
            last_run_text: "No sync has run on this computer yet.".into(),
            error_message: String::new(),
            error_detail: None,
            printings: "—".into(),
            oracle_cards: "—".into(),
            sets: "—".into(),
            images_cached: "—".into(),
            images_caption: String::new(),
            images_percent: 0.,
            images_failed: "—".into(),
            disk_used: "—".into(),
            has_failures: false,
            failures_logged: 0,
        }
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let refreshed = async {
                Self::refresh_counts(&this, cx).await?;
                Self::refresh_last_run(&this, cx).await
            }
            .await;
            if let Err(error) = refreshed {
                this.update(cx, |page, cx| events::report_error(cx, &page.services.log, "sync.refresh", &error))?;
                return Ok(());
            }
            let check_now = this.update(cx, |page, _| {
                let check_now = !page.checked_freshness && !page.busy;
                page.checked_freshness |= check_now;
                check_now
            })?;
            if !check_now {
                return anyhow::Ok(());
            }
            if let Err(error) = Self::check_freshness(&this, cx).await {
                // Offline or an unreadable reply: the local sync date still shows; Sync now checks again.
                this.update(cx, |page, _| {
                    page.services
                        .log
                        .information("scryfall-sync", &format!("Automatic freshness check failed: {error:#}"))
                })?;
            }
            Ok(())
        })
        .detach();
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        self.run("Scryfall sync", true, false, cx);
    }

    fn retry_failed(&mut self, cx: &mut Context<Self>) {
        self.run("Image retry", false, true, cx);
    }

    fn cancel(&mut self, cx: &mut Context<Self>) {
        if let Some(run) = &self.active_run {
            run.cancel();
        }
        self.status = "Cancelling…".into();
        cx.notify();
    }

    fn copy_error(&mut self, cx: &mut Context<Self>) {
        if let Some(detail) = self.error_detail.clone().filter(|detail| !detail.trim().is_empty()) {
            events::copy_text(cx, detail);
        }
    }

    fn dismiss_error(&mut self, cx: &mut Context<Self>) {
        self.error_message.clear();
        cx.notify();
    }

    fn run(&mut self, operation: &'static str, include_catalogue: bool, retry_failed: bool, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let cancel = CancellationToken::new();
        self.active_run = Some(cancel.clone());
        self.busy = true;
        self.error_message.clear();
        for stage in &mut self.stages {
            stage.reset();
        }
        let started = SystemTime::now();
        let clock = Instant::now();
        self.append_log(format!("{operation} started."), true, cx);
        cx.notify();
        cx.spawn(async move |this, cx| {
            let mut summary = Vec::new();
            let result =
                Self::run_steps(&this, cx, operation, include_catalogue, retry_failed, &cancel, &mut summary).await;
            let outcome = this.update(cx, |page, cx| {
                let outcome = match result {
                    Ok(()) => {
                        page.status = summary.join(" ");
                        "passed"
                    }
                    Err(error) if is_cancelled(&error) && cancel.is_cancelled() => {
                        page.cancel_running_stages();
                        page.status = "Cancelled. Everything finished so far is kept; the next sync picks up where \
                                       this one stopped."
                            .into();
                        summary.push("Cancelled.".into());
                        "cancelled"
                    }
                    Err(error) => {
                        let running = page.stages.iter_mut().find(|stage| stage.status == RUNNING);
                        let title = match running {
                            Some(stage) => {
                                stage.finish(FAILED, format!("{error:#}"));
                                format!("{} failed", stage.name)
                            }
                            None => format!("{operation} failed"),
                        };
                        page.cancel_running_stages();
                        page.show_error(&title, &error, cx);
                        summary.push(format!("Failed: {error:#}"));
                        "failed"
                    }
                };
                page.active_run = None;
                page.busy = false;
                page.append_log(format!("{operation} {outcome} after {}.", format_duration(clock.elapsed())), true, cx);
                cx.notify();
                outcome
            })?;
            let recorded = async {
                Self::refresh_counts(&this, cx).await?;
                Self::record_run(&this, cx, started, outcome, summary.join(" ")).await
            }
            .await;
            if let Err(error) = recorded {
                // The run itself is over; only its record or the refreshed counts are missing.
                this.update(cx, |page, cx| page.show_error("Could not record the sync run", &error, cx))?;
            }
            anyhow::Ok(())
        })
        .detach();
    }

    async fn run_steps(
        this: &WeakEntity<Self>,
        cx: &mut AsyncApp,
        operation: &str,
        include_catalogue: bool,
        retry_failed: bool,
        cancel: &CancellationToken,
        summary: &mut Vec<String>,
    ) -> Result<()> {
        let services = this.read_with(cx, |page, _| page.services.clone())?;
        let _lease = services.coordinator.acquire(operation)?;
        if include_catalogue {
            summary.push(Self::run_catalogue(this, cx, &services, cancel).await?);
        } else {
            this.update(cx, |page, cx| {
                for index in [CHECK, DOWNLOAD, IMPORT] {
                    page.stages[index].finish(CANCELLED, "Not part of an image retry");
                }
                cx.notify();
            })?;
        }
        summary.push(Self::run_images(this, cx, &services, retry_failed, cancel).await?);
        Ok(())
    }

    async fn run_catalogue(
        this: &WeakEntity<Self>,
        cx: &mut AsyncApp,
        services: &Arc<Services>,
        cancel: &CancellationToken,
    ) -> Result<String> {
        let before = count_catalogue(services).await?;
        this.update(cx, |page, cx| {
            page.stages[CHECK].start("Asking Scryfall for its latest bulk files…");
            cx.notify();
        })?;
        let (sync, token) = (services.clone(), cancel.clone());
        let result = with_progress(
            this,
            cx,
            move |sender: UnboundedSender<BulkSyncStatus>| async move {
                let report = move |status: BulkSyncStatus| {
                    let _ = sender.unbounded_send(status);
                };
                sync.bulk_data_sync.sync_all(&report, &token).await
            },
            |page, status, _| page.show_bulk_status(status),
        )
        .await?;
        let after = count_catalogue(services).await?;

        let text = this.update(cx, |page, cx| {
            if page.stages[CHECK].status == RUNNING {
                page.stages[CHECK].finish(PASSED, "Already up to date");
            }
            let everything_current = result.cards_imported == 0 && result.oracle_cards_imported == 0;
            page.stages[DOWNLOAD].finish(
                PASSED,
                if everything_current {
                    "Skipped, nothing new on Scryfall".to_string()
                } else {
                    format!("Downloaded {}", plural(2 - result.skipped_up_to_date.len() as i64, "bulk file"))
                },
            );
            let changes = format!(
                "{} printings, {} oracle cards, {} sets",
                signed(after.0 - before.0),
                signed(after.1 - before.1),
                signed(after.2 - before.2)
            );
            page.stages[IMPORT].finish(
                PASSED,
                if everything_current {
                    "Skipped, the catalogue is current".to_string()
                } else {
                    format!(
                        "{changes} ({} printings and {} oracle cards read)",
                        n0(result.cards_imported as i64),
                        n0(result.oracle_cards_imported as i64)
                    )
                },
            );
            page.freshness_text = format!("Up to date · synced {}", describe_age(Some(0.)));
            page.freshness_tone = Tone::Success;
            page.checked_freshness = true;
            page.append_log(
                if everything_current {
                    "Catalogue already up to date.".to_string()
                } else {
                    format!("Catalogue imported: {changes}.")
                },
                true,
                cx,
            );
            cx.notify();
            if everything_current { "Catalogue up to date.".to_string() } else { format!("Catalogue: {changes}.") }
        })?;
        Self::refresh_counts(this, cx).await?;
        Ok(text)
    }

    async fn run_images(
        this: &WeakEntity<Self>,
        cx: &mut AsyncApp,
        services: &Arc<Services>,
        retry_failed: bool,
        cancel: &CancellationToken,
    ) -> Result<String> {
        this.update(cx, |page, cx| {
            page.stages[RECONCILE].start("Checking cached images against the catalogue…");
            cx.notify();
        })?;
        let (images, token) = (services.clone(), cancel.clone());
        let preparation = with_progress(
            this,
            cx,
            move |sender: UnboundedSender<CardImageReconcileStatus>| async move {
                let report = move |status: CardImageReconcileStatus| {
                    let _ = sender.unbounded_send(status);
                };
                images
                    .card_images
                    .prepare(retry_failed, Some(&report as &(dyn Fn(CardImageReconcileStatus) + Send + Sync)), &token)
                    .await
            },
            |page, status, _| {
                let stage = &mut page.stages[RECONCILE];
                stage.detail = format!(
                    "Checked {} / {} queued files on disk · {} already present",
                    n0(status.scanned),
                    n0(status.total),
                    n0(status.recovered)
                );
                stage.progress_percent =
                    if status.total == 0 { -1. } else { status.scanned as f64 * 100.0 / status.total as f64 };
            },
        )
        .await?;
        this.update(cx, |page, cx| {
            let mut notes = Vec::new();
            if preparation.files_removed > 0 {
                notes.push(format!(
                    "removed {} unused files ({})",
                    n0(preparation.files_removed),
                    format_bytes(preparation.bytes_removed)
                ));
                page.append_log(
                    format!(
                        "Removed {} unused files (old art crops, replaced or dropped card images): {}.",
                        n0(preparation.files_removed),
                        format_bytes(preparation.bytes_removed)
                    ),
                    true,
                    cx,
                );
            }
            if preparation.recovered > 0 {
                notes.push(format!("found {} already on disk", n0(preparation.recovered)));
            }
            if preparation.requeued > 0 {
                notes.push(format!(
                    "re-queued {} {}",
                    n0(preparation.requeued),
                    if retry_failed { "failed or missing" } else { "missing" }
                ));
            }
            page.stages[RECONCILE].finish(
                PASSED,
                if notes.is_empty() {
                    "Cache matches the catalogue".to_string()
                } else {
                    capitalize(&notes.join(" · "))
                },
            );
            cx.notify();
        })?;
        Self::refresh_counts(this, cx).await?;

        let (inspector, token) = (services.clone(), cancel.clone());
        let cache = rt::spawn(async move { inspector.card_images.inspect(&token).await }).await?;
        if cache.pending == 0 {
            return this.update(cx, |page, cx| {
                cx.notify();
                if cache.failed > 0 {
                    let failed = format!(
                        "{} card images cached, {} failed earlier (Retry failed asks again)",
                        n0(cache.downloaded),
                        n0(cache.failed)
                    );
                    page.stages[IMAGES].finish(WARNING, failed.clone());
                    return failed + ".";
                }
                page.stages[IMAGES].finish(PASSED, format!("All {} card images cached", n0(cache.downloaded)));
                "Card images complete.".to_string()
            });
        }
        let queued = cache.pending;
        this.update(cx, |page, cx| {
            page.stages[IMAGES].start(format!("{} images queued", n0(queued)));
            page.failures_logged = 0;
            cx.notify();
        })?;
        let clock = Instant::now();
        let (downloader, token) = (services.clone(), cancel.clone());
        let result = with_progress(
            this,
            cx,
            move |sender: UnboundedSender<CardImageProgress>| async move {
                let report = move |status: CardImageProgress| {
                    let _ = sender.unbounded_send(status);
                };
                downloader
                    .card_images
                    .download_pending(None, Some(&report as &(dyn Fn(CardImageProgress) + Send + Sync)), &token)
                    .await
            },
            move |page, status, cx| page.show_download(status, queued, clock.elapsed(), cache, cx),
        )
        .await?;
        check(cancel)?;
        this.update(cx, |page, cx| {
            let detail = format!(
                "Downloaded {} images{} · {}",
                n0(result.downloaded),
                if result.failed > 0 { format!(", {} failed", n0(result.failed)) } else { String::new() },
                rate(result.downloaded + result.failed, clock.elapsed())
            );
            page.stages[IMAGES].finish(if result.failed > 0 { WARNING } else { PASSED }, detail.clone());
            if result.failed > page.failures_logged {
                page.append_log(
                    format!(
                        "{} more images failed; Retry failed asks Scryfall again.",
                        n0(result.failed - page.failures_logged)
                    ),
                    true,
                    cx,
                );
            }
            page.append_log(format!("{detail}."), true, cx);
            cx.notify();
            detail + "."
        })
    }

    fn show_bulk_status(&mut self, status: BulkSyncStatus) {
        let stage = capitalize(&status.stage);
        match status.phase {
            BulkSyncPhase::Checking => self.stages[CHECK].start("Asking Scryfall for its latest bulk files…"),
            BulkSyncPhase::Downloading => {
                if self.stages[CHECK].status == RUNNING {
                    self.stages[CHECK].finish(PASSED, "Newer data published");
                }
                if self.stages[IMPORT].status == RUNNING {
                    self.stages[IMPORT].finish(PASSED, "Oracle cards imported");
                }
                let download = &mut self.stages[DOWNLOAD];
                download.start(format!("{stage}…"));
                download.detail = match status.total {
                    Some(total) => format!("{stage} · {} / {} MB", n0(status.processed), n0(total)),
                    None => format!("{stage} · {} MB", n0(status.processed)),
                };
                download.progress_percent = match status.total {
                    Some(size) if size > 0 => status.processed as f64 * 100.0 / size as f64,
                    _ => -1.,
                };
            }
            BulkSyncPhase::Importing => {
                if self.stages[DOWNLOAD].status == RUNNING {
                    self.stages[DOWNLOAD].finish(PASSED, "Download complete");
                }
                let import = &mut self.stages[IMPORT];
                import.start(status.stage.clone());
                import.detail = format!("{stage} · {} rows", n0(status.processed));
            }
        }
        self.status = format!("{stage}…");
    }

    fn show_download(
        &mut self,
        status: CardImageProgress,
        queued: i64,
        elapsed: Duration,
        start: CardImageCacheStatus,
        cx: &mut Context<Self>,
    ) {
        let finished = status.downloaded + status.failed;
        let seconds = elapsed.as_secs_f64();
        let per_second = if seconds > 1. { finished as f64 / seconds } else { 0. };
        let eta = if per_second > 0. {
            format_duration(Duration::from_secs_f64(status.remaining as f64 / per_second))
        } else {
            "estimating".to_string()
        };
        let stage = &mut self.stages[IMAGES];
        stage.detail = format!(
            "{} / {} · {} failed · {per_second:.1} images/s · {eta} left",
            n0(finished),
            n0(queued),
            n0(status.failed)
        );
        stage.progress_percent = if queued == 0 { 0. } else { finished as f64 * 100.0 / queued as f64 };
        self.images_cached = n0(start.downloaded + status.downloaded);
        self.images_percent = if start.total == 0 {
            0.
        } else {
            (start.downloaded + status.downloaded) as f64 * 100.0 / start.total as f64
        };
        self.images_caption = format!("of {} faces · {:.1}%", n0(start.total), self.images_percent);
        self.images_failed = n0(start.failed + status.failed);
        for failure in status.failures {
            if self.failures_logged >= LOGGED_FAILURES {
                break;
            }
            self.failures_logged += 1;
            let face =
                if failure.face_index > 0 { format!(" · face {}", failure.face_index + 1) } else { String::new() };
            self.append_log(
                format!(
                    "Failed {} · {} #{}{face}: {}",
                    failure.name,
                    failure.set_code.to_uppercase(),
                    failure.collector_number,
                    failure.error
                ),
                true,
                cx,
            );
        }
    }

    fn cancel_running_stages(&mut self) {
        for stage in &mut self.stages {
            if stage.status == RUNNING || stage.status == PENDING {
                let detail = if stage.status == RUNNING { "Stopped" } else { "Not run" };
                stage.finish(CANCELLED, detail);
            }
        }
    }

    async fn check_freshness(this: &WeakEntity<Self>, cx: &mut AsyncApp) -> Result<()> {
        let services = this.read_with(cx, |page, _| page.services.clone())?;
        let (never, up_to_date, age) = rt::spawn(async move {
            let files = services.bulk_data_sync.check_freshness(&CancellationToken::new()).await?;
            let connection = services.database.open()?;
            // The newest sync is the youngest; SQLite reads the stored timestamps (NULL when it can't).
            let mut newest: Option<f64> = None;
            for synced in files.iter().filter_map(|file| file.synced_at.as_deref()) {
                let age: Option<f64> = connection.query_row(AGE_SQL, [synced], |row| row.get(0))?;
                if let Some(age) = age {
                    newest = Some(newest.map_or(age, |newest| newest.min(age)));
                }
            }
            let never = files.is_empty() || files.iter().any(|file| file.local_updated_at.is_none());
            let up_to_date = files.iter().all(|file| file.up_to_date());
            anyhow::Ok((never, up_to_date, newest))
        })
        .await?;
        this.update(cx, |page, cx| {
            if never {
                page.freshness_text = "Never synced".into();
                page.freshness_tone = Tone::Warning;
            } else if up_to_date {
                page.freshness_text = format!("Up to date · synced {}", describe_age(age));
                page.freshness_tone = Tone::Success;
            } else {
                page.freshness_text = format!("Scryfall has newer data · synced {}", describe_age(age));
                page.freshness_tone = Tone::Warning;
            }
            cx.notify();
        })
    }

    async fn refresh_counts(this: &WeakEntity<Self>, cx: &mut AsyncApp) -> Result<()> {
        let (services, want_synced) = this.read_with(cx, |page, _| {
            (page.services.clone(), !page.checked_freshness && page.freshness_text == "Not checked")
        })?;
        let counts = rt::spawn(async move {
            let catalogue = count_catalogue(&services).await?;
            let cache = services.card_images.inspect(&CancellationToken::new()).await?;
            let connection = services.database.open()?;
            let synced = if want_synced {
                Some(connection.query_row(
                    "SELECT MAX(synced_at), (julianday('now') - julianday(MAX(synced_at))) * 86400.0 FROM sync_state",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?)
            } else {
                None
            };
            anyhow::Ok(Counts { catalogue, cache, synced })
        })
        .await?;
        this.update(cx, |page, cx| {
            let Counts { catalogue, cache, synced } = counts;
            page.printings = n0(catalogue.0);
            page.oracle_cards = n0(catalogue.1);
            page.sets = n0(catalogue.2);
            page.images_cached = n0(cache.downloaded);
            page.images_percent = cache.percent();
            page.images_caption = if cache.total == 0 {
                "run a sync to list them".into()
            } else {
                format!("of {} faces · {:.1}%", n0(cache.total), cache.percent())
            };
            page.images_failed = n0(cache.failed);
            page.disk_used = format_bytes(cache.downloaded_bytes);
            page.has_failures = cache.failed > 0;
            if let Some((synced, age)) = synced
                && !page.checked_freshness
                && page.freshness_text == "Not checked"
            {
                page.freshness_text = match synced {
                    None => "Never synced".into(),
                    Some(_) => format!("Synced {}", describe_age(age)),
                };
                page.freshness_tone = if page.freshness_text == "Never synced" { Tone::Warning } else { Tone::Neutral };
            }
            cx.notify();
        })
    }

    async fn record_run(
        this: &WeakEntity<Self>,
        cx: &mut AsyncApp,
        started: SystemTime,
        outcome: &'static str,
        summary: String,
    ) -> Result<()> {
        let services = this.read_with(cx, |page, _| page.services.clone())?;
        let finished = SystemTime::now();
        rt::spawn(async move {
            let connection = services.database.open()?;
            let (started, finished) = (round_trip_utc(started.into()), round_trip_utc(finished.into()));
            connection.execute(
                "INSERT INTO sync_runs (started_at, finished_at, outcome, summary) VALUES (?1, ?2, ?3, ?4)",
                (started, finished, outcome, summary),
            )?;
            anyhow::Ok(())
        })
        .await?;
        Self::refresh_last_run(this, cx).await
    }

    async fn refresh_last_run(this: &WeakEntity<Self>, cx: &mut AsyncApp) -> Result<()> {
        let services = this.read_with(cx, |page, _| page.services.clone())?;
        let last = rt::spawn(async move {
            let connection = services.database.open()?;
            // SQLite reads the stored UTC timestamps and knows the local time zone.
            let mut statement = connection.prepare(
                "SELECT strftime('%d|%m|%H:%M', started, 'localtime'), (finished - started) * 86400.0, outcome, summary
                FROM (SELECT COALESCE(julianday(started_at), julianday('now')) AS started,
                        COALESCE(julianday(finished_at), julianday(started_at), julianday('now')) AS finished,
                        outcome, summary
                    FROM sync_runs ORDER BY finished_at DESC LIMIT 1)",
            )?;
            let mut rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?;
            anyhow::Ok(rows.next().transpose()?)
        })
        .await?;
        let Some((when, took, outcome, summary)) = last else {
            return Ok(());
        };
        let mut parts = when.split('|');
        let day = parts.next().unwrap_or_default().trim_start_matches('0');
        let month = parts.next().and_then(|month| month.parse::<usize>().ok()).unwrap_or(1);
        let time = parts.next().unwrap_or_default();
        let month = MONTHS.get(month.wrapping_sub(1)).copied().unwrap_or_default();
        let took = format_duration(Duration::from_secs_f64(took.max(0.)));
        this.update(cx, |page, cx| {
            page.last_run_text = format!("Last run {day} {month}, {time} · {took} · {outcome}. {summary}");
            cx.notify();
        })
    }

    fn show_error(&mut self, title: &str, error: &anyhow::Error, cx: &mut Context<Self>) {
        self.error_message = format!("{title}: {error:#}");
        self.error_detail = Some(format!("{title}\r\n{error:?}"));
        self.status = self.error_message.clone();
        self.services.log.error("scryfall-sync", title, Some(error));
        self.append_log(format!("{title}: {error:#}"), false, cx);
        cx.notify();
    }

    fn append_log(&mut self, line: String, log_to_file: bool, cx: &mut Context<Self>) {
        if log_to_file {
            self.services.log.information("scryfall-sync", &line);
        }
        let line = format!("{} {line}", chrono::Local::now().format("%H:%M:%S"));
        self.log.update(cx, |log, cx| {
            log.push(line, cx);
        });
    }
}

impl Render for SyncPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let busy = self.busy;
        let mut actions = vec![
            ui::icon_button("open-image-folder", IconName::FolderOpen, "Open image folder")
                .on_click(
                    cx.listener(|page, _, _, _| events::open_folder(&page.services.card_images.images_directory())),
                )
                .into_any_element(),
        ];
        if self.has_failures {
            actions.push(
                ui::secondary_button("retry-failed", "Retry failed", Some(IconName::RotateCw))
                    .tooltip("Download the card images that failed again; their reasons are in the activity log")
                    .disabled(busy)
                    .on_click(cx.listener(|page, _, _, cx| page.retry_failed(cx)))
                    .into_any_element(),
            );
        }
        actions.push(ui::run_button(
            "sync-now",
            busy,
            IconName::RefreshCw,
            "Sync now",
            busy,
            !busy,
            cx.listener(|page, _, _, cx| page.sync(cx)),
            cx.listener(|page, _, _, cx| page.cancel(cx)),
        ));

        let stages: Vec<ui::Stage> = self.stages.iter().map(SyncStage::view).collect();
        ui::page("sync-page", false)
            .child(ui::page_header(
                DISPLAY_NAME,
                DESCRIPTION,
                Some(ui::status_pill(self.freshness_tone, self.freshness_text.clone())),
                actions,
            ))
            // Errors stay until dismissed, with the full detail one click away.
            .children((!self.error_message.is_empty()).then(|| {
                ui::error_alert(
                    self.error_message.clone(),
                    cx.listener(|page, _, _, cx| page.copy_error(cx)),
                    cx.listener(|page, _, _, cx| page.dismiss_error(cx)),
                )
            }))
            .child(
                ui::section(None, None, vec![])
                    .child(ui::stats(vec![
                        ui::stat_tile("Printings", self.printings.clone(), Some("one per artwork")),
                        ui::stat_tile("Oracle cards", self.oracle_cards.clone(), Some("unique cards")),
                        ui::stat_tile("Sets", self.sets.clone(), Some("in the catalogue")),
                        ui::stat_tile(
                            "Card images",
                            self.images_cached.clone(),
                            Some(self.images_caption.as_str()).filter(|caption| !caption.is_empty()),
                        ),
                        ui::stat_tile("Failed", self.images_failed.clone(), Some("kept until retried")),
                        ui::stat_tile("Disk used", self.disk_used.clone(), Some("card-images folder")),
                    ]))
                    .child(div().mt(px(16.)).child(Progress::new("images-progress").value(self.images_percent as f32)))
                    .child(ui::muted(self.status.clone()).mt(px(8.))),
            )
            .child(ui::split(
                ui::section(Some("Pipeline"), Some(&self.last_run_text), vec![])
                    .child(ui::stage_list("sync-stages", &stages)),
                self.log.clone(),
                window,
            ))
    }
}

/// Runs service work on tokio, handing each progress report to the page as it comes; the reports end when the work
/// does.
async fn with_progress<P, T, F>(
    this: &WeakEntity<SyncPage>,
    cx: &mut AsyncApp,
    work: impl FnOnce(UnboundedSender<P>) -> F,
    mut on_progress: impl FnMut(&mut SyncPage, P, &mut Context<SyncPage>),
) -> Result<T>
where
    P: Send + 'static,
    T: Send + 'static,
    F: Future<Output = Result<T>> + Send + 'static,
{
    let (sender, mut reports) = rt::channel();
    let job = rt::spawn(work(sender));
    while let Some(report) = reports.next().await {
        this.update(cx, |page, cx| {
            on_progress(page, report, cx);
            cx.notify();
        })?;
    }
    job.await
}

async fn count_catalogue(services: &Arc<Services>) -> Result<(i64, i64, i64)> {
    let database = services.database.clone();
    rt::spawn(async move {
        let connection = database.open()?;
        Ok(connection.query_row(
            "SELECT (SELECT COUNT(*) FROM cards), (SELECT COUNT(*) FROM oracle_cards), (SELECT COUNT(*) FROM sets)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?)
    })
    .await
}

/// Seconds since a stored UTC timestamp; NULL when SQLite can't read it.
const AGE_SQL: &str = "SELECT (julianday('now') - julianday(?1)) * 86400.0";

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

fn format_duration(value: Duration) -> String {
    let seconds = value.as_secs();
    if value < Duration::from_secs(1) {
        "under a second".into()
    } else if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3600 {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    } else {
        format!("{}h {:02}m", seconds / 3600, seconds / 60 % 60)
    }
}

fn format_bytes(bytes: i64) -> String {
    if bytes >= 1 << 30 {
        format!("{:.1} GB", bytes as f64 / (1u64 << 30) as f64)
    } else if bytes >= 1 << 20 {
        format!("{:.0} MB", bytes as f64 / (1u64 << 20) as f64)
    } else {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    }
}

fn rate(count: i64, elapsed: Duration) -> String {
    if elapsed < Duration::from_secs(1) {
        "instant".into()
    } else {
        format!("{:.1} images/s", count as f64 / elapsed.as_secs_f64())
    }
}

fn signed(value: i64) -> String {
    if value >= 0 { format!("+{}", n0(value)) } else { n0(value) }
}

fn plural(count: i64, noun: &str) -> String {
    if count == 1 { format!("1 {noun}") } else { format!("{} {noun}s", n0(count)) }
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn describe_age(age_seconds: Option<f64>) -> String {
    let Some(age) = age_seconds else {
        return "never".into();
    };
    if age < 60. {
        "just now".into()
    } else if age < 3600. {
        format!("{} min ago", (age / 60.) as i64)
    } else if age < 86_400. {
        format!("{} h ago", (age / 3600.) as i64)
    } else if age < 2. * 86_400. {
        "yesterday".into()
    } else {
        format!("{} days ago", (age / 86_400.) as i64)
    }
}
