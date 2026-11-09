//! Card Extraction (ExtractionTrainingViewModel + ExtractionTraining.tsx): trains the card finder end to end, and
//! previews it on one chosen photo.

use deckino_core::n0;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use anyhow::{Result, anyhow};
use deckino_core::bulk_data_sync::BulkSyncStatus;
use deckino_core::card_images::CardImageProgress;
use deckino_core::error::is_cancelled;
use deckino_core::extraction_production_workflow::ExtractionWorkflowSnapshot;
use deckino_core::identity_production_workflow::{ProductionStageResult, ProductionWorkflowOutcome};
use deckino_core::log::ApplicationLogService;
use deckino_core::services::Services;
use deckino_core::training_environment::{CudaTrainingProfile, TrainingEnvironmentService};
use deckino_core::training_result_exporter::TrainingResultExporter;
use deckino_core::training_run_sync::TrainingRunSyncService;
use futures::StreamExt;
use futures::channel::mpsc::UnboundedSender;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::{Disableable, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::shell::PageEntry;
use crate::ui::{self, IconName, LogView};
use crate::{events, rt, theme};

pub(super) const MAXIMUM_LOG_LINES: usize = 400;
const AUTOMATIC_FULL_CARD_LIMIT: i64 = 5000;
const DESCRIPTION: &str =
    "Train the card finder, the model that finds a card's four corners, from your annotated photos.";
const RUN_OPERATION: &str = "run full extraction workflow";
const DIAGNOSTIC_OPERATION: &str = "run extraction diagnostic";
const SYNTHETIC_OFF: &str = "Synthetic cards are off; no full-card cache is needed.";
const NO_HANDOFF: &str = "None yet: train one, or pull one on Model Sync.";

pub fn entry(services: Arc<Services>, _window: &mut Window, cx: &mut App) -> PageEntry {
    let page = cx.new(|cx| ExtractionTrainingPage::new(services, cx));
    let opened = page.clone();
    PageEntry {
        key: "extractionTraining",
        name: "Extraction Training".into(),
        icon: IconName::Focus,
        view: page.into(),
        opened: Some(Rc::new(move |_, cx| opened.update(cx, |page, cx| page.refresh(cx)))),
        left: None,
    }
}

/// What the tokio side of a job reports back to the page, in order.
enum Update {
    Line(String, Option<Value>),
    Status(String),
    AssetSummary(String),
    Snapshot(ExtractionWorkflowSnapshot),
    DiagnosticStarted,
    DiagnosticOutput { output: PathBuf, overlay: Option<PathBuf>, rectified: Option<PathBuf>, crop: Option<PathBuf> },
    DiagnosticResult { summary: String, crop_status: String },
}

/// The tokio side's end of the page: lines go to the application log at once, everything else to the page.
#[derive(Clone)]
struct Feed {
    tx: UnboundedSender<Update>,
    log: Arc<ApplicationLogService>,
}

impl Feed {
    /// The workflows' line callback (it must own what it uses).
    fn on_line(&self) -> impl Fn(&str, Option<&Value>) + Send + Sync + 'static {
        let feed = self.clone();
        move |line, parsed| feed.line(line, parsed)
    }

    fn send(&self, update: Update) {
        let _ = self.tx.unbounded_send(update);
    }

    fn status(&self, status: impl Into<String>) {
        self.send(Update::Status(status.into()));
    }

    fn line(&self, line: &str, parsed: Option<&Value>) {
        self.log.information("extraction-training", line);
        self.send(Update::Line(line.to_string(), parsed.cloned()));
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ExtractionTab {
    Train,
    Diagnostic,
}

struct ExtractionTrainingPage {
    services: Arc<Services>,
    log: Entity<LogView>,
    tab: ExtractionTab,
    stages: Vec<ui::Stage>,
    status: SharedString,
    asset_summary: SharedString,
    include_synthetic_cards: bool,
    diagnostic_image_path: String,
    diagnostic_output_path: String,
    diagnostic_overlay: Option<PathBuf>,
    rectified_preview: Option<PathBuf>,
    recognition_crop_preview: Option<PathBuf>,
    diagnostic_crop_status: SharedString,
    diagnostic_summary: SharedString,
    is_busy: bool,
    environment_ready: bool,
    gpu_summary: SharedString,
    handoff_summary: SharedString,
    selected_profile: Option<CudaTrainingProfile>,
    cancel: Option<CancellationToken>,
}

impl ExtractionTrainingPage {
    fn new(services: Arc<Services>, cx: &mut Context<Self>) -> Self {
        let page = cx.weak_entity();
        let log = cx.new(|_| {
            LogView::new("", Some(services.paths.logs_root.clone())).bounded(MAXIMUM_LOG_LINES).on_clear(Rc::new(
                move |_, cx| {
                    let _ = page.update(cx, |page, cx| page.clear_all_logs(cx));
                },
            ))
        });
        let initial = services.clone();
        cx.spawn(async move |this, cx| {
            let loaded =
                rt::spawn(async move { Ok((initial.extraction_workflow.inspect(), handoff_summary(&initial))) }).await;
            let _ = this.update(cx, |page, cx| {
                match loaded {
                    Ok((Ok(snapshot), handoff)) => {
                        page.apply_snapshot(snapshot);
                        page.handoff_summary = handoff.into();
                    }
                    Ok((Err(error), _)) | Err(error) => page.status = format!("{error:#}").into(),
                }
                cx.notify();
            });
        })
        .detach();
        Self {
            services,
            log,
            tab: ExtractionTab::Train,
            stages: Vec::new(),
            status: "Ready to inspect the extraction workspace.".into(),
            asset_summary: SYNTHETIC_OFF.into(),
            include_synthetic_cards: false,
            diagnostic_image_path: String::new(),
            diagnostic_output_path: String::new(),
            diagnostic_overlay: None,
            rectified_preview: None,
            recognition_crop_preview: None,
            diagnostic_crop_status: "Run a preview to create the rectified crops.".into(),
            diagnostic_summary: "No diagnostic has been run.".into(),
            is_busy: false,
            environment_ready: false,
            gpu_summary: "CUDA profile not checked.".into(),
            handoff_summary: NO_HANDOFF.into(),
            selected_profile: None,
            cancel: None,
        }
    }

    fn can_run(&self) -> bool {
        !self.is_busy && self.environment_ready
    }

    fn can_run_diagnostic(&self) -> bool {
        self.can_run()
            && !self.diagnostic_image_path.trim().is_empty()
            && Path::new(&self.diagnostic_image_path).is_file()
    }

    /// The page was opened: check the CUDA profile, the full-card cache and the workflow state again.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.is_busy {
            return;
        }
        let services = self.services.clone();
        let include_synthetic_cards = self.include_synthetic_cards;
        let job = rt::spawn(async move {
            let cancel = CancellationToken::new();
            let readiness = services.training_environment.check(&|_, _| {}, &cancel).await?;
            let profile = match (readiness.gpu_index, &readiness.gpu_name, readiness.vram_mib) {
                (Some(index), Some(name), Some(vram)) => {
                    Some(TrainingEnvironmentService::create_training_profile(index, name, vram))
                }
                _ => None,
            };
            let assets =
                if include_synthetic_cards { Some(services.card_images.inspect(&cancel).await?) } else { None };
            let snapshot = services.extraction_workflow.inspect()?;
            Ok((readiness.ready(), profile, assets, snapshot, handoff_summary(&services)))
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |page, cx| {
                match result {
                    Ok((ready, profile, assets, snapshot, handoff)) => {
                        page.environment_ready = ready && profile.is_some();
                        page.gpu_summary = match &profile {
                            None => "A compatible NVIDIA CUDA profile is not ready.".into(),
                            Some(profile) => {
                                let batch = if profile.vram_mib >= 7680 {
                                    profile.batch_size.min(32)
                                } else {
                                    profile.batch_size.min(16)
                                };
                                format!(
                                    "{} · {} MiB · extraction batch {batch}",
                                    profile.gpu_name,
                                    n0(profile.vram_mib)
                                )
                                .into()
                            }
                        };
                        page.selected_profile = profile;
                        if let Some(assets) = assets {
                            page.asset_summary = if assets.total == 0 {
                                "Full-card images will be discovered automatically when training starts.".into()
                            } else {
                                format!(
                                    "{} / {} card images cached (Scryfall Sync downloads the rest)",
                                    n0(assets.downloaded),
                                    n0(assets.total)
                                )
                                .into()
                            };
                        }
                        // A job started while this ran owns the timeline now.
                        if !page.is_busy {
                            page.apply_snapshot(snapshot);
                        }
                        page.handoff_summary = handoff.into();
                    }
                    Err(error) => {
                        page.status = format!("{error:#}").into();
                        page.services.log.error(
                            "extraction-refresh",
                            "Could not refresh extraction readiness.",
                            Some(&error),
                        );
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn set_include_synthetic_cards(&mut self, value: bool, cx: &mut Context<Self>) {
        self.include_synthetic_cards = value;
        self.asset_summary = if value {
            "Synthetic cards are on; full-card assets will be cached automatically when training starts.".into()
        } else {
            SYNTHETIC_OFF.into()
        };
        cx.notify();
    }

    fn run_full(&mut self, cx: &mut Context<Self>) {
        let profile = self.selected_profile.clone();
        let include_synthetic_cards = self.include_synthetic_cards;
        self.run_guarded(RUN_OPERATION, cx, move |services, feed, cancel| async move {
            let profile = profile.ok_or_else(|| anyhow!("Check CUDA readiness first."))?;
            if include_synthetic_cards {
                match ensure_automatic_full_card_cache(&services, &feed, &cancel).await {
                    Ok(()) => {}
                    Err(error) if is_cancelled(&error) => return Err(error),
                    Err(error) => {
                        feed.send(Update::AssetSummary(
                            "Full-card download unavailable; continuing with imports and any existing synthetic source assets."
                                .into(),
                        ));
                        feed.line(&format!("warning: automatic full-card cache skipped: {error:#}"), None);
                    }
                }
            } else {
                feed.send(Update::AssetSummary(SYNTHETIC_OFF.into()));
                feed.line("Synthetic cards disabled: skipping Scryfall discovery, downloads, and generated scenes.", None);
            }
            let on_progress: &(dyn Fn(ExtractionWorkflowSnapshot) + Send + Sync) =
                &|snapshot| feed.send(Update::Snapshot(snapshot));
            let snapshot = services
                .extraction_workflow
                .run(
                    &profile,
                    &feed.on_line(),
                    Some(on_progress),
                    &cancel,
                    include_synthetic_cards,
                )
                .await?;
            feed.send(Update::Snapshot(snapshot.clone()));
            share_run(&services, &feed, &snapshot, &cancel).await;
            Ok(())
        });
    }

    fn pick_diagnostic_image(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            if let Some(path) = events::pick_file("Choose an owned camera photograph", &[".jpg", ".jpeg", ".png"]).await
            {
                let _ = this.update(cx, |page, cx| {
                    page.diagnostic_image_path = path.display().to_string();
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn run_diagnostic(&mut self, cx: &mut Context<Self>) {
        let profile = self.selected_profile.clone();
        let image = PathBuf::from(&self.diagnostic_image_path);
        self.run_guarded(DIAGNOSTIC_OPERATION, cx, move |services, feed, cancel| async move {
            let profile = profile.ok_or_else(|| anyhow!("Check CUDA readiness first."))?;
            feed.send(Update::DiagnosticStarted);
            let output =
                services.extraction_workflow.run_diagnostic(&image, &profile, &feed.on_line(), &cancel).await?;
            let existing = |name: &str| Some(output.join(name)).filter(|path| path.is_file());
            feed.send(Update::DiagnosticOutput {
                output: output.clone(),
                overlay: existing("overlay.jpg"),
                rectified: existing("rectified-with-identity-crop.jpg"),
                crop: existing("recognition-crop-v1.jpg"),
            });
            let diagnostic: Value = serde_json::from_str(&std::fs::read_to_string(output.join("diagnostic.json"))?)?;
            let (summary, crop_status) = describe_diagnostic(&diagnostic)?;
            feed.send(Update::DiagnosticResult { summary, crop_status });
            feed.status(format!("Diagnostic written to {}", output.display()));
            Ok(())
        });
    }

    fn cancel(&mut self) {
        if let Some(cancel) = &self.cancel {
            cancel.cancel();
        }
    }

    fn open_extraction_folder(&self) {
        events::open_folder(&self.services.paths.extraction_root);
    }

    fn open_handoff_folder(&self) {
        let _ = std::fs::create_dir_all(&self.services.paths.incoming_root);
        events::open_folder(&self.services.paths.handoff_root);
    }

    fn clear_all_logs(&mut self, cx: &mut Context<Self>) {
        let answer = events::ask(
            cx,
            "Clear activity log",
            "Clear the visible activity log and delete the current Deckino Toolbox log file?",
            "Clear log",
            Some("Cancel"),
        );
        cx.spawn(async move |this, cx| {
            if !answer.await.unwrap_or(false) {
                return;
            }
            let _ = this.update(cx, |page, cx| {
                page.services.log.clear_current_log();
                page.log.update(cx, |log, cx| log.clear(cx));
                page.status = "Activity log cleared.".into();
                cx.notify();
            });
        })
        .detach();
    }

    /// One job at a time, under the workspace lock; whatever happens, the timeline is read again at the end.
    fn run_guarded<Fut>(
        &mut self,
        operation: &'static str,
        cx: &mut Context<Self>,
        action: impl FnOnce(Arc<Services>, Feed, CancellationToken) -> Fut,
    ) where
        Fut: Future<Output = Result<()>> + Send + 'static,
    {
        if self.is_busy {
            return;
        }
        let cancel = CancellationToken::new();
        self.cancel = Some(cancel.clone());
        self.is_busy = true;
        cx.notify();
        let lease = self.services.coordinator.acquire(operation);
        let (tx, mut updates) = rt::channel();
        let work = action(self.services.clone(), Feed { tx, log: self.services.log.clone() }, cancel);
        let job = rt::spawn(async move {
            let _lease = lease?;
            work.await
        });
        let services = self.services.clone();
        cx.spawn(async move |this, cx| {
            while let Some(update) = updates.next().await {
                if this.update(cx, |page, cx| page.apply(update, cx)).is_err() {
                    return;
                }
            }
            let result = job.await;
            let snapshot = rt::spawn(async move { services.extraction_workflow.inspect() }).await;
            let _ = this.update(cx, |page, cx| {
                let terminal: SharedString = match result {
                    Ok(()) => page.status.clone(),
                    Err(error) if is_cancelled(&error) => {
                        "Cancelled safely. Completed stages and checkpoints were retained.".into()
                    }
                    Err(error) => {
                        let message = format!("{error:#}");
                        if operation == DIAGNOSTIC_OPERATION {
                            page.diagnostic_crop_status = format!("Preview failed: {message}").into();
                        }
                        page.services.log.error("extraction", &format!("{operation} failed."), Some(&error));
                        message.into()
                    }
                };
                page.cancel = None;
                page.is_busy = false;
                if let Ok(snapshot) = snapshot {
                    page.apply_snapshot(snapshot);
                }
                if !terminal.trim().is_empty() {
                    page.status = terminal;
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn apply(&mut self, update: Update, cx: &mut Context<Self>) {
        match update {
            Update::Line(line, parsed) => {
                self.log.update(cx, |log, cx| log.push(display_line(&line, parsed.as_ref()), cx));
                if let Some(status) = parsed.as_ref().and_then(extraction_status) {
                    self.status = status.into();
                }
            }
            Update::Status(status) => self.status = status.into(),
            Update::AssetSummary(summary) => self.asset_summary = summary.into(),
            Update::Snapshot(snapshot) => self.apply_snapshot(snapshot),
            Update::DiagnosticStarted => {
                self.diagnostic_overlay = None;
                self.rectified_preview = None;
                self.recognition_crop_preview = None;
                self.diagnostic_crop_status = "Running extraction preview…".into();
            }
            Update::DiagnosticOutput { output, overlay, rectified, crop } => {
                self.diagnostic_output_path = output.display().to_string();
                self.diagnostic_overlay = overlay;
                self.rectified_preview = rectified;
                self.recognition_crop_preview = crop;
            }
            Update::DiagnosticResult { summary, crop_status } => {
                self.diagnostic_summary = summary.into();
                self.diagnostic_crop_status = crop_status.into();
            }
        }
        cx.notify();
    }

    fn apply_snapshot(&mut self, snapshot: ExtractionWorkflowSnapshot) {
        self.status = snapshot.summary.into();
        self.stages = to_stages(&snapshot.stages);
    }

    fn render_train(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let column_width = if window.viewport_size().width < px(1400.) { 360. } else { 440. };
        let options = ui::section(None, None, vec![])
            .child(
                Switch::new("include-synthetic-cards")
                    .label("Include synthetic cards")
                    .checked(self.include_synthetic_cards)
                    .disabled(self.is_busy)
                    .on_click(
                        cx.listener(|this, checked: &bool, _, cx| this.set_include_synthetic_cards(*checked, cx)),
                    ),
            )
            .child(
                v_flex()
                    .gap(px(2.))
                    .mt(px(10.))
                    .child(small_muted(self.asset_summary.clone()))
                    .child(small_muted(self.gpu_summary.clone())),
            )
            .child(
                h_flex()
                    .gap(px(8.))
                    .mt(px(10.))
                    .pt(px(10.))
                    .border_t_1()
                    .border_color(theme::hairline())
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div().text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).child("Current card finder"),
                            )
                            .child(small_muted(self.handoff_summary.clone()).truncate()),
                    )
                    .child(
                        ui::icon_button(
                            "open-handoff-folder",
                            IconName::FolderOpen,
                            "Open the handoff folder, to share runs between PCs",
                        )
                        .on_click(cx.listener(|this, _, _, _| this.open_handoff_folder())),
                    ),
            );
        div()
            .flex()
            .flex_1()
            .min_h_0()
            .gap(px(16.))
            .child(
                v_flex()
                    .id("extraction-train-column")
                    .flex_none()
                    .w(px(column_width))
                    .min_h_0()
                    .gap(px(16.))
                    .overflow_y_scroll()
                    .child(options)
                    .child(
                        ui::section(Some("Stages"), None, vec![])
                            .child(ui::step_list("extraction-stages", &self.stages)),
                    ),
            )
            .child(div().flex_1().min_w_0().min_h_0().child(self.log.clone()))
            .into_any_element()
    }

    fn render_diagnostic(&self, cx: &mut Context<Self>) -> AnyElement {
        let path_field = div()
            .flex_1()
            .min_w_0()
            .h(px(36.))
            .px(px(12.))
            .flex()
            .items_center()
            .rounded(px(8.))
            .bg(theme::color_alpha(0x00000040))
            .border_1()
            .border_color(theme::hairline())
            .text_size(px(14.))
            .map(|field| {
                if self.diagnostic_image_path.is_empty() {
                    field.text_color(theme::text_dim()).child("Choose an owned camera photograph")
                } else {
                    field.child(div().truncate().child(self.diagnostic_image_path.clone()))
                }
            });
        let preview =
            |title: &str, image: &Option<PathBuf>| {
                ui::section(Some(title), None, vec![]).flex_1().min_w_0().min_h_0().child(
                    ui::image_well(image.clone().map(ImageSource::from), "No image yet").flex_1().min_h(px(120.)),
                )
            };
        v_flex()
            .flex_1()
            .min_h_0()
            .gap(px(16.))
            .child(
                ui::section(Some("Rectification diagnostic"), Some(&self.diagnostic_summary), vec![])
                    .child(
                        h_flex()
                            .gap(px(8.))
                            .child(path_field)
                            .child(
                                ui::secondary_button(
                                    "choose-diagnostic-image",
                                    "Choose image",
                                    Some(IconName::ScanSearch),
                                )
                                .on_click(cx.listener(|this, _, _, cx| this.pick_diagnostic_image(cx))),
                            )
                            .child(
                                ui::primary_button("run-diagnostic", "Rectify preview", Some(IconName::Scan))
                                    .disabled(!self.can_run_diagnostic())
                                    .on_click(cx.listener(|this, _, _, cx| this.run_diagnostic(cx))),
                            ),
                    )
                    .child(
                        v_flex().gap(px(2.)).mt(px(10.)).child(ui::muted(self.diagnostic_crop_status.clone())).when(
                            !self.diagnostic_output_path.is_empty(),
                            |el| {
                                el.child(
                                    ui::dim(self.diagnostic_output_path.clone())
                                        .font_family(theme::MONO_FONT)
                                        .truncate(),
                                )
                            },
                        ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h(px(320.))
                    .gap(px(16.))
                    .child(preview("Prediction + ground truth", &self.diagnostic_overlay))
                    .child(preview("315 × 440 + identity crop", &self.rectified_preview))
                    .child(preview("224 × 224 inspection crop", &self.recognition_crop_preview)),
            )
            .into_any_element()
    }
}

impl Render for ExtractionTrainingPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let status = self.status.clone();
        self.log.update(cx, |log, _| log.title = status);
        let header = ui::page_header(
            "Card Extraction",
            DESCRIPTION,
            None,
            vec![
                ui::icon_button("open-extraction-folder", IconName::FolderOpen, "Open workspace folder")
                    .on_click(cx.listener(|this, _, _, _| this.open_extraction_folder()))
                    .into_any_element(),
                ui::run_button(
                    "extraction-train",
                    self.is_busy,
                    IconName::Play,
                    "Train",
                    !self.can_run(),
                    !self.is_busy,
                    cx.listener(|this, _, _, cx| this.run_full(cx)),
                    cx.listener(|this, _, _, _| this.cancel()),
                ),
            ],
        );
        let tabs = TabBar::new("extraction-tabs")
            .pill()
            .selected_index(if self.tab == ExtractionTab::Train { 0 } else { 1 })
            .on_click(cx.listener(|this, index: &usize, _, cx| {
                this.tab = if *index == 0 { ExtractionTab::Train } else { ExtractionTab::Diagnostic };
                cx.notify();
            }))
            .child(Tab::new().label("Train").prefix(ui::icon(IconName::Play)))
            .child(Tab::new().label("Diagnostic").prefix(ui::icon(IconName::Scan)));
        let body = match self.tab {
            ExtractionTab::Train => self.render_train(window, cx),
            ExtractionTab::Diagnostic => self.render_diagnostic(cx),
        };
        ui::page("extraction-training", false).child(header).child(div().flex_none().child(tabs)).child(body)
    }
}

/// Fills the full-card cache synthetic scenes are drawn from: the Scryfall catalogue first when there is none, then up
/// to AUTOMATIC_FULL_CARD_LIMIT cards.
async fn ensure_automatic_full_card_cache(services: &Services, feed: &Feed, cancel: &CancellationToken) -> Result<()> {
    let mut cache = services.card_images.inspect(cancel).await?;
    if cache.total == 0 {
        feed.status("Discovering full-card assets from the latest Scryfall catalog…");
        let on_progress = |value: BulkSyncStatus| {
            let total = value.total.map(|total| format!(" / {}", n0(total))).unwrap_or_default();
            feed.status(format!("Scryfall catalog · {} · {}{total}", value.stage, n0(value.processed)));
        };
        services.bulk_data_sync.sync_all(&on_progress, cancel).await?;
        cache = services.card_images.inspect(cancel).await?;
    }

    let remaining = (AUTOMATIC_FULL_CARD_LIMIT - cache.downloaded).max(0);
    if remaining > 0 && cache.total > cache.downloaded {
        feed.status(format!(
            "Caching up to {} full cards for synthetic training scenes…",
            n0(AUTOMATIC_FULL_CARD_LIMIT)
        ));
        let on_progress: &(dyn Fn(CardImageProgress) + Send + Sync) = &|value| {
            feed.status(format!(
                "Full-card cache · {} downloaded · {} failed · {} remaining",
                n0(value.downloaded),
                n0(value.failed),
                n0(value.remaining)
            ))
        };
        services
            .card_images
            .download_pending(Some(remaining.min(i32::MAX as i64) as i32), Some(on_progress), cancel)
            .await?;
        cache = services.card_images.inspect(cancel).await?;
    }

    feed.send(Update::AssetSummary(if cache.total == 0 {
        "No Scryfall full-card images were available; using annotated photos only.".into()
    } else {
        format!("{} / {} card images cached", n0(cache.downloaded), n0(cache.total))
    }));
    Ok(())
}

/// A finished run goes to the bucket for the other PCs. The run itself succeeded either way, so a missing connection
/// or a failed upload is only a note; the next start uploads it (TrainingRunSyncService::upload_missing).
async fn share_run(
    services: &Services,
    feed: &Feed,
    snapshot: &ExtractionWorkflowSnapshot,
    cancel: &CancellationToken,
) {
    if !matches!(snapshot.outcome, ProductionWorkflowOutcome::Passed | ProductionWorkflowOutcome::Warning) {
        return;
    }
    let runs = &services.training_run_sync;
    let zip_path =
        services.paths.handoff_root.join(TrainingResultExporter::handoff_zip_file_name(&snapshot.model_version));
    if !runs.is_configured() || !zip_path.is_file() {
        feed.line(
            &if runs.is_configured() {
                format!(
                    "Not uploaded to the bucket: {} is missing; the next start packs and uploads it.",
                    zip_path.display()
                )
            } else {
                "Not uploaded to the bucket: connect it on Dataset Sync; the next start uploads it.".to_string()
            },
            None,
        );
        return;
    }
    feed.status(format!("Uploading {} to the bucket…", snapshot.model_version));
    match runs.upload(TrainingRunSyncService::EXTRACTION_KIND, &snapshot.model_version, &zip_path, cancel).await {
        Ok(()) => feed.line(&format!("Uploaded {} to the bucket for the other PCs.", snapshot.model_version), None),
        // Training finished; cancelling only stopped the upload.
        Err(error) if is_cancelled(&error) => {
            feed.line("Upload to the bucket cancelled; the next start uploads it.", None)
        }
        Err(error) => feed.line(&format!("Upload to the bucket failed ({error:#}); the next start tries again."), None),
    }
    feed.status(snapshot.summary.clone());
}

fn handoff_summary(services: &Services) -> String {
    let Some(pointer) = services.training_result_exporter.read_current_extraction_pointer() else {
        return NO_HANDOFF.into();
    };
    if pointer.model_version.trim().is_empty() {
        return NO_HANDOFF.into();
    }
    let architecture =
        pointer.architecture.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "extractor".into());
    let mut summary = format!("{} · {architecture}", pointer.model_version);
    if let Some(size) = pointer.input_size {
        summary += &format!(" · {size} px");
    }
    if let Some(source) = pointer.source_zip.filter(|value| !value.trim().is_empty()) {
        summary += &format!(" · {source}");
    }
    summary
}

/// The diagnostic's verdict line and what it says about the crops.
fn describe_diagnostic(diagnostic: &Value) -> Result<(String, String)> {
    let required = |key: &str| anyhow!("diagnostic.json has no {key}.");
    let probability = diagnostic["presence_probability"].as_f64().ok_or_else(|| required("presence_probability"))?;
    let threshold = diagnostic.get("presence_threshold").and_then(Value::as_f64);
    let accepted = diagnostic["accepted"].as_bool().ok_or_else(|| required("accepted"))?;
    let model = diagnostic["model_version"].as_str().unwrap_or("unknown model");
    let epoch =
        diagnostic.get("selected_epoch").and_then(Value::as_i64).map(n0).unwrap_or_else(|| "unknown epoch".into());
    let mut evidence = format!("{model} · epoch {epoch}");
    if let Some(hash) =
        diagnostic.get("checkpoint_sha256").and_then(Value::as_str).filter(|hash| !hash.trim().is_empty())
    {
        evidence += &format!(" · SHA {}", hash.chars().take(12).collect::<String>());
    }
    let presence = percent(probability);
    let (mut summary, crop_status) = if accepted {
        (format!("Accepted · presence {presence} · valid upright warp · {evidence}"), String::new())
    } else {
        match diagnostic.get("geometry_rejection_reason").and_then(Value::as_str) {
            Some("presence_below_threshold") => {
                let needs =
                    threshold.filter(|value| value.is_finite()).map(|value| format!(", needs {}", percent(value)));
                (
                    format!("Rejected · presence {presence}{} · {evidence}", needs.unwrap_or_default()),
                    "No crops generated because card presence was below the calibrated threshold.".into(),
                )
            }
            Some("ambiguous_card_geometry") => (
                format!("Rejected · presence {presence} · ambiguous card geometry · {evidence}"),
                "No crops generated because multiple corner combinations were similarly plausible.".into(),
            ),
            _ => (
                format!("Rejected · presence {presence} · invalid quadrilateral · {evidence}"),
                "No crops generated because the predicted corners could not form a safe warp.".into(),
            ),
        }
    };
    if diagnostic.get("calibrated").and_then(Value::as_bool) == Some(false) {
        summary += " · uncalibrated development threshold";
    } else if diagnostic.get("calibration_provisional").and_then(Value::as_bool) == Some(true) {
        summary += " · provisional calibration (limited negatives)";
    }
    Ok((summary, crop_status))
}

/// The status line a training event stands for; None keeps the current one.
fn extraction_status(progress: &Value) -> Option<String> {
    let int = |key: &str| n0(progress[key].as_i64().unwrap_or(0));
    let raw = |key: &str| progress[key].as_i64().unwrap_or(0);
    let text = |key: &str| progress[key].as_str().unwrap_or_default().to_string();
    let flag = |key: &str| progress[key].as_bool().unwrap_or(false);
    Some(match progress.get("event")?.as_str()? {
        "extraction_preparation_progress" => format!("{} · {} / {}", text("detail"), int("completed"), int("total")),
        "extraction_training_progress" => format!(
            "Geometry training epoch {} / {} · batch {} / {}",
            int("phase_epoch"),
            int("phase_epochs"),
            int("batch"),
            int("total_batches")
        ),
        "extraction_validation_progress" => format!(
            "Validating epoch {} / {} · batch {} / {}",
            int("epoch"),
            int("epochs"),
            int("batch"),
            int("total_batches")
        ),
        "extraction_evaluation_progress" => {
            format!("{} · {} / {}", text("phase"), int("completed_samples"), int("total_samples"))
        }
        "extraction_epoch_completed" => format!(
            "Completed epoch {} · {}",
            int("epoch"),
            if flag("selected") { "selected new best extractor" } else { "retained previous best extractor" }
        ),
        "extraction_heatmap_progress" => format!("Writing corner heatmaps · {} / {}", raw("completed"), raw("total")),
        "extraction_baseline_compared" => {
            if text("status") == "compared" {
                "Baseline comparison completed on the same real validation photographs.".into()
            } else {
                format!("Baseline comparison unavailable: {}", text("reason"))
            }
        }
        "extraction_sampling_warning" => return progress["message"].as_str().map(str::to_string),
        "extraction_learning_progress" => {
            format!("Real-photo learning check · {} / {} updates", int("updates"), int("maximum_updates"))
        }
        "extraction_learning_completed" => "Real-photo learning and checkpoint inference check passed.".into(),
        "extraction_amp_overflow" => {
            if flag("retrying") {
                format!(
                    "AMP overflow · retry {} / {} · loss scale {}",
                    raw("retry"),
                    raw("maximum_retries"),
                    g4(progress["loss_scale"].as_f64().unwrap_or(0.))
                )
            } else {
                "AMP overflow recovery exhausted · stopping safely".into()
            }
        }
        "extraction_cuda_smoke_completed" => "Extractor CUDA validation passed.".into(),
        "extraction_dataset_prepared" => format!("Prepared {} extraction samples.", int("records")),
        "extraction_evaluated" => "Extraction evaluation completed.".into(),
        "extraction_rectified" => "Rectification preview completed.".into(),
        _ => return None,
    })
}

pub(super) fn to_stages(stages: &[ProductionStageResult]) -> Vec<ui::Stage> {
    stages
        .iter()
        .map(|stage| ui::Stage {
            id: Some(stage.id.clone().into()),
            name: stage.name.clone().into(),
            status: format!("{:?}", stage.status).into(),
            detail: stage.detail.clone().into(),
            ..Default::default()
        })
        .collect()
}

fn small_muted(text: impl Into<SharedString>) -> Div {
    div().text_size(px(12.)).text_color(theme::text_muted()).child(text.into())
}

/// C#'s P1: 0.8734 → "87.3%".
fn percent(value: f64) -> String {
    format!("{:.1}%", value * 100.)
}

/// C#'s G4: four significant digits, scientific (E+04) from 10,000 up or below 0.00001.
fn g4(value: f64) -> String {
    let trim = |text: String| {
        if text.contains('.') { text.trim_end_matches('0').trim_end_matches('.').to_string() } else { text }
    };
    if value == 0. || !value.is_finite() {
        return value.to_string();
    }
    let exponent = value.abs().log10().floor() as i32;
    if (-5..4).contains(&exponent) {
        return trim(format!("{:.*}", (3 - exponent).max(0) as usize, value));
    }
    let scientific = format!("{value:.3E}");
    let (mantissa, power) = scientific.split_once('E').unwrap_or((&scientific, "0"));
    let power: i32 = power.parse().unwrap_or(0);
    format!("{}E{}{:02}", trim(mantissa.to_string()), if power < 0 { '-' } else { '+' }, power.abs())
}

/// A log line as the training pages show it: the local time, then the event's name when the line is one.
pub(super) fn display_line(line: &str, parsed: Option<&Value>) -> String {
    match parsed.and_then(|value| value.get("event")).and_then(Value::as_str) {
        Some(event) => format!("{} {event} · {line}", chrono::Local::now().format("%H:%M:%S")),
        None => format!("{} {line}", chrono::Local::now().format("%H:%M:%S")),
    }
}
