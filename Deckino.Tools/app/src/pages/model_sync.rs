//! Model Sync (the C# ModelSyncViewModel and ModelSync.tsx): training runs from the bucket, and the models the app
//! downloads. The bucket connection lives on Dataset Sync.

use deckino_core::n0;
use std::rc::Rc;
use std::sync::Arc;

use deckino_core::services::Services;
use deckino_core::training_run_sync::{BucketTrainingRun, TrainingRunSyncService};
use futures::StreamExt;
use gpui_kit::component::progress::Progress;
use gpui_kit::component::{Disableable, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use tokio_util::sync::CancellationToken;

use super::dataset_sync::replace_ignore_case;
use crate::rt;
use crate::shell::PageEntry;
use crate::theme;
use crate::ui::{self, IconName};

const DISPLAY_NAME: &str = "Model Sync";
const DESCRIPTION: &str =
    "Pull training runs from the bucket to this PC, and publish the current models for the app to download.";
const NOT_CONNECTED: &str = "Connect the bucket on Dataset Sync to see the training runs.";

pub fn entry(services: Arc<Services>, _window: &mut Window, cx: &mut App) -> PageEntry {
    let view = cx.new(|_| ModelSyncPage::new(services));
    let page = view.clone();
    PageEntry {
        key: "modelSync",
        name: "Model Sync".into(),
        icon: IconName::Package,
        view: view.into(),
        opened: Some(Rc::new(move |_, cx| page.update(cx, |page, cx| page.refresh(cx)))),
        left: None,
    }
}

struct TrainingRunItem {
    run: BucketTrainingRun,
    detail: String,
}

enum PublishProgress {
    Line(String),
    Uploaded(i32),
}

pub struct ModelSyncPage {
    services: Arc<Services>,
    runs: Vec<TrainingRunItem>,
    selected_run: Option<usize>,
    runs_status: String,
    is_configured: bool,
    is_busy: bool,
    // The pull's bar: how much of the run has downloaded, 100 while it imports; None hides it.
    pull_percent: Option<i32>,
    // What Publish would send: this PC's current model of each kind, if it has one.
    current_extractor: Option<String>,
    current_artwork: Option<String>,
    // The publish's bar: which model is publishing, and how much of its files have uploaded (None while the script
    // makes them, which says nothing of how far it is).
    publishing_kind: Option<&'static str>,
    publish_percent: Option<i32>,
    // Published since the page opened: their rows say so until the Toolbox closes.
    published_kinds: Vec<&'static str>,
    publish_status: String,
}

impl ModelSyncPage {
    fn new(services: Arc<Services>) -> Self {
        Self {
            services,
            runs: Vec::new(),
            selected_run: None,
            runs_status: NOT_CONNECTED.into(),
            is_configured: false,
            is_busy: false,
            pull_percent: None,
            current_extractor: None,
            current_artwork: None,
            publishing_kind: None,
            publish_percent: None,
            published_kinds: Vec::new(),
            publish_status: "Makes the current model's phone files, checks the app's own code against them, then \
                             publishes it. Apps download it on Wi-Fi at their next start."
                .into(),
        }
    }

    // The connection is saved on Dataset Sync, so it is read again each time this page opens.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.is_configured = self.services.camera_dataset_sync.load_credentials().is_some();
        if !self.is_configured {
            self.runs_status = NOT_CONNECTED.into();
        }
        let load = self.is_configured && !self.is_busy;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let services = this.read_with(cx, |page, _| page.services.clone())?;
            let versions = rt::spawn(async move { anyhow::Ok(current_versions(&services)) }).await?;
            this.update(cx, |page, cx| {
                (page.current_artwork, page.current_extractor) = versions;
                cx.notify();
            })?;
            if load {
                Self::load_runs(&this, cx).await?;
            }
            anyhow::Ok(())
        })
        .detach();
    }

    fn refresh_runs(&mut self, cx: &mut Context<Self>) {
        if !self.can_use_bucket() {
            return;
        }
        self.is_busy = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let loaded = Self::load_runs(&this, cx).await;
            this.update(cx, |page, cx| {
                page.is_busy = false;
                cx.notify();
            })?;
            loaded
        })
        .detach();
    }

    async fn load_runs(this: &WeakEntity<Self>, cx: &mut AsyncApp) -> anyhow::Result<()> {
        let services = this.update(cx, |page, cx| {
            page.runs_status = "Listing the training runs in the bucket…".into();
            cx.notify();
            page.services.clone()
        })?;
        let listing = services.clone();
        let result = rt::spawn(async move {
            let runs = listing.training_run_sync.list(&CancellationToken::new()).await?;
            anyhow::Ok((runs, current_versions(&listing)))
        })
        .await;
        this.update(cx, |page, cx| {
            page.runs_status = match result {
                Ok((runs, versions)) => {
                    let count = runs.len();
                    page.show_runs(runs, versions);
                    if count == 0 {
                        "No training runs in the bucket yet. A finished run on the training PC uploads itself.".into()
                    } else {
                        format!("{} runs in the bucket, newest first.", n0(count as i64))
                    }
                }
                Err(error) => format!("Could not list the training runs: {}", redact(&error, &services)),
            };
            cx.notify();
        })
    }

    // Pulls a run from the bucket and imports it: it becomes this PC's current model of its kind (Card
    // Identification and the annotator's suggestions use it, Build phone files exports it).
    fn pull_run(&mut self, cx: &mut Context<Self>) {
        if self.is_busy {
            return;
        }
        let Some(run) = self.selected_run.and_then(|index| self.runs.get(index)).map(|item| item.run.clone()) else {
            return;
        };
        self.is_busy = true;
        let size = run.bytes as f64 / 1_048_576.0;
        self.runs_status = format!("Downloading {} ({} MB)…", run.model_version, n1(size));
        self.pull_percent = Some(0);
        cx.notify();
        let services = self.services.clone();
        let (progress, mut percents) = rt::channel::<i32>();
        let target = run.clone();
        let pull = rt::spawn(async move {
            let _lease = services.coordinator.acquire("import a training run")?;
            let report = move |percent: i32| {
                let _ = progress.unbounded_send(percent);
            };
            let imported = services
                .training_run_sync
                .sync_down(&target, &CancellationToken::new(), Some(&report as &(dyn Fn(i32) + Sync)))
                .await?;
            anyhow::Ok((imported, current_versions(&services)))
        });
        cx.spawn(async move |this, cx| {
            // The bucket reports many times per percent: only a new percent reaches the page.
            while let Some(percent) = percents.next().await {
                this.update(cx, |page, cx| {
                    if page.pull_percent == Some(percent) {
                        return;
                    }
                    page.pull_percent = Some(percent);
                    page.runs_status = if percent < 100 {
                        format!(
                            "Downloading {}: {} of {} MB…",
                            run.model_version,
                            n1(size * percent as f64 / 100.),
                            n1(size)
                        )
                    } else {
                        format!("Importing {}…", run.model_version)
                    };
                    cx.notify();
                })?;
            }
            let result = pull.await;
            this.update(cx, |page, cx| {
                match result {
                    Ok((imported, versions)) => {
                        page.runs_status = format!("Imported {imported}. It is this PC's current {} model.", run.kind);
                        let runs = page.runs.iter().map(|item| item.run.clone()).collect();
                        page.show_runs(runs, versions);
                    }
                    Err(error) => page.runs_status = format!("Pull failed: {}", redact(&error, &page.services)),
                }
                page.is_busy = false;
                page.pull_percent = None;
                cx.notify();
            })
        })
        .detach();
    }

    fn show_runs(&mut self, runs: Vec<BucketTrainingRun>, (artwork, extractor): (Option<String>, Option<String>)) {
        self.current_artwork = artwork;
        self.current_extractor = extractor;
        let selected = self.selected_run.and_then(|index| self.runs.get(index)).map(|item| item.run.clone());
        self.runs = runs
            .into_iter()
            .map(|run| {
                let current = if run.kind == TrainingRunSyncService::ARTWORK_KIND {
                    &self.current_artwork
                } else {
                    &self.current_extractor
                };
                let detail = format!(
                    "{} MB{}",
                    n1(run.bytes as f64 / 1_048_576.0),
                    if current.as_deref() == Some(run.model_version.as_str()) { " · current on this PC" } else { "" }
                );
                TrainingRunItem { run, detail }
            })
            .collect();
        self.selected_run = selected
            .and_then(|selected| self.runs.iter().position(|item| item.run == selected))
            .or((!self.runs.is_empty()).then_some(0));
    }

    fn publish(&mut self, kind: &'static str, cx: &mut Context<Self>) {
        if !self.can_use_bucket() {
            return;
        }
        self.is_busy = true;
        self.publishing_kind = Some(kind);
        self.published_kinds.retain(|published| *published != kind);
        self.publish_status = format!("Publishing the current {kind} model…");
        cx.notify();
        let services = self.services.clone();
        let (progress, mut reports) = rt::channel::<PublishProgress>();
        let publish = rt::spawn(async move {
            let lines = progress.clone();
            let line = move |line: &str| {
                let _ = lines.unbounded_send(PublishProgress::Line(line.to_string()));
            };
            let uploaded = move |percent: i32| {
                let _ = progress.unbounded_send(PublishProgress::Uploaded(percent));
            };
            services
                .model_publish
                .publish(kind, &line, &CancellationToken::new(), Some(&uploaded as &(dyn Fn(i32) + Sync)))
                .await
        });
        cx.spawn(async move |this, cx| {
            while let Some(report) = reports.next().await {
                this.update(cx, |page, cx| {
                    match report {
                        PublishProgress::Line(line) => {
                            page.publish_status = format!("Making the {kind} model's phone files: {line}");
                        }
                        // The bucket reports many times per percent: only a new percent reaches the page.
                        PublishProgress::Uploaded(percent) => {
                            if page.publish_percent == Some(percent) {
                                return;
                            }
                            page.publish_percent = Some(percent);
                            page.publish_status = format!("Uploading the {kind} model's phone files: {percent}%");
                        }
                    }
                    cx.notify();
                })?;
            }
            let result = publish.await;
            this.update(cx, |page, cx| {
                page.publish_status = match result {
                    Ok(published) => {
                        page.published_kinds.push(kind);
                        format!(
                            "Published {} (schema {}, {} MB). Apps built for that schema download it on Wi-Fi at their \
                             next start.",
                            published.model_version,
                            published.schema,
                            n1(published.bytes as f64 / 1_048_576.0)
                        )
                    }
                    Err(error) => format!("Publish failed: {}", redact(&error, &page.services)),
                };
                page.is_busy = false;
                page.publishing_kind = None;
                page.publish_percent = None;
                cx.notify();
            })
        })
        .detach();
    }

    fn can_use_bucket(&self) -> bool {
        !self.is_busy && self.is_configured
    }

    fn can_pull_run(&self) -> bool {
        !self.is_busy && self.selected_run.is_some()
    }

    // One model the app downloads, named as the app's Profile names it, with the version Publish would send.
    fn publish_row(&self, icon: IconName, name: &'static str, kind: &'static str, cx: &mut Context<Self>) -> Div {
        let version = if kind == "artwork" { &self.current_artwork } else { &self.current_extractor };
        // None while it isn't publishing; else the uploaded percent, or -1 while its phone files are made.
        let progress = (self.publishing_kind == Some(kind)).then(|| self.publish_percent.unwrap_or(-1));
        let published = self.published_kinds.contains(&kind);
        v_flex()
            .gap(px(8.))
            .child(
                h_flex()
                    .gap(px(16.))
                    .child(
                        div()
                            .flex()
                            .flex_none()
                            .items_center()
                            .justify_center()
                            .size(px(42.))
                            .rounded(px(10.))
                            .bg(theme::tint())
                            .text_color(theme::lavender())
                            .child(ui::icon(icon)),
                    )
                    .child(
                        v_flex().flex_1().min_w_0().child(div().font_weight(FontWeight::BOLD).child(name)).child(
                            h_flex()
                                .min_w_0()
                                .text_size(px(12.))
                                .text_color(theme::text_muted())
                                .child(div().truncate().child(format!(
                                    "{kind} · {}",
                                    version.as_deref().map(trained_on).unwrap_or_else(|| "none on this PC yet".into())
                                )))
                                .when(published, |el| {
                                    el.child(
                                        h_flex()
                                            .flex_none()
                                            .gap(px(4.))
                                            .text_color(theme::success())
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child("\u{a0}· published")
                                            .child(ui::icon(IconName::CircleCheck).size(px(12.))),
                                    )
                                }),
                        ),
                    )
                    .child(
                        ui::secondary_button(
                            SharedString::from(format!("publish-{kind}")),
                            "Publish",
                            Some(IconName::CloudUpload),
                        )
                        .disabled(!self.can_use_bucket())
                        .on_click(cx.listener(move |page, _, _, cx| page.publish(kind, cx))),
                    ),
            )
            .children(progress.map(|progress| {
                // Making the phone files can't say how far it is: a moving bar. Uploading fills it.
                Progress::new(SharedString::from(format!("publish-progress-{kind}")))
                    .loading(progress < 0)
                    .value(progress.max(0) as f32)
            }))
    }
}

