//! Card Embeddings (RunnerViewModel + Runner.tsx): checks and installs the CUDA training runtime, then trains the card
//! recognizer end to end and builds the phone files from the one this PC has.

use deckino_core::n0;
use std::future::Future;
use std::rc::Rc;
use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use deckino_core::error::is_cancelled;
use deckino_core::identity_production_workflow::{IdentityProductionSnapshot, ProductionWorkflowOutcome};
use deckino_core::log::ApplicationLogService;
use deckino_core::services::Services;
use deckino_core::training_environment::{CudaTrainingProfile, TrainingEnvironmentService, TrainingReadiness};
use deckino_core::training_run_sync::TrainingRunSyncService;
use futures::StreamExt;
use futures::channel::mpsc::UnboundedSender;
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{Disableable, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::extraction_training::{MAXIMUM_LOG_LINES, display_line, to_stages};
use crate::shell::PageEntry;
use crate::ui::{self, IconName, LogView, Tone};
use crate::{events, rt, theme};

const DESCRIPTION: &str = "Train the card recognizer, the model that tells which card a photo shows, on an NVIDIA GPU.";
const REQUIREMENT_NAMES: [&str; 10] = [
    "Compatible NVIDIA GPU",
    "NVIDIA driver",
    "GPU memory",
    "Free disk space",
    "Python 3.12 x64",
    "Deckino virtual environment",
    "PyTorch CUDA packages",
    "CUDA connection",
    "Pretrained MobileNet weights",
    "Paper image cache",
];

pub fn entry(services: Arc<Services>, _window: &mut Window, cx: &mut App) -> PageEntry {
    let page = cx.new(|cx| RunnerPage::new(services, cx));
    let opened = page.clone();
    PageEntry {
        key: "runner",
        name: "Embedding Training".into(),
        icon: IconName::Brain,
        view: page.into(),
        opened: Some(Rc::new(move |_, cx| opened.update(cx, |page, cx| page.refresh(cx)))),
        left: None,
    }
}

/// What the tokio side of a job reports back to the page, in order.
enum Update {
    Line(String, Option<Value>),
    Status(String),
    /// The readiness and whether the paper image cache is complete.
    Readiness(TrainingReadiness, bool),
    Production(std::result::Result<IdentityProductionSnapshot, String>),
}

/// The tokio side's end of the page: lines go to the application log at once, everything else to the page.
#[derive(Clone)]
struct Feed {
    tx: UnboundedSender<Update>,
    log: Arc<ApplicationLogService>,
}

impl Feed {
    /// The services' line callback (it must own what it uses).
    fn on_line(&self) -> impl Fn(&str, Option<&Value>) + Send + Sync + 'static {
        let feed = self.clone();
        move |line, parsed| feed.line(line, parsed)
    }

    fn send(&self, update: Update) {
        let _ = self.tx.unbounded_send(update);
    }

    fn line(&self, line: &str, parsed: Option<&Value>) {
        self.log.information("training", line);
        self.send(Update::Line(line.to_string(), parsed.cloned()));
    }
}

struct RequirementCheck {
    name: &'static str,
    detail: String,
    /// RequirementState: Passed, Warning, Missing or Pending.
    state: &'static str,
}

struct RunnerPage {
    services: Arc<Services>,
    log: Entity<LogView>,
    status: SharedString,
    requirement_checks: Vec<RequirementCheck>,
    requirements_headline: SharedString,
    requirements_caption: SharedString,
    environment_ready: bool,
    packages_ready: bool,
    paper_cache_ready: bool,
    // Venv + current CLI/torch only; unlike packages_ready it needs no CUDA, so CPU-only PCs can export.
    cli_ready: bool,
    selected_profile: Option<CudaTrainingProfile>,
    show_requirement_details: bool,
    is_busy: bool,
    production_summary: SharedString,
    production_stages: Vec<ui::Stage>,
    artwork_model_summary: SharedString,
    automatic_requirements_check_completed: bool,
    cancel: Option<CancellationToken>,
}

