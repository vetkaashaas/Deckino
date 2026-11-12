//! Model Benchmarks: every card extractor and artwork recognizer on this PC, scored on the benchmark's photos
//! (camera/benchmark, which no trainer ever reads) through the phone's own pipeline. Compares two models of each kind
//! (by default the latest two) photo by photo, and charts every version so a regression stands out.

use deckino_core::n0;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use deckino_core::camera_annotation_store::DEFAULT_THUMBNAIL_SIZE;
use deckino_core::model_benchmark::{self, BenchmarkRow, BenchmarkScore};
use deckino_core::services::Services;
use futures::StreamExt;
use gpui_kit::component::chart::LineChart;
use gpui_kit::component::progress::Progress;
use gpui_kit::component::{Disableable, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use tokio_util::sync::CancellationToken;

use crate::shell::PageEntry;
use crate::ui::{self, IconName};
use crate::{events, images, rt, theme};

const DISPLAY_NAME: &str = "Model Benchmarks";
const DESCRIPTION: &str = "Score every card extractor and artwork recognizer on the benchmark's photos, which no \
                           model ever trains on, the way the phone runs them.";
/// A corner shift of a quarter percent of the card's size (about a pixel in the phone's frame) or less is a tie.
const NEGLIGIBLE_CORNER_ERROR: f64 = 0.0025;
/// A recognizer margin change this small is a tie: it changes no decision the app makes.
const NEGLIGIBLE_MARGIN: f64 = 0.02;
/// Changed photos shown per side; the rest are counted.
const CHANGES_SHOWN: usize = 12;

type Scores = HashMap<(String, String), Arc<BenchmarkScore>>;

/// The benchmark's labels as they are now, and the scores already made under them. Blocking.
fn load_scores(services: &Services, cancel: &CancellationToken) -> anyhow::Result<(String, Scores)> {
    let fingerprint = model_benchmark::fingerprint(&services.paths, cancel)?;
    let scores = model_benchmark::cached_scores(&services.paths, &fingerprint)
        .into_iter()
        .map(|(pair, score)| (pair, Arc::new(score)))
        .collect();
    Ok((fingerprint, scores))
}

pub fn entry(services: Arc<Services>, _window: &mut Window, cx: &mut App) -> PageEntry {
    let view = cx.new(|_| ModelBenchmarksPage::new(services));
    let opened = view.clone();
    PageEntry {
        key: "modelBenchmarks",
        name: DISPLAY_NAME.into(),
        icon: IconName::ChartLine,
        view: view.into(),
        opened: Some(Rc::new(move |_, cx| opened.update(cx, |page, cx| page.reload(cx)))),
        left: None,
    }
}

/// A or B.
const A: usize = 0;
const B: usize = 1;

struct ModelBenchmarksPage {
    services: Arc<Services>,
    extractors: Vec<String>,
    artworks: Vec<String>,
    /// Runs on this PC without phone files yet, so they can't be scored: [extractor, artwork].
    without_phone_files: [Vec<String>; 2],
    /// The run whose phone files are being made.
    making_phone_files: Option<String>,
    /// The picked versions, as indices into `extractors` / `artworks`: [A, B].
    extractor: [Option<usize>; 2],
    artwork: [Option<usize>; 2],
    /// Arc: every render compares A and B, and must not copy their rows to do it.
    scores: Scores,
    status: String,
    /// (done, total) photos of the pair being scored.
    progress: Option<(usize, usize)>,
    busy: bool,
    cancel: Option<CancellationToken>,
    thumbnails: HashMap<PathBuf, Option<Arc<RenderImage>>>,
    loading: HashSet<PathBuf>,
    /// Bumped by a reload: a thumbnail load started before it may hold the photo as it was.
    thumbnail_generation: u64,
}

impl ModelBenchmarksPage {
    fn new(services: Arc<Services>) -> Self {
        Self {
            services,
            extractors: Vec::new(),
            artworks: Vec::new(),
            without_phone_files: [Vec::new(), Vec::new()],
            making_phone_files: None,
            extractor: [None; 2],
            artwork: [None; 2],
            scores: HashMap::new(),
            status: "Score the models to compare them.".into(),
            progress: None,
            busy: false,
            cancel: None,
            thumbnails: HashMap::new(),
            loading: HashSet::new(),
            thumbnail_generation: 0,
        }
    }

    /// The models on this PC and the scores already made under the benchmark's current labels. No scoring.
    fn reload(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        cx.notify();
        let services = self.services.clone();
        cx.spawn(async move |this, cx| {
            let loaded = rt::spawn(async move {
                // The models are listed even when the benchmark can't be read (a photo deleted mid-walk).
                tokio::task::spawn_blocking(move || {
                    let scores = load_scores(&services, &CancellationToken::new()).map(|(_, scores)| scores);
                    let without = ["extractor", "artwork"]
                        .map(|kind| model_benchmark::versions_without_phone_files(&services.paths, kind));
                    (
                        model_benchmark::model_versions(&services.paths, "extractor"),
                        model_benchmark::model_versions(&services.paths, "artwork"),
                        scores,
                        without,
                    )
                })
                .await
                .map_err(anyhow::Error::from)
            })
            .await;
            let _ = this.update(cx, |page, cx| {
                page.busy = false;
                let (extractors, artworks, scores, without) = match loaded {
                    Ok(loaded) => loaded,
                    Err(error) => (Vec::new(), Vec::new(), Err(error), [Vec::new(), Vec::new()]),
                };
                page.without_phone_files = without;
                page.extractor = keep_picks(&page.extractors, page.extractor, &extractors);
                page.artwork = keep_picks(&page.artworks, page.artwork, &artworks);
                page.extractors = extractors;
                page.artworks = artworks;
                match scores {
                    Ok(scores) => {
                        page.scores = scores;
                        // Photos may have been replaced by a sync: load them again, and retry any that failed.
                        images::release(page.thumbnails.drain().filter_map(|(_, image)| image).collect::<Vec<_>>(), cx);
                        page.loading.clear();
                        page.thumbnail_generation += 1;
                        page.status = page.scoring_status();
                    }
                    Err(error) => {
                        events::report_error(cx, &page.services.log, "modelBenchmarks.reload", &error);
                        page.scores.clear();
                        page.status = format!("Could not read the benchmark: {error:#}");
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn pair(&self, side: usize) -> Option<(String, String)> {
        Some((self.extractors.get(self.extractor[side]?)?.clone(), self.artworks.get(self.artwork[side]?)?.clone()))
    }

    fn score_of(&self, side: usize) -> Option<&Arc<BenchmarkScore>> {
        self.scores.get(&self.pair(side)?)
    }

    /// A and B, then every extractor with B's recognizer and every recognizer with B's extractor (the charts).
    fn pairs_to_score(&self) -> Vec<(String, String)> {
        let mut pairs: Vec<(String, String)> = [A, B].iter().filter_map(|&side| self.pair(side)).collect();
        if let Some((extractor, artwork)) = self.pair(B) {
            pairs.extend(self.extractors.iter().rev().map(|version| (version.clone(), artwork.clone())));
            pairs.extend(self.artworks.iter().rev().map(|version| (extractor.clone(), version.clone())));
        }
        let mut seen = HashSet::new();
        pairs.retain(|pair| !self.scores.contains_key(pair) && seen.insert(pair.clone()));
        pairs
    }

    fn score_models(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        let cancel = CancellationToken::new();
        self.cancel = Some(cancel.clone());
        self.status = "Reading the benchmark's labels…".into();
        cx.notify();
        let services = self.services.clone();
        cx.spawn(async move |this, cx| {
            // The labels may have changed since the page opened: a new fingerprint makes every pair score again.
            let (reader, token) = (services.clone(), cancel.clone());
            let fingerprint =
                rt::spawn(async move { tokio::task::spawn_blocking(move || load_scores(&reader, &token)).await? })
                    .await;
            let pairs = this.update(cx, |page, cx| match fingerprint {
                Ok((fingerprint, scores)) => {
                    page.scores = scores;
                    cx.notify();
                    Some((fingerprint, page.pairs_to_score()))
                }
                Err(_) if cancel.is_cancelled() => {
                    page.status = "Scoring cancelled.".into();
                    None
                }
                Err(error) => {
                    page.status = format!("Could not read the benchmark: {error:#}");
                    None
                }
            });
            let mut failures = Vec::new();
            let mut labels_changed = false;
            // False: the labels could not be read, and the status already says so.
            let started = matches!(pairs, Ok(Some(_)));
            if let Ok(Some((fingerprint, pairs))) = pairs {
                for (index, (extractor, artwork)) in pairs.iter().enumerate() {
                    if cancel.is_cancelled() {
                        break;
                    }
                    let label = format!(
                        "Scoring {} of {}: extractor {} with recognizer {}…",
                        index + 1,
                        pairs.len(),
                        short_label(extractor),
                        short_label(artwork)
                    );
                    let _ = this.update(cx, |page, cx| {
                        page.status = label.clone();
                        page.progress = None;
                        cx.notify();
                    });
                    let (progress, mut reports) = rt::channel::<(usize, usize)>();
                    let (scorer, token, fingerprint) = (services.clone(), cancel.clone(), fingerprint.clone());
                    let (extractor, artwork) = (extractor.clone(), artwork.clone());
                    let run = rt::spawn(async move {
                        let on_progress = move |done: usize, total: usize| {
                            let _ = progress.unbounded_send((done, total));
                        };
                        model_benchmark::score(
                            &scorer.python_runner,
                            &scorer.paths,
                            scorer.database.path(),
                            &fingerprint,
                            &extractor,
                            &artwork,
                            &on_progress,
                            &token,
                        )
                        .await
                    });
                    while let Some(report) = reports.next().await {
                        let _ = this.update(cx, |page, cx| {
                            page.progress = Some(report);
                            cx.notify();
                        });
                    }
                    match run.await {
                        Ok(score) => {
                            let _ = this.update(cx, |page, cx| {
                                page.scores.insert(
                                    (score.extractor_version.clone(), score.artwork_version.clone()),
                                    Arc::new(score),
                                );
                                cx.notify();
                            });
                        }
                        Err(_) if cancel.is_cancelled() => break,
                        Err(error) if error.is::<model_benchmark::LabelsChanged>() => {
                            labels_changed = true;
                            break;
                        }
                        Err(error) => {
                            services.log.error("ui", "Scoring a model pair failed.", Some(&error));
                            failures.push(format!("{error:#}"));
                        }
                    }
                }
            }
            let _ = this.update(cx, |page, cx| {
                if started {
                    page.status = if cancel.is_cancelled() {
                        "Scoring cancelled; the pairs already scored are kept.".into()
                    } else if labels_changed {
                        // The scores shown were made on the labels as they were.
                        page.scores.clear();
                        "The benchmark's photos or labels changed while scoring: choose Score models again.".into()
                    } else if failures.is_empty() {
                        // Pairs left only when A or B was picked again while the run went on.
                        page.scoring_status()
                    } else {
                        format!("{} pairs could not be scored: {}", n0(failures.len()), failures[0])
                    };
                }
                page.busy = false;
                page.progress = None;
                page.cancel = None;
                cx.notify();
            });
            // A missing runtime fails every pair the same way: say it once.
            failures.dedup();
            if failures.len() > 1 {
                let _ = this
                    .update(cx, |_, cx| events::message(cx, "Some models could not be scored", failures.join("\n\n")));
            }
        })
        .detach();
    }

    /// Makes a run's phone files (exported and checked against the app's code, not copied into the app), then reads
    /// the models again so it can be scored. Only a Toolbox started from the repository can.
    fn make_phone_files(&mut self, artwork: bool, version: String, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.making_phone_files = Some(version.clone());
        self.status = format!("Making the phone files of {}…", short_label(&version));
        cx.notify();
        let services = self.services.clone();
        cx.spawn(async move |this, cx| {
            let (lines, mut reports) = rt::channel::<String>();
            let target = version.clone();
            let run = rt::spawn(async move {
                let line = move |line: &str| {
                    let _ = lines.unbounded_send(line.to_string());
                };
                services
                    .model_publish
                    .make_benchmark_phone_files(
                        if artwork { "artwork" } else { "extractor" },
                        &target,
                        &line,
                        &CancellationToken::new(),
                    )
                    .await
            });
            while let Some(line) = reports.next().await {
                let _ = this.update(cx, |page, cx| {
                    page.status = format!("Making the phone files of {}: {line}", short_label(&version));
                    cx.notify();
                });
            }
            let result = run.await;
            let _ = this.update(cx, |page, cx| {
                page.busy = false;
                page.making_phone_files = None;
                match result {
                    Ok(()) => {
                        page.reload(cx);
                        page.status = format!("{}'s phone files are made: choose Score models.", short_label(&version));
                    }
                    Err(error) => {
                        events::report_error(cx, &page.services.log, "modelBenchmarks.makePhoneFiles", &error);
                        page.status = format!("Could not make the phone files of {}: {error:#}", short_label(&version));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn cancel(&mut self) {
        if let Some(cancel) = &self.cancel {
            cancel.cancel();
        }
    }

    fn pick(&mut self, artwork: bool, side: usize, index: usize, cx: &mut Context<Self>) {
        if artwork {
            self.artwork[side] = Some(index);
        } else {
            self.extractor[side] = Some(index);
        }
        if !self.busy {
            self.status = self.scoring_status();
        }
        cx.notify();
    }

    /// What is left to score for the models and A/B picks on screen.
    fn scoring_status(&self) -> String {
        let missing = self.pairs_to_score().len();
        if self.extractors.is_empty() || self.artworks.is_empty() {
            "No phone models on this PC yet: they appear once a model is published from here.".into()
        } else if missing == 0 {
            "Every model is scored on the benchmark's current labels.".into()
        } else {
            format!("{} model pairs to score on the benchmark's current labels.", n0(missing))
        }
    }

    /// A photo's thumbnail from the benchmark's library, loaded off the UI thread.
    fn thumbnail(&mut self, photo: &str, cx: &mut Context<Self>) -> Option<ImageSource> {
        let path = self.services.benchmark_annotation_store.imports_root().join(photo);
        if let Some(thumbnail) = self.thumbnails.get(&path) {
            return thumbnail.clone().map(Into::into);
        }
        if !self.loading.insert(path.clone()) {
            return None;
        }
        let store = self.services.benchmark_annotation_store.clone();
        let (target, generation) = (path.clone(), self.thumbnail_generation);
        cx.spawn(async move |this, cx| {
            let image = rt::spawn(async move {
                tokio::task::spawn_blocking(move || {
                    images::from_jpeg(&store.load_thumbnail(&target, DEFAULT_THUMBNAIL_SIZE)?)
                })
                .await?
            })
            .await;
            let _ = this.update(cx, |page, cx| {
                // A reload ran meanwhile: this may be the photo as it was, and the reload's own load is due.
                if generation != page.thumbnail_generation {
                    images::release(image.ok(), cx);
                    return;
                }
                page.loading.remove(&path);
                page.thumbnails.insert(path, image.ok());
                cx.notify();
            });
        })
        .detach();
        None
    }

    // ---- Rendering ---------------------------------------------------------------------------------------------

    fn render_verdict(&self) -> Option<Div> {
        let (a, b) = (self.score_of(A)?, self.score_of(B)?);
        // No labelled photos (a benchmark not synced or labelled yet): "same results" would read as a real verdict.
        if b.counts.photos == 0 {
            return Some(
                ui::section(Some("No labelled benchmark photos yet"), None, vec![]).child(
                    div()
                        .text_color(theme::text_muted())
                        .child("Sync the benchmark, then draw corners and label its photos to compare models."),
                ),
            );
        }
        let comparison = model_benchmark::compare(a, b);
        let (fixed, broken) = (comparison.fixed.len(), comparison.broken.len());
        let end_to_end = if fixed + broken == 0 {
            verdict_row(
                None,
                "Right card, end to end: same results on every photo",
                "A and B get exactly the same photos right.".into(),
            )
        } else {
            verdict_row(
                (comparison.p_value < 0.05).then_some(fixed > broken),
                if comparison.p_value >= 0.05 {
                    "Right card, end to end: no real difference"
                } else if fixed > broken {
                    "Right card, end to end: B is better"
                } else {
                    "Right card, end to end: B is worse, a regression"
                },
                format!(
                    "{} photos fixed, {} broken (net {:+}). {}",
                    n0(fixed),
                    n0(broken),
                    fixed as i64 - broken as i64,
                    luck(comparison.p_value)
                ),
            )
        };
        // Each model on its own measure, photo by photo; only when A and B use different versions of it.
        let extractor = (a.extractor_version != b.extractor_version)
            .then(|| {
                model_benchmark::compare_paired(a, b, |row| row.extractor.capped_error, false, NEGLIGIBLE_CORNER_ERROR)
            })
            .flatten()
            .map(|change| {
                paired_row(
                    "Card extractor",
                    &change,
                    ("has closer corners", "further off"),
                    format!(
                        "Mean corner error {} → {}.",
                        corner_error(a.summary.corner_error_capped_mean),
                        corner_error(b.summary.corner_error_capped_mean)
                    ),
                )
            });
        let artwork = (a.artwork_version != b.artwork_version)
            .then(|| model_benchmark::compare_paired(a, b, |row| row.artwork.as_ref()?.margin, true, NEGLIGIBLE_MARGIN))
            .flatten()
            .map(|change| {
                paired_row(
                    "Artwork recognizer",
                    &change,
                    ("is surer of the right card", "less sure"),
                    format!(
                        "Mean margin {} → {}.",
                        margin(a.summary.artwork_margin_mean),
                        margin(b.summary.artwork_margin_mean)
                    ),
                )
            });
        Some(
            v_flex()
                .gap(px(12.))
                .py(px(12.))
                .px(px(18.))
                .rounded(px(14.))
                .bg(theme::glass())
                .border_1()
                .border_color(theme::hairline())
                .child(end_to_end)
                .children(extractor)
                .children(artwork),
        )
    }

    fn render_tiles(&self) -> Option<Div> {
        let b = &self.score_of(B)?.summary;
        let a = self.score_of(A).map(|score| &score.summary);
        let tile = |label: &str, value: String, delta: Option<(f64, bool, String)>| {
            let (text, color) = match delta {
                Some((change, _, _)) if change.abs() < 1e-9 => ("= no change".to_string(), theme::text_muted()),
                Some((change, higher_is_better, text)) => {
                    let better = (change > 0.) == higher_is_better;
                    (
                        format!("{} {text}", if change > 0. { "▲" } else { "▼" }),
                        if better { theme::success() } else { theme::danger() },
                    )
                }
                None => (String::new(), theme::text_muted()),
            };
            v_flex()
                .flex_1()
                .flex_basis(px(170.))
                .min_w(px(170.))
                .py(px(12.))
                .px(px(14.))
                .rounded(px(14.))
                .bg(theme::tint())
                .border_1()
                .border_color(theme::color_alpha(0x7911CB40))
                .child(div().text_size(px(12.)).text_color(theme::text_muted()).child(label.to_string()))
                .child(ui::heading(value, 24.).line_height(relative(1.2)))
                .child(div().text_size(px(12.)).text_color(color).child(text))
                .into_any_element()
        };
        let points = |b: Option<f64>, a: Option<Option<f64>>, higher_is_better: bool| {
            let (b, a) = (b?, a.flatten()?);
            Some(((b - a) * 100., higher_is_better, format!("{:+.1} pts", (b - a) * 100.)))
        };
        Some(ui::stats(vec![
            tile(
                "Right card, end to end",
                percent_of(b.end_to_end_right),
                points(b.end_to_end_right, a.map(|a| a.end_to_end_right), true),
            ),
            tile(
                "Wrong card (the worst outcome)",
                percent_of(b.end_to_end_wrong),
                points(b.end_to_end_wrong, a.map(|a| a.end_to_end_wrong), false),
            ),
            tile(
                "Rescued by the title reader",
                n0(b.ocr_rescues),
                a.map(|a| {
                    let change = b.ocr_rescues as f64 - a.ocr_rescues as f64;
                    (change, true, format!("{change:+} photos"))
                }),
            ),
            tile(
                "Extractor found the card",
                percent_of(b.extractor_found),
                points(b.extractor_found, a.map(|a| a.extractor_found), true),
            ),
            tile(
                "Corner error (mean, a miss counts as 10%)",
                corner_error(b.corner_error_capped_mean),
                // No delta when either side measured no corners: 0 would read as a perfect extractor.
                a.and_then(|a| {
                    let change = (b.corner_error_capped_mean? - a.corner_error_capped_mean?) * 100.;
                    Some((change, false, format!("{change:+.2} pts")))
                }),
            ),
            tile(
                "Recognizer top-1 (drawn corners)",
                percent_of(b.artwork_top1),
                points(b.artwork_top1, a.map(|a| a.artwork_top1), true),
            ),
            tile(
                "Recognizer margin (mean, right card vs best wrong)",
                margin(b.artwork_margin_mean),
                a.and_then(|a| {
                    let change = b.artwork_margin_mean? - a.artwork_margin_mean?;
                    Some((change, true, format!("{change:+.3}")))
                }),
            ),
        ]))
    }

    /// One kind's versions: a chart of its own metric across every version, and the list to pick A and B from.
    fn render_versions(&self, artwork: bool, cx: &mut Context<Self>) -> Div {
        let versions = if artwork { &self.artworks } else { &self.extractors };
        let picks = if artwork { self.artwork } else { self.extractor };
        // The metric that depends on this kind alone, from any pair that scored the version. Some(None): scored, but
        // nothing to measure (no labelled card photos yet).
        let metric = |version: &String| -> Option<Option<f64>> {
            self.scores
                .values()
                .find(
                    |score| {
                        if artwork { &score.artwork_version == version } else { &score.extractor_version == version }
                    },
                )
                .map(
                    |score| {
                        if artwork { score.summary.artwork_margin_mean } else { score.summary.corner_error_capped_mean }
                    },
                )
        };
        let format = move |value: f64| if artwork { margin(Some(value)) } else { corner_error(Some(value)) };
        let points: Vec<(String, f64)> =
            versions.iter().filter_map(|version| Some((short_label(version), metric(version).flatten()?))).collect();
        let (title, metric_name) = if artwork {
            (
                "Artwork recognizer",
                "Mean margin of the right card over the best wrong one (drawn corners): higher is surer",
            )
        } else {
            ("Card extractor", "Mean corner error, of the card's size (a miss counts as 10%): lower is better")
        };
        let chart: AnyElement = if points.len() >= 2 {
            div()
                .h(px(170.))
                .child(
                    LineChart::new(points)
                        // Both charts are built on this line: without their own ids they share one hover state, and
                        // hovering one flickers between them.
                        .id(if artwork { "artwork-chart" } else { "extractor-chart" })
                        .x(|point: &(String, f64)| point.0.clone())
                        .y(|point: &(String, f64)| point.1)
                        .stroke(theme::violet())
                        .dot()
                        .linear()
                        // Every date under its point would overlap: the first, middle and last, the rest on hover.
                        .x_tick_count(3)
                        .tooltip_value(move |_, value| format(value).into())
                        .y_tick_format(move |value| format(value)),
                )
                .into_any_element()
        } else {
            ui::dim("The chart fills in as versions are scored.").py(px(12.)).into_any_element()
        };
        let rows = versions.iter().enumerate().rev().map(|(index, version)| {
            let chip = |side: usize, label: &'static str, cx: &mut Context<Self>| {
                let active = picks[side] == Some(index);
                div()
                    .id((if artwork { "art-pick" } else { "ext-pick" }, index * 2 + side))
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(24.))
                    .rounded_full()
                    .text_size(px(11.))
                    .font_weight(FontWeight::BOLD)
                    .cursor_pointer()
                    .map(|el| {
                        if active {
                            el.bg(theme::brand_gradient()).text_color(theme::text())
                        } else {
                            el.border_1()
                                .border_color(theme::hairline())
                                .text_color(theme::text_dim())
                                .hover(|el| el.text_color(theme::text()))
                        }
                    })
                    .on_click(cx.listener(move |page, _, _, cx| page.pick(artwork, side, index, cx)))
                    .child(label)
            };
            h_flex()
                .gap(px(10.))
                .py(px(6.))
                .px(px(8.))
                .rounded(px(8.))
                .when(picks.contains(&Some(index)), |el| el.bg(theme::tint()))
                .child(chip(A, "A", cx))
                .child(chip(B, "B", cx))
                .child(div().flex_1().min_w_0().truncate().text_size(px(13.)).child(short_label(version)))
                .child(
                    div()
                        .flex_none()
                        .font_family(theme::MONO_FONT)
                        .text_size(px(12.))
                        .text_color(theme::text_muted())
                        .child(match metric(version) {
                            None => "not scored".into(),
                            Some(value) => value.map_or("-".into(), format),
                        }),
                )
        });
        // Drawn now: the rows below borrow the context too.
        let rows: Vec<_> = rows.collect();
        let can_make = self.services.model_publish.can_make_phone_files();
        let busy = self.busy;
        let unscorable: Vec<AnyElement> = self.without_phone_files[artwork as usize]
            .iter()
            .enumerate()
            .rev()
            .map(|(index, version)| {
                let making = self.making_phone_files.as_ref() == Some(version);
                let target = version.clone();
                h_flex()
                    .gap(px(10.))
                    .py(px(6.))
                    .px(px(8.))
                    // Where the A and B chips sit: it can't be picked until it has phone files.
                    .child(div().w(px(58.)).flex_none())
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(13.))
                            .text_color(theme::text_muted())
                            .child(short_label(version)),
                    )
                    .child(if can_make {
                        ui::secondary_button(
                            SharedString::from(format!("make-phone-files-{}-{index}", artwork as usize)),
                            if making { "Making…" } else { "Make phone files" },
                            Some(IconName::Smartphone),
                        )
                        .disabled(busy)
                        .on_click(cx.listener(move |page, _, _, cx| page.make_phone_files(artwork, target.clone(), cx)))
                        .into_any_element()
                    } else {
                        div()
                            .flex_none()
                            .font_family(theme::MONO_FONT)
                            .text_size(px(12.))
                            .text_color(theme::text_muted())
                            .child("no phone files")
                            .into_any_element()
                    })
                    .into_any_element()
            })
            .collect();
        let hint = (!unscorable.is_empty()).then(|| {
            ui::dim(if can_make {
                "These runs have no phone files yet, so they can't be scored. Making them takes a minute or two and \
                 doesn't publish anything."
            } else {
                "These runs have no phone files yet, so they can't be scored. Making them needs the repository: start \
                 the Toolbox from it once on this PC, and this one finds its scripts too."
            })
            .mt(px(8.))
        });
        ui::section(Some(title), Some(metric_name), vec![])
            .flex_1()
            .min_w(px(320.))
            .child(chart)
            .child(v_flex().mt(px(10.)).gap(px(2.)).children(rows))
            .children(hint)
            .child(v_flex().gap(px(2.)).children(unscorable))
    }

    fn render_changes(&mut self, cx: &mut Context<Self>) -> Option<Div> {
        let (a, b) = (self.score_of(A)?.clone(), self.score_of(B)?.clone());
        let comparison = model_benchmark::compare(&a, &b);
        if comparison.fixed.is_empty() && comparison.broken.is_empty() {
            return None;
        }
        let mut column = |fixed: bool, changes: &[(&BenchmarkRow, &BenchmarkRow)], cx: &mut Context<Self>| {
            let (title, color) =
                if fixed { ("Fixed by B", theme::success()) } else { ("Broken by B", theme::danger()) };
            let tiles: Vec<AnyElement> = changes
                .iter()
                .take(CHANGES_SHOWN)
                .map(|(after, before)| {
                    let wrong = if fixed { before } else { after };
                    let thumbnail = self.thumbnail(&after.photo, cx);
                    v_flex()
                        .w(px(120.))
                        .gap(px(4.))
                        .child(
                            div()
                                .relative()
                                .h(px(150.))
                                .rounded(px(10.))
                                .overflow_hidden()
                                .bg(theme::color_alpha(0x00000073))
                                .border_2()
                                .border_color(color)
                                .children(thumbnail.map(|image| {
                                    img(image).absolute().inset_0().size_full().object_fit(ObjectFit::Cover)
                                })),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .truncate()
                                .child(after.card_name.clone().unwrap_or_else(|| "No card".into())),
                        )
                        .child(div().text_size(px(11.)).text_color(theme::text_muted()).child(format!(
                            "{}: {}",
                            if fixed { "A" } else { "B" },
                            wrong.answer()
                        )))
                        .into_any_element()
                })
                .collect();
            let more = changes.len().saturating_sub(CHANGES_SHOWN);
            v_flex()
                .flex_1()
                .min_w(px(280.))
                .gap(px(10.))
                .child(
                    div()
                        .font_weight(FontWeight::BOLD)
                        .text_color(color)
                        .child(format!("{title} · {}", n0(changes.len()))),
                )
                .child(if tiles.is_empty() {
                    ui::dim("None.").into_any_element()
                } else {
                    h_flex().flex_wrap().gap(px(10.)).children(tiles).into_any_element()
                })
                .when(more > 0, |el| el.child(ui::dim(format!("+{} more", n0(more)))))
        };
        let fixed = column(true, &comparison.fixed, cx);
        let broken = column(false, &comparison.broken, cx);
        Some(
            ui::section(Some("Photos that changed"), Some("End to end, A against B."), vec![])
                .child(h_flex().items_start().flex_wrap().gap(px(24.)).child(fixed).child(broken)),
        )
    }

    fn render_sessions(&self) -> Option<Div> {
        let b = self.score_of(B)?;
        let a = self.score_of(A);
        // Session: (photos, right with A, right with B).
        let mut sessions: BTreeMap<&str, (usize, usize, usize)> = BTreeMap::new();
        let a_right: HashSet<&str> = a
            .map(|a| a.rows.iter().filter(|row| row.is_right()).map(|row| row.photo.as_str()).collect())
            .unwrap_or_default();
        for row in &b.rows {
            let session = if row.card_present { row.session.as_str() } else { "No card (should find nothing)" };
            let entry = sessions.entry(session).or_default();
            entry.0 += 1;
            entry.1 += a_right.contains(row.photo.as_str()) as usize;
            entry.2 += row.is_right() as usize;
        }
        let bar = |value: f64, color: Hsla| {
            div().h(px(8.)).w(relative(value.clamp(0.01, 1.) as f32)).rounded(px(4.)).bg(color)
        };
        let cell = |text: String| div().w(px(70.)).flex_none().text_size(px(13.)).child(text);
        let rows = sessions.into_iter().map(|(session, (photos, right_a, right_b))| {
            let share = |right: usize| right as f64 / photos.max(1) as f64;
            h_flex()
                .gap(px(12.))
                .py(px(6.))
                .border_b_1()
                .border_color(theme::hairline())
                .child(div().flex_1().min_w_0().truncate().text_size(px(13.)).child(if session.is_empty() {
                    "(benchmark folder)".to_string()
                } else {
                    session.to_string()
                }))
                .child(cell(n0(photos)).text_color(theme::text_muted()))
                .child(
                    v_flex()
                        .w(px(160.))
                        .flex_none()
                        .gap(px(2.))
                        .when(a.is_some(), |el| el.child(bar(share(right_a), theme::lavender())))
                        .child(bar(share(right_b), theme::violet())),
                )
                .child(
                    cell(if a.is_some() { percent(share(right_a)) } else { "-".into() }).text_color(theme::lavender()),
                )
                .child(cell(percent(share(right_b))).text_color(theme::violet()))
        });
        let header = h_flex()
            .gap(px(12.))
            .pb(px(6.))
            .text_size(px(12.))
            .text_color(theme::text_muted())
            .child(div().flex_1().child("Session (the photo's folder)"))
            .child(div().w(px(70.)).child("Photos"))
            .child(div().w(px(160.)))
            .child(div().w(px(70.)).child("A"))
            .child(div().w(px(70.)).child("B"));
        Some(
            ui::section(Some("Right card, end to end, by shooting session"), None, vec![])
                .child(header)
                .children(rows.collect::<Vec<_>>()),
        )
    }
}

impl Render for ModelBenchmarksPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let busy = self.busy;
        let actions = vec![
            ui::icon_button("benchmark-reload", IconName::RefreshCw, "Read the models and the benchmark again")
                .disabled(busy)
                .on_click(cx.listener(|page, _, _, cx| page.reload(cx)))
                .into_any_element(),
            ui::run_button(
                "benchmark-score",
                self.cancel.is_some(),
                IconName::Play,
                "Score models",
                busy || self.extractors.is_empty() || self.artworks.is_empty(),
                false,
                cx.listener(|page, _, _, cx| page.score_models(cx)),
                cx.listener(|page, _, _, _| page.cancel()),
            ),
        ];
        let counts = self.score_of(B).map(|score| &score.counts);
        let info =
            h_flex().flex_wrap().gap(px(16.)).child(ui::muted(self.status.clone()).flex_1().min_w(px(240.))).children(
                counts.map(|counts| {
                    ui::dim(format!(
                        "{} photos scored ({} cards, {} no card){}",
                        n0(counts.photos),
                        n0(counts.cards),
                        n0(counts.no_card),
                        if counts.unlabelled > 0 {
                            format!(" · {} not labelled yet", n0(counts.unlabelled))
                        } else {
                            String::new()
                        }
                    ))
                }),
            );
        let progress = self.progress.map(|(done, total)| {
            Progress::new("benchmark-progress").value((done * 100 / total.max(1)) as f32).into_any_element()
        });
        let empty = (self.extractors.is_empty() || self.artworks.is_empty()).then(|| {
            ui::empty_state(
                IconName::ChartLine,
                "No models to score yet",
                Some("Each published model leaves its phone files on this PC; those are what the benchmark runs."),
            )
        });
        let unscored = (self.score_of(B).is_none() && empty.is_none()).then(|| {
            ui::empty_state(
                IconName::ChartLine,
                "B isn't scored yet",
                Some(
                    "Score models runs the picked pair and every version for the charts. Label the benchmark's \
                     photos first: Photo Library's Benchmark tab, then the Benchmark switch on Corner Annotator and \
                     Identify Card.",
                ),
            )
        });
        let verdict = self.render_verdict();
        let tiles = self.render_tiles();
        let versions = (empty.is_none()).then(|| {
            h_flex()
                .items_start()
                .flex_wrap()
                .gap(px(16.))
                .child(self.render_versions(false, cx))
                .child(self.render_versions(true, cx))
        });
        let changes = self.render_changes(cx);
        let sessions = self.render_sessions();
        ui::page("model-benchmarks", true)
            .child(ui::page_header(DISPLAY_NAME, DESCRIPTION, None, actions))
            .child(info)
            .children(progress)
            .children(empty)
            .children(unscored)
            .children(verdict)
            .children(tiles)
            .children(versions)
            .children(changes)
            .children(sessions)
    }
}

/// The picks kept by version name across a reload; new ones default to B = the latest, A = the one before.
fn keep_picks(old: &[String], picks: [Option<usize>; 2], new: &[String]) -> [Option<usize>; 2] {
    let find =
        |index: Option<usize>| index.and_then(|index| old.get(index)).and_then(|v| new.iter().position(|n| n == v));
    let latest = new.len().checked_sub(1);
    let previous = new.len().checked_sub(2).or(latest);
    [find(picks[A]).or(previous), find(picks[B]).or(latest)]
}

/// "artwork-run-20261107T060719704Z" → "2026-11-07 06:07:19"; other names as they are.
fn short_label(version: &str) -> String {
    let stamp = version.rsplit('-').next().unwrap_or(version);
    let digits: String = stamp.chars().filter(char::is_ascii_digit).collect();
    if digits.len() < 14 {
        return version.to_string();
    }
    // To the second: two runs exported in the same minute must not share a chart point.
    let (date, time) = (&digits[0..8], &digits[8..14]);
    format!("{}-{}-{} {}:{}:{}", &date[0..4], &date[4..6], &date[6..8], &time[0..2], &time[2..4], &time[4..6])
}

/// One line of the verdict. `better`: None for no real difference.
fn verdict_row(better: Option<bool>, title: &str, detail: String) -> Div {
    let (tone, icon) = match better {
        None => (theme::text_muted(), IconName::Equal),
        Some(true) => (theme::success(), IconName::TrendingUp),
        Some(false) => (theme::danger(), IconName::TrendingDown),
    };
    h_flex().gap(px(14.)).child(ui::icon(icon).size(px(22.)).text_color(tone)).child(
        v_flex()
            .gap(px(2.))
            .child(div().font_weight(FontWeight::BOLD).text_color(tone).child(title.to_string()))
            .child(ui::muted(detail)),
    )
}

/// A model compared photo by photo on its own measure: `words` = (better, worse).
fn paired_row(model: &str, change: &model_benchmark::PairedChange, words: (&str, &str), means: String) -> Div {
    let real = change.p_value < 0.05;
    let better = change.better > change.worse;
    let title = if change.better + change.worse == 0 {
        format!("{model}: same on every photo")
    } else if !real {
        format!("{model}: no real difference")
    } else if better {
        format!("{model}: B is better")
    } else {
        format!("{model}: B is worse, a regression")
    };
    verdict_row(
        real.then_some(better),
        &title,
        format!(
            "B {} on {} photos, {} on {}, about the same on the rest. {means} {}",
            words.0,
            n0(change.better),
            words.1,
            n0(change.worse),
            luck(change.p_value)
        ),
    )
}

fn luck(p_value: f64) -> &'static str {
    if p_value >= 0.05 { "A split this small could be luck on this many photos." } else { "Too lopsided to be luck." }
}

/// A corner error, of the card's diagonal.
fn corner_error(value: Option<f64>) -> String {
    value.map_or("-".into(), |value| format!("{:.2}%", value * 100.))
}

/// A recognizer margin, in score units.
fn margin(value: Option<f64>) -> String {
    value.map_or("-".into(), |value| format!("{value:+.3}"))
}

fn percent(value: f64) -> String {
    format!("{:.0}%", value * 100.)
}

/// "-" when there was nothing to measure (no card photos, say).
fn percent_of(value: Option<f64>) -> String {
    value.map_or("-".into(), percent)
}