impl Render for ModelSyncPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let publishing = ui::section(
            Some("App model updates"),
            Some("The app's extractor and artwork recognizer, published to the same bucket for apps to download."),
            vec![],
        )
        .child(ui::muted(self.publish_status.clone()))
        .child(
            v_flex()
                .mt(px(16.))
                .gap(px(12.))
                .child(self.publish_row(IconName::Focus, "Card finder", "extractor", cx))
                .child(self.publish_row(IconName::Sparkles, "Card recognizer", "artwork", cx)),
        );

        let runs: AnyElement = if self.runs.is_empty() {
            ui::empty_state(
                IconName::Image,
                "No runs listed",
                Some("They show here once the bucket is connected on Dataset Sync."),
            )
        } else {
            v_flex()
                .id("training-runs")
                .flex_1()
                .min_h_0()
                .gap(px(4.))
                .overflow_y_scroll()
                .children(self.runs.iter().enumerate().map(|(index, item)| {
                    let selected = self.selected_run == Some(index);
                    h_flex()
                        .id(("training-run", index))
                        .flex_none()
                        .gap(px(16.))
                        .py(px(10.))
                        .px(px(12.))
                        .rounded(px(8.))
                        .border_1()
                        .border_color(if selected { theme::violet() } else { transparent_black() })
                        .cursor_pointer()
                        .map(|el| {
                            if selected {
                                el.bg(theme::tint_strong())
                            } else {
                                el.hover(|el| el.bg(theme::color_alpha(0xFFFFFF0A)))
                            }
                        })
                        .on_click(cx.listener(move |page, _, _, cx| {
                            page.selected_run = Some(index);
                            cx.notify();
                        }))
                        .child(
                            div()
                                .flex()
                                .flex_none()
                                .justify_center()
                                .w(px(92.))
                                .py(px(2.))
                                .rounded_full()
                                .bg(theme::tint())
                                .text_color(theme::lavender())
                                .text_size(px(11.))
                                .font_weight(FontWeight::BOLD)
                                .child(item.run.kind.to_uppercase()),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(item.run.model_version.clone()),
                        )
                        .child(
                            div()
                                .flex_none()
                                .font_family(theme::MONO_FONT)
                                .text_size(px(12.))
                                .text_color(theme::text_muted())
                                .child(item.detail.clone()),
                        )
                }))
                .into_any_element()
        };

        let runs_section = ui::section(
            Some("Training runs"),
            Some("Every finished training run uploads itself here. Pull one to make it this PC's current model."),
            vec![
                ui::icon_button("refresh-runs", IconName::RefreshCw, "List the runs again")
                    .outline()
                    .disabled(!self.can_use_bucket())
                    .on_click(cx.listener(|page, _, _, cx| page.refresh_runs(cx)))
                    .into_any_element(),
                ui::primary_button("pull-run", "Pull to this PC", Some(IconName::Download))
                    .disabled(!self.can_pull_run())
                    .on_click(cx.listener(|page, _, _, cx| page.pull_run(cx)))
                    .into_any_element(),
            ],
        )
        .size_full()
        .min_h_0()
        .child(ui::muted(self.runs_status.clone()).mb(px(8.)))
        .children(self.pull_percent.map(|percent| {
            // Full and moving while the downloaded run imports.
            div().mb(px(12.)).child(Progress::new("pull-progress").loading(percent == 100).value(percent as f32))
        }))
        .child(runs);

        ui::page("model-sync-page", false)
            .child(ui::page_header(DISPLAY_NAME, DESCRIPTION, None, vec![]))
            // Publishing beside the runs, which take the rest of the window.
            .child(ui::split(publishing, runs_section, window))
    }
}