impl RunnerPage {
    fn new(services: Arc<Services>, cx: &mut Context<Self>) -> Self {
        let page = cx.weak_entity();
        let log = cx.new(|_| {
            LogView::new("", Some(services.paths.logs_root.clone())).bounded(MAXIMUM_LOG_LINES).on_clear(Rc::new(
                move |_, cx| {
                    let _ = page.update(cx, |page, cx| page.clear_all_logs(cx));
                },
            ))
        });
        let mut page = Self {
            services,
            log,
            status: "Check requirements to begin.".into(),
            requirement_checks: REQUIREMENT_NAMES
                .iter()
                .map(|name| RequirementCheck {
                    name,
                    detail: "Waiting for requirements check".into(),
                    state: "Pending",
                })
                .collect(),
            requirements_headline: "Readiness not checked".into(),
            requirements_caption: "Run the check to inspect this laptop without installing anything.".into(),
            environment_ready: false,
            packages_ready: false,
            paper_cache_ready: false,
            cli_ready: false,
            selected_profile: None,
            show_requirement_details: false,
            is_busy: false,
            production_summary: "Ready to train the card recognizer.".into(),
            production_stages: Vec::new(),
            artwork_model_summary: "No imported artwork model.".into(),
            automatic_requirements_check_completed: false,
            cancel: None,
        };
        page.refresh_production_state(cx);
        page.refresh_artwork_model_summary();
        page
    }

    fn can_run_production(&self) -> bool {
        !self.is_busy && self.environment_ready && self.selected_profile.is_some()
    }

    fn can_install_packages(&self) -> bool {
        !self.is_busy && !self.packages_ready
    }