/// This PC's current (artwork, extraction) model versions.
fn current_versions(services: &Services) -> (Option<String>, Option<String>) {
    (
        services.training_run_sync.current_version(TrainingRunSyncService::ARTWORK_KIND),
        services.training_run_sync.current_version(TrainingRunSyncService::EXTRACTION_KIND),
    )
}

/// An error's message without the bucket's keys (DatasetSyncViewModel.Redact, with nothing typed).
fn redact(error: &anyhow::Error, services: &Services) -> String {
    let mut message = replace_ignore_case(&format!("{error:#}"), "SecretAccessKey", "credential");
    message = replace_ignore_case(&message, "AccessKey", "credential");
    if let Some(stored) = services.camera_dataset_sync.load_credentials() {
        for secret in [stored.secret_access_key, stored.access_key_id] {
            if !secret.is_empty() {
                message = message.replace(&secret, "[redacted]");
            }
        }
    }
    message
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Versions are `<kind>-run-<UTC timestamp>`: the date it was trained on.
fn trained_on(version: &str) -> String {
    let date = version.find("-run-").map(|at| &version[at + 5..]).filter(|date| {
        date.len() > 8 && date.as_bytes()[..8].iter().all(u8::is_ascii_digit) && date.as_bytes()[8] == b'T'
    });
    let Some(date) = date else {
        return version.to_string();
    };
    let month = date[4..6].parse::<usize>().ok().and_then(|month| MONTHS.get(month.wrapping_sub(1)));
    match month {
        Some(month) => format!("trained {} {month} {}", date[6..8].trim_start_matches('0'), &date[..4]),
        None => version.to_string(),
    }
}

/// C#'s N1.
fn n1(value: f64) -> String {
    let text = format!("{value:.1}");
    let (whole, fraction) = text.split_once('.').unwrap_or((&text, "0"));
    format!("{}.{fraction}", n0(whole))
}