    fn production_action_hint(&self) -> &'static str {
        if self.can_run_production() {
            ""
        } else if self.is_busy {
            "A workspace operation is currently running."
        } else if !self.environment_ready {
            "Complete Environment Readiness before starting artwork qualification."
        } else {
            "Check requirements again to select a compatible NVIDIA GPU."
        }
    }

    /// A run pulled on Model Sync changes the current model while this page is closed. The first visit also checks the
    /// requirements quickly, without opening the checklist.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.refresh_artwork_model_summary();
        cx.notify();
        if !self.automatic_requirements_check_completed {
            self.automatic_requirements_check_completed = true;
            self.refresh_requirements(false, cx);
        }
    }

    fn refresh_requirements(&mut self, show_details: bool, cx: &mut Context<Self>) {
        if show_details {
            self.show_requirement_details = true;
        }
        self.run_guarded(
            "Checking Python, CUDA, and disk space…".into(),
            false,
            cx,
            |services, feed, cancel| async move {
                let readiness = services.training_environment.check(&feed.on_line(), &cancel).await?;
                send_readiness(&services, &feed, readiness.clone())?;
                Ok(if readiness.ready() {
                    "Requirements are ready.".to_string()
                } else {
                    "Requirements are not ready; install packages or review the diagnostics.".to_string()
                })
            },
        );
    }

    fn install_packages(&mut self, cx: &mut Context<Self>) {
        let (tx, updates) = rt::channel();
        let feed = Feed { tx, log: self.services.log.clone() };
        let services = self.services.clone();
        let check =
            rt::spawn(
                async move { services.training_environment.check(&feed.on_line(), &CancellationToken::new()).await },
            );
        cx.spawn(async move |this, cx| {
            if !Self::drain(&this, updates, cx).await {
                return;
            }
            let readiness = match check.await {
                Ok(readiness) => readiness,
                Err(error) => {
                    let _ = this.update(cx, |page, cx| {
                        page.status = format!("Requirements check failed: {error:#}").into();
                        page.append_log(&format!("{error:?}"), cx);
                    });
                    return;
                }
            };
            if readiness.python_path.is_none() {
                let Ok(answer) = this.update(cx, |_, cx| {
                    events::ask(
                        cx,
                        "Install private Python",
                        "Python 3.12 x64 was not found. Install signed Python 3.12.10 into Deckino's private local runtime? No PATH entries or shortcuts will be created.",
                        "Install Python",
                        Some("Cancel"),
                    )
                }) else {
                    return;
                };
                if !answer.await.unwrap_or(false) {
                    let _ = this.update(cx, |page, cx| {
                        page.status = "Python installation cancelled.".into();
                        cx.notify();
                    });
                    return;
                }
            }
            // Either Python was found or its private installation was just approved.
            let _ = this.update(cx, |page, cx| page.install(cx));
        })
        .detach();
    }

    fn install(&mut self, cx: &mut Context<Self>) {
        self.run_guarded(
            "Installing the local CUDA training runtime…".into(),
            true,
            cx,
            |services, feed, cancel| async move {
                let on_line = feed.on_line();
                services.training_environment.install(true, &on_line, &cancel).await?;
                let updated = services.training_environment.check(&on_line, &cancel).await?;
                send_readiness(&services, &feed, updated.clone())?;
                if !updated.ready() {
                    bail!("Installation completed, but the compatible NVIDIA CUDA requirement is not satisfied.");
                }
                Ok("CUDA training runtime is ready.".to_string())
            },
        );
    }

    fn run_production(&mut self, cx: &mut Context<Self>) {
        let profile = self.selected_profile.clone();
        self.run_guarded(
            "Running the full identity workflow…".into(),
            true,
            cx,
            move |services, feed, cancel| async move {
                let profile =
                    profile.ok_or_else(|| anyhow!("Check requirements to select a compatible NVIDIA GPU."))?;
                ensure_paper_cache_complete(&services)?;
                let on_progress: &(dyn Fn(IdentityProductionSnapshot) + Send + Sync) =
                    &|snapshot| feed.send(Update::Production(Ok(snapshot)));
                let snapshot =
                    services.identity_workflow.run(&profile, &feed.on_line(), Some(on_progress), &cancel).await?;
                feed.send(Update::Production(Ok(snapshot.clone())));
                let shared = match (&snapshot.outcome, &snapshot.export_path) {
                    (ProductionWorkflowOutcome::Passed | ProductionWorkflowOutcome::Warning, Some(export_path)) => {
                        share_run(&services, &feed, &snapshot.model_version, export_path, &cancel).await
                    }
                    _ => String::new(),
                };
                let exported = snapshot
                    .export_path
                    .as_ref()
                    .and_then(|path| path.file_name())
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                Ok(match snapshot.outcome {
                    ProductionWorkflowOutcome::Passed => {
                        format!("Full identity baseline passed. Exported {exported}{shared}")
                    }
                    ProductionWorkflowOutcome::Warning => format!(
                        "Training completed and exported {exported}, but the baseline needs improvement.{shared}"
                    ),
                    _ => snapshot.summary.clone(),
                })
            },
        );
    }

    /// Packs the imported artwork model for the phone: ONNX embedding, packed index, labels and fixture.
    fn export_artwork_for_app(&mut self, cx: &mut Context<Self>) {
        let Some(pointer) = self.services.training_result_exporter.read_current_artwork_pointer() else {
            // This builds phone files from an imported model; it is not how a model leaves the training PC.
            let status = "Nothing to export: no artwork model has been pulled to this PC. Pull one on Model Sync (the training PC uploads each finished run).";
            self.status = status.into();
            self.append_log(status, cx);
            return;
        };
        let cli_ready = self.cli_ready;
        let model_version = pointer.model_version;
        self.run_guarded(
            format!("Exporting {model_version} for the app on the CPU…"),
            true,
            cx,
            move |services, feed, cancel| async move {
                if !cli_ready {
                    bail!(
                        "Check requirements and install packages first; the app export needs the current training CLI."
                    );
                }
                let paths = &services.paths;
                let output = paths.mobile_artwork_root.join(&model_version);
                let arguments: Vec<String> = vec![
                    "-m".into(),
                    "deckino_training".into(),
                    "export-artwork-mobile".into(),
                    "--artifacts-root".into(),
                    paths.artifacts_root.display().to_string(),
                    "--model-version".into(),
                    model_version.clone(),
                    "--output".into(),
                    output.display().to_string(),
                ];
                let result = services
                    .python_runner
                    .run(
                        &paths.virtual_environment_python(),
                        &arguments,
                        &format!("{model_version}-export-artwork-mobile"),
                        &feed.on_line(),
                        &cancel,
                        None,
                    )
                    .await?;
                if result.exit_code != 0 {
                    bail!(
                        "Artwork app export failed with exit code {}. See {}",
                        result.exit_code,
                        result.log_path.display()
                    );
                }
                if !output.join("mobile-manifest.json").is_file() {
                    bail!("Artwork app export finished without writing mobile-manifest.json.");
                }
                events::open_folder(&output);
                Ok(format!("Exported {model_version} for the app to {}.", output.display()))
            },
        );
    }

    fn refresh_artwork_model_summary(&mut self) {
        self.artwork_model_summary = match self.services.training_result_exporter.read_current_artwork_pointer() {
            None => "None yet: train one, or pull one on Model Sync.".into(),
            Some(pointer) => {
                let source = pointer
                    .source_zip
                    .as_deref()
                    .and_then(|zip| std::path::Path::new(zip).file_name())
                    .map(|name| format!(" · from {}", name.to_string_lossy()))
                    .unwrap_or_default();
                format!(
                    "Imported {} · {} prototypes · {}{source}",
                    pointer.model_version,
                    n0(pointer.prototypes as i64),
                    if pointer.qualified { "qualified" } else { "not qualified" }
                )
                .into()
            }
        };
    }

    fn cancel(&mut self) {
        if let Some(cancel) = &self.cancel {
            cancel.cancel();
        }
    }

    fn open_training_folder(&self) {
        events::open_folder(&self.services.paths.training_root);
    }

    fn open_results_folder(&self) {
        events::open_folder(&self.services.paths.training_root.join("results"));
    }

    fn clear_all_logs(&mut self, cx: &mut Context<Self>) {
        let answer = events::ask(
            cx,
            "Clear activity log",
            "Clear every line shown here and permanently empty the current Deckino application log file? Separate training-stage logs and older daily logs will be preserved.",
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

    /// Applies what a job reports until it ends. False when the page is gone.
    async fn drain(
        this: &WeakEntity<Self>,
        mut updates: futures::channel::mpsc::UnboundedReceiver<Update>,
        cx: &mut AsyncApp,
    ) -> bool {
        while let Some(update) = updates.next().await {
            if this.update(cx, |page, cx| page.apply(update, cx)).is_err() {
                return false;
            }
        }
        true
    }

    /// One job at a time (under the workspace lock when `coordinate`); its result becomes the status, and the
    /// production timeline is read again at the end.
    fn run_guarded<Fut>(
        &mut self,
        working_status: String,
        coordinate: bool,
        cx: &mut Context<Self>,
        action: impl FnOnce(Arc<Services>, Feed, CancellationToken) -> Fut,
    ) where
        Fut: Future<Output = Result<String>> + Send + 'static,
    {
        if self.is_busy {
            return;
        }
        self.is_busy = true;
        self.services.log.information("operation", &format!("Started: {working_status}"));
        self.status = working_status.into();
        let cancel = CancellationToken::new();
        self.cancel = Some(cancel.clone());
        cx.notify();
        let lease = coordinate.then(|| self.services.coordinator.acquire("model training"));
        let (tx, updates) = rt::channel();
        let work = action(self.services.clone(), Feed { tx, log: self.services.log.clone() }, cancel);
        let job = rt::spawn(async move {
            let _lease = lease.transpose()?;
            work.await
        });
        cx.spawn(async move |this, cx| {
            if !Self::drain(&this, updates, cx).await {
                return;
            }
            let result = job.await;
            let _ = this.update(cx, |page, cx| {
                match result {
                    Ok(status) => {
                        page.services.log.information("operation", &format!("Completed: {status}"));
                        page.status = status.into();
                    }
                    Err(error) if is_cancelled(&error) => {
                        page.status = "Cancelled.".into();
                        page.services.log.information("operation", "Cancelled by the user.");
                    }
                    Err(error) => {
                        page.status = format!("Failed: {error:#}").into();
                        page.append_log(&format!("{error:?}"), cx);
                    }
                }
                page.cancel = None;
                page.is_busy = false;
                page.refresh_production_state(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn refresh_production_state(&mut self, cx: &mut Context<Self>) {
        let services = self.services.clone();
        let inspect =
            rt::spawn(async move { Ok(services.identity_workflow.inspect().map_err(|error| format!("{error:#}"))) });
        cx.spawn(async move |this, cx| {
            if let Ok(snapshot) = inspect.await {
                let _ = this.update(cx, |page, cx| page.apply(Update::Production(snapshot), cx));
            }
        })
        .detach();
    }

    /// A line of the page's own (not from a job's callback): logged and shown.
    fn append_log(&mut self, line: &str, cx: &mut Context<Self>) {
        self.services.log.information("training", line);
        self.log.update(cx, |log, cx| log.push(display_line(line, None), cx));
    }

    fn apply(&mut self, update: Update, cx: &mut Context<Self>) {
        match update {
            Update::Line(line, parsed) => {
                self.log.update(cx, |log, cx| log.push(display_line(&line, parsed.as_ref()), cx));
                if let Some(status) = parsed.as_ref().and_then(runner_status) {
                    self.status = status.into();
                }
            }
            Update::Status(status) => self.status = status.into(),
            Update::Readiness(readiness, paper_cache_ready) => self.apply_readiness(&readiness, paper_cache_ready),
            Update::Production(Ok(snapshot)) => {
                self.production_summary = snapshot.summary.into();
                self.production_stages = to_stages(&snapshot.stages);
            }
            Update::Production(Err(message)) => {
                self.production_summary = message.clone().into();
                self.production_stages.clear();
                self.append_log(&message, cx);
            }
        }
        cx.notify();
    }

    fn apply_readiness(&mut self, readiness: &TrainingReadiness, paper_cache_ready: bool) {
        self.paper_cache_ready = paper_cache_ready;
        self.cli_ready = readiness.virtual_environment_ready && readiness.packages_ready;
        self.packages_ready = readiness.ready();
        self.environment_ready = readiness.ready() && paper_cache_ready;
        self.selected_profile = match (readiness.gpu_index, &readiness.gpu_name, readiness.vram_mib) {
            (Some(index), Some(name), Some(vram)) => {
                Some(TrainingEnvironmentService::create_training_profile(index, name, vram))
            }
            _ => None,
        };

        let state = |passed: bool| if passed { "Passed" } else { "Missing" };
        let vram_ready = readiness.vram_mib.is_some_and(|vram| vram >= TrainingEnvironmentService::MINIMUM_VRAM_MIB);
        let disk_state = if readiness.free_disk_gib >= 20. {
            "Passed"
        } else if readiness.has_minimum_disk_space {
            "Warning"
        } else {
            "Missing"
        };
        let unknown = |value: &Option<String>| value.clone().unwrap_or_default();
        let checks = vec![
            RequirementCheck {
                name: REQUIREMENT_NAMES[0],
                detail: match &self.selected_profile {
                    None => readiness
                        .gpu_name
                        .clone()
                        .unwrap_or_else(|| "No NVIDIA GPU with at least 6,000 MiB VRAM was detected".into()),
                    Some(profile) => {
                        format!("{} · device {} · {}", profile.gpu_name, profile.device_index, profile.label)
                    }
                },
                state: state(self.selected_profile.is_some()),
            },
            RequirementCheck {
                name: REQUIREMENT_NAMES[1],
                detail: match &readiness.driver_version {
                    Some(driver) => format!("Driver {driver}"),
                    None => "Driver version unavailable".into(),
                },
                state: state(readiness.driver_version.is_some()),
            },
            RequirementCheck {
                name: REQUIREMENT_NAMES[2],
                detail: match readiness.vram_mib {
                    Some(memory) => format!(
                        "{} MiB available · {} MiB minimum",
                        n0(memory),
                        n0(TrainingEnvironmentService::MINIMUM_VRAM_MIB)
                    ),
                    None => "Memory information unavailable".into(),
                },
                state: state(vram_ready),
            },
            RequirementCheck {
                name: REQUIREMENT_NAMES[3],
                detail: format!("{:.1} GiB free · 15 GiB minimum · 20 GiB recommended", readiness.free_disk_gib),
                state: disk_state,
            },
            RequirementCheck {
                name: REQUIREMENT_NAMES[4],
                detail: readiness
                    .python_path
                    .clone()
                    .unwrap_or_else(|| "Not installed — Deckino can install a private copy".into()),
                state: state(readiness.python_path.is_some()),
            },
            RequirementCheck {
                name: REQUIREMENT_NAMES[5],
                detail: if readiness.virtual_environment_ready {
                    "Local runtime is present"
                } else {
                    "Not created yet"
                }
                .into(),
                state: state(readiness.virtual_environment_ready),
            },
            RequirementCheck {
                name: REQUIREMENT_NAMES[6],
                detail: if readiness.packages_ready {
                    format!("PyTorch {} · CUDA {}", unknown(&readiness.torch_version), unknown(&readiness.cuda_runtime))
                } else {
                    "Pinned CUDA packages are not installed".into()
                },
                state: state(readiness.packages_ready),
            },
            RequirementCheck {
                name: REQUIREMENT_NAMES[7],
                detail: if readiness.cuda_ready {
                    "PyTorch can use the selected GPU"
                } else {
                    "Checked after the local runtime is installed"
                }
                .into(),
                state: if readiness.cuda_ready {
                    "Passed"
                } else if readiness.packages_ready {
                    "Missing"
                } else {
                    "Pending"
                },
            },
            RequirementCheck {
                name: REQUIREMENT_NAMES[8],
                detail: if readiness.pretrained_weights_cached {
                    "Cached inside Deckino data"
                } else {
                    "Downloaded during package installation"
                }
                .into(),
                state: state(readiness.pretrained_weights_cached),
            },
            RequirementCheck {
                name: REQUIREMENT_NAMES[9],
                detail: if paper_cache_ready {
                    "All eligible Scryfall art is available"
                } else {
                    "Complete Scryfall Sync before preparing the dataset"
                }
                .into(),
                state: state(paper_cache_ready),
            },
        ];
        let passed = checks.iter().filter(|check| check.state == "Passed").count();
        self.requirements_headline =
            if self.environment_ready { "✓ All environment requirements met" } else { "Setup required" }.into();
        self.requirements_caption = match (&self.selected_profile, self.environment_ready) {
            (Some(profile), true) => format!("{} is ready at batch {}.", profile.gpu_name, profile.batch_size).into(),
            _ => format!("{} items need attention. Open the checklist for details.", checks.len() - passed).into(),
        };
        self.requirement_checks = checks;
    }

    fn render_checklist(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .id("checklist-overlay")
            .absolute()
            .inset_0()
            .flex()
            .justify_end()
            .bg(theme::color_alpha(0x0B061099))
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.show_requirement_details = false;
                    cx.notify();
                }),
            )
            .child(
                v_flex()
                    .id("checklist")
                    .w(px(420.))
                    .max_w_full()
                    .h_full()
                    .p(px(20.))
                    .bg(theme::surface())
                    .border_l_1()
                    .border_color(theme::hairline())
                    .shadow_lg()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        h_flex()
                            .flex_none()
                            .justify_between()
                            .mb(px(8.))
                            .child(div().font_weight(FontWeight::BOLD).child("Environment checklist"))
                            .child(ui::icon_button("close-checklist", IconName::X, "Close").on_click(cx.listener(
                                |this, _, _, cx| {
                                    this.show_requirement_details = false;
                                    cx.notify();
                                },
                            ))),
                    )
                    .child(v_flex().id("checklist-items").flex_1().min_h_0().overflow_y_scroll().children(
                        self.requirement_checks.iter().enumerate().map(|(index, check)| {
                            h_flex()
                                .items_start()
                                .gap(px(10.))
                                .py(px(10.))
                                .border_b_1()
                                .border_color(theme::color_alpha(0xFFFFFF0F))
                                .child(div().pt(px(5.)).child(ui::dot(
                                    SharedString::from(format!("check-dot-{index}")),
                                    ui::status_tone(check.state),
                                    false,
                                )))
                                .child(
                                    v_flex()
                                        .gap(px(2.))
                                        .min_w_0()
                                        .child(
                                            div()
                                                .text_size(px(13.))
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .child(check.name),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(12.))
                                                .text_color(theme::text_muted())
                                                .child(check.detail.clone()),
                                        ),
                                )
                        }),
                    )),
            )
            .into_any_element()
    }
}

impl Render for RunnerPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let status = self.status.clone();
        self.log.update(cx, |log, _| log.title = status);
        let header = ui::page_header(
            "Embedding Training",
            DESCRIPTION,
            None,
            vec![
                ui::icon_button("open-training-folder", IconName::FolderOpen, "Open training folder")
                    .on_click(cx.listener(|this, _, _, _| this.open_training_folder()))
                    .into_any_element(),
                ui::run_button(
                    "runner-train",
                    self.is_busy,
                    IconName::Play,
                    "Train",
                    !self.can_run_production(),
                    false,
                    cx.listener(|this, _, _, cx| this.run_production(cx)),
                    cx.listener(|this, _, _, _| this.cancel()),
                ),
            ],
        );

        let caption = self.requirements_caption.clone();
        let readiness = ui::section(None, None, vec![]).child(
            h_flex()
                .justify_between()
                .gap(px(16.))
                .child(
                    h_flex()
                        .gap(px(16.))
                        .min_w_0()
                        .child(ui::dot(
                            "readiness-dot",
                            if self.environment_ready { Tone::Success } else { Tone::Warning },
                            false,
                        ))
                        .child(
                            v_flex()
                                .min_w_0()
                                .child(div().font_weight(FontWeight::BOLD).child(self.requirements_headline.clone()))
                                .child(
                                    ui::muted(self.requirements_caption.clone())
                                        .id("requirements-caption")
                                        .truncate()
                                        .tooltip(move |window, cx| Tooltip::new(caption.clone()).build(window, cx)),
                                ),
                        ),
                )
                .child(
                    h_flex()
                        .flex_none()
                        .gap(px(8.))
                        .child(
                            Button::new("toggle-checklist")
                                .ghost()
                                .rounded(px(999.))
                                .icon(ui::icon(IconName::ListChecks))
                                .label("Checklist")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.show_requirement_details = !this.show_requirement_details;
                                    cx.notify();
                                })),
                        )
                        .child(
                            ui::secondary_button(
                                "check-requirements",
                                "Check requirements",
                                Some(IconName::Stethoscope),
                            )
                            .disabled(self.is_busy)
                            .on_click(cx.listener(|this, _, _, cx| this.refresh_requirements(true, cx))),
                        )
                        .child(
                            ui::secondary_button(
                                "install-packages",
                                "Install required packages",
                                Some(IconName::Package),
                            )
                            .disabled(self.is_busy || !self.can_install_packages())
                            .on_click(cx.listener(|this, _, _, cx| this.install_packages(cx))),
                        ),
                ),
        );

        let hint = self.production_action_hint();
        let production = ui::section(None, None, vec![])
            .child(div().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).child(self.production_summary.clone()))
            .when(!hint.is_empty(), |el| {
                el.child(div().mt(px(4.)).text_size(px(12.)).text_color(theme::warning()).child(hint))
            })
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
                            .child(div().text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).child("Current card recognizer"))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(theme::text_muted())
                                    .truncate()
                                    .child(self.artwork_model_summary.clone()),
                            ),
                    )
                    .child(
                        ui::icon_button(
                            "export-artwork-for-app",
                            IconName::Smartphone,
                            "Build the phone app files from this PC's card recognizer (CPU). The Android start script also does this.",
                        )
                        .disabled(self.is_busy)
                        .on_click(cx.listener(|this, _, _, cx| this.export_artwork_for_app(cx))),
                    )
                    .child(
                        ui::icon_button(
                            "open-results-folder",
                            IconName::FolderOpen,
                            "Open the results folder, to share runs between PCs",
                        )
                        .on_click(cx.listener(|this, _, _, _| this.open_results_folder())),
                    ),
            );

        let column_width = if window.viewport_size().width < px(1400.) { 360. } else { 440. };
        let split = div()
            .flex()
            .flex_1()
            .min_h_0()
            .gap(px(16.))
            .child(
                v_flex()
                    .id("runner-column")
                    .flex_none()
                    .w(px(column_width))
                    .min_h_0()
                    .gap(px(16.))
                    .overflow_y_scroll()
                    .child(production)
                    .child(
                        ui::section(Some("Stages"), None, vec![])
                            .child(ui::step_list("runner-stages", &self.production_stages)),
                    ),
            )
            .child(div().flex_1().min_w_0().min_h_0().child(self.log.clone()));

        ui::page("runner", false)
            .relative()
            .child(header)
            .child(readiness)
            .child(split)
            .when(self.show_requirement_details, |el| el.child(self.render_checklist(cx)))
    }
}

/// Sends the readiness, with the paper cache's state and the production timeline read again (ApplyReadinessAsync).
fn send_readiness(services: &Services, feed: &Feed, readiness: TrainingReadiness) -> Result<()> {
    let paper_cache_ready = incomplete_paper_images(services)? == 0;
    feed.send(Update::Readiness(readiness, paper_cache_ready));
    feed.send(Update::Production(services.identity_workflow.inspect().map_err(|error| format!("{error:#}"))));
    Ok(())
}

fn ensure_paper_cache_complete(services: &Services) -> Result<()> {
    let incomplete = incomplete_paper_images(services)?;
    if incomplete > 0 {
        bail!("The paper image cache is incomplete ({} images remaining). Finish Scryfall Sync first.", n0(incomplete));
    }
    Ok(())
}

/// Faces still waiting to download. Failed faces (an image Scryfall no longer serves) do not hold training back:
/// dataset preparation leaves them out and reports how many.
fn incomplete_paper_images(services: &Services) -> Result<i64> {
    let connection = services.database.open()?;
    Ok(connection.query_row(
        "SELECT COUNT(*)
        FROM card_images i
        JOIN cards c ON c.scryfall_id = i.scryfall_id
        WHERE c.is_paper = 1 AND c.oracle_id IS NOT NULL AND i.status = 'pending'",
        [],
        |row| row.get(0),
    )?)
}

/// A finished run goes to the bucket for the other PCs. The run itself succeeded either way, so a missing connection
/// or a failed upload is only a note; the next start uploads it (TrainingRunSyncService::upload_missing).
async fn share_run(
    services: &Services,
    feed: &Feed,
    model_version: &str,
    zip_path: &std::path::Path,
    cancel: &CancellationToken,
) -> String {
    let runs = &services.training_run_sync;
    if !runs.is_configured() {
        return " Not uploaded: connect the bucket on Dataset Sync; the next start uploads it.".into();
    }
    feed.send(Update::Status(format!("Uploading {model_version} to the bucket…")));
    match runs.upload(TrainingRunSyncService::ARTWORK_KIND, model_version, zip_path, cancel).await {
        Ok(()) => {
            feed.line(&format!("Uploaded {model_version} to the bucket."), None);
            " Uploaded it to the bucket for the other PCs.".into()
        }
        // Training finished; cancelling only stopped the upload.
        Err(error) if is_cancelled(&error) => {
            feed.line("Upload to the bucket cancelled; the next start uploads it.", None);
            " The upload was cancelled; the next start uploads it.".into()
        }
        Err(error) => {
            feed.line(&format!("Upload to the bucket failed: {error:#}"), None);
            format!(" The upload to the bucket failed ({error:#}); the next start tries again.")
        }
    }
}

/// The status line a training event stands for; None keeps the current one.
fn runner_status(progress: &Value) -> Option<String> {
    let int = |key: &str| progress[key].as_i64().unwrap_or(0);
    Some(match progress.get("event")?.as_str()? {
        "prepare_progress" => format!("Scanning images {} / {}…", n0(int("scanned")), n0(int("total"))),
        "training_progress" => format!("Epoch {} · batch {} / {}", int("epoch"), int("batch"), int("batches")),
        "recognition" => {
            if progress["rejected"].as_bool().unwrap_or(false) {
                "Recognition rejected: confidence was below threshold.".into()
            } else {
                format!(
                    "Recognized {} ({})",
                    progress["card_name"].as_str().unwrap_or_default(),
                    progress["oracle_id"].as_str().unwrap_or_default()
                )
            }
        }
        _ => return None,
    })
}
