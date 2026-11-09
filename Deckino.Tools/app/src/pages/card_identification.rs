//! Identify Card (CardIdentificationViewModel.cs + CardIdentification.tsx): labels which card a camera photo shows,
//! writing <photo>._identity.json. The queue is every photo with a card in known corners (a saved annotation, or the
//! phone's predicted corners until one is saved) whose identity has not been reviewed yet. Without a saved annotation
//! the card is cut out with the latest extractor and refiner, so the page shows the best crop the Toolbox can make
//! whatever the phone captured.

use deckino_core::n0;
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use deckino_core::camera_annotation::{
    CameraPhoto, CardAnnotation, CardIdentity, CardIdentityStatus, IdentityCandidate, NormalizedPoint,
};
use deckino_core::camera_annotation_store::{CameraAnnotationStore, order_by_queue, order_by_queue_by};
use deckino_core::card_catalogue_lookup::{CatalogueCard, CataloguePrinting};
use deckino_core::card_geometry::CardGeometryService;
use deckino_core::card_identity_suggestions::CardIdentitySuggestion;
use deckino_core::card_images;
use deckino_core::services::Services;
use futures::future::{FutureExt, Shared};
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{Disableable, Sizable, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use tokio_util::sync::CancellationToken;

use crate::shell::PageEntry;
use crate::ui::{self, IconName};
use crate::{events, images, rt, theme};

const PHONE_CORNERS: &str = "phone's predicted corners";
/// Card art crops kept in memory; past this the loaded ones are dropped and load again when shown.
// ponytail: whole-cache reset, an LRU if browsing many printings makes it flicker.
const ART_CACHE_LIMIT: usize = 200;

pub fn entry(services: Arc<Services>, window: &mut Window, cx: &mut App) -> PageEntry {
    let page = cx.new(|cx| CardIdentificationPage::new(services.clone(), window, cx));
    let opened = page.clone();
    PageEntry {
        key: "cardIdentification",
        name: "Identify Card".into(),
        icon: IconName::Layers,
        view: page.into(),
        opened: Some(Rc::new(move |window, cx| {
            opened.update(cx, |page, cx| {
                page.focus.focus(window, cx);
                page.execute("refresh", cx);
            })
        })),
        // LeaveAsync: unloads the artwork model while another page is open.
        left: Some(Rc::new(move |_| {
            let services = services.clone();
            let _ = rt::spawn(async move {
                services.card_identity_suggestions.stop().await;
                Ok(())
            });
        })),
    }
}

/// The corners the current photo is shown and guessed with; see `corners_for`.
#[derive(Clone)]
struct Corners {
    points: Vec<NormalizedPoint>,
    source: String,
}

struct QueueItem {
    photo: CameraPhoto,
    identity: Option<CardIdentity>,
    corners: Vec<NormalizedPoint>,
    corner_source: String,
}

impl QueueItem {
    fn file_name(&self) -> String {
        file_name(&self.photo.image_path)
    }
}

struct CardChoice {
    oracle_id: String,
    name: String,
    art_path: Option<PathBuf>,
    score_text: String,
    // The printing the model matched, preselected among the card's printings.
    printing_id: Option<String>,
}

impl CardChoice {
    fn create(card: CatalogueCard, score: Option<f64>) -> Rc<Self> {
        Rc::new(Self {
            oracle_id: card.oracle_id,
            name: card.name,
            printing_id: card.printing_id,
            art_path: card.art_path,
            score_text: score.map(|value| format!("score {value:.2}")).unwrap_or_default(),
        })
    }
}

struct PrintingChoice {
    printing_id: String,
    label: String,
    set_name: Option<String>,
    art_path: Option<PathBuf>,
}

impl PrintingChoice {
    fn create(printing: CataloguePrinting) -> Rc<Self> {
        Rc::new(Self {
            label: format!("{} #{}", printing.set_code.to_uppercase(), printing.collector_number),
            printing_id: printing.printing_id,
            set_name: printing.set_name,
            art_path: printing.art_path,
        })
    }

    fn matches(&self, text: &str) -> bool {
        let text = text.to_lowercase();
        text.is_empty()
            || self.label.to_lowercase().contains(&text)
            || self.set_name.as_ref().is_some_and(|name| name.to_lowercase().contains(&text))
    }
}

/// A card image cut to its art. One not downloaded yet is asked for again a little later each time, up to a minute
/// (the React useImageRetry).
enum Art {
    Loading,
    Ready(Arc<RenderImage>),
    Failed,
    Retry(u32),
}

pub struct CardIdentificationPage {
    services: Arc<Services>,
    focus: FocusHandle,
    search_input: Entity<InputState>,
    filter_input: Entity<InputState>,
    // The text fields are emptied on the next render, which has the window they need.
    reset_search: bool,
    reset_filter: bool,
    skipped: HashSet<String>,
    queue: Vec<Rc<QueueItem>>,
    current: Option<Rc<QueueItem>>,
    current_corners: Shared<Task<Corners>>,
    corner_gate: Arc<futures::lock::Mutex<()>>,
    // The current model's guesses for the photo on screen, from "Suggest cards"; saved with the review only.
    suggestion: Option<CardIdentitySuggestion>,
    load_generation: u64,
    // Bumped by every change of the candidate list (a new photo or "Suggest cards"); load_generation only by photos.
    candidate_generation: u64,
    all_printings: Vec<Rc<PrintingChoice>>,
    printings: Vec<Rc<PrintingChoice>>,
    printing_scroll: UniformListScrollHandle,
    candidates: Vec<Rc<CardChoice>>,
    search_results: Vec<Rc<CardChoice>>,
    card_crop: Option<Arc<RenderImage>>,
    selected: Option<Rc<CardChoice>>,
    selected_printing: Option<Rc<PrintingChoice>>,
    printing_filter: String,
    current_file_name: String,
    capture_details: String,
    status: String,
    search_text: String,
    is_busy: bool,
    newest_first: bool,
    // The commands running now: like the C# async commands, one can't start again until it finishes.
    running: HashSet<&'static str>,
    art: HashMap<PathBuf, Art>,
    _subscriptions: Vec<Subscription>,
}

impl CardIdentificationPage {
    fn new(services: Arc<Services>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search_input = cx.new(|cx| InputState::new(window, cx).placeholder("Card name, then Enter"));
        let filter_input = cx.new(|cx| InputState::new(window, cx).placeholder("Filter printings by set or number"));
        let subscriptions = vec![
            cx.subscribe_in(&search_input, window, |page, state, event: &InputEvent, _, cx| match event {
                InputEvent::Change => page.search_text = state.read(cx).value().to_string(),
                InputEvent::PressEnter { .. } => {
                    page.search_text = state.read(cx).value().to_string();
                    page.execute("search", cx);
                }
                _ => {}
            }),
            cx.subscribe_in(&filter_input, window, |page, state, event: &InputEvent, _, cx| {
                if let InputEvent::Change = event {
                    let value = state.read(cx).value().to_string();
                    page.set_printing_filter(value, cx);
                }
            }),
        ];
        Self {
            services,
            focus: cx.focus_handle(),
            search_input,
            filter_input,
            reset_search: false,
            reset_filter: false,
            skipped: HashSet::new(),
            queue: Vec::new(),
            current: None,
            current_corners: Task::ready(Corners { points: Vec::new(), source: String::new() }).shared(),
            corner_gate: Arc::new(futures::lock::Mutex::new(())),
            suggestion: None,
            load_generation: 0,
            candidate_generation: 0,
            all_printings: Vec::new(),
            printings: Vec::new(),
            printing_scroll: UniformListScrollHandle::new(),
            candidates: Vec::new(),
            search_results: Vec::new(),
            card_crop: None,
            selected: None,
            selected_printing: None,
            printing_filter: String::new(),
            current_file_name: "No photos to identify".into(),
            capture_details: String::new(),
            status: "Refresh the queue to begin.".into(),
            search_text: String::new(),
            is_busy: false,
            newest_first: true,
            running: HashSet::new(),
            art: HashMap::new(),
            _subscriptions: subscriptions,
        }
    }

    fn can_use_photo(&self) -> bool {
        self.current.is_some() && !self.is_busy
    }

    // Every label names the exact printing: training learns artworks, and skips labels without one.
    fn can_confirm(&self) -> bool {
        self.can_use_photo() && self.selected.is_some() && self.selected_printing.is_some()
    }

    fn can(&self, command: &'static str) -> bool {
        !self.running.contains(command)
            && match command {
                "refresh" | "search" => true,
                "confirm" => self.can_confirm(),
                _ => self.can_use_photo(),
            }
    }

    fn is_current(&self, item: &Rc<QueueItem>) -> bool {
        self.current.as_ref().is_some_and(|current| Rc::ptr_eq(current, item))
    }

    fn has_printing_choice(&self) -> bool {
        self.all_printings.len() > 1
    }

    /// Runs a command unless it can't run now; its failure (one the command doesn't report itself) is reported.
    fn execute(&mut self, command: &'static str, cx: &mut Context<Self>) {
        if !self.can(command) {
            return;
        }
        let task = match command {
            "refresh" => self.refresh(cx),
            "suggestCards" => self.suggest_cards(cx),
            "search" => self.search(cx),
            "confirm" => self.confirm(cx),
            "notACard" => self.mark(CardIdentityStatus::NOT_A_CARD, "Marked as not a card.", cx),
            "unreadable" => self.mark(CardIdentityStatus::UNREADABLE, "Marked as unreadable.", cx),
            "skip" => self.skip(cx),
            "moveNext" => self.move_by(1, cx),
            "movePrevious" => self.move_by(-1, cx),
            _ => return,
        };
        self.running.insert(command);
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |page, cx| {
                page.running.remove(command);
                if let Err(error) = result {
                    events::report_error(cx, &page.services.log, &format!("cardIdentification.{command}"), &error);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn refresh(&mut self, cx: &mut Context<Self>) -> Task<Result<()>> {
        if self.is_busy {
            return Task::ready(Ok(()));
        }
        let warm = self.services.clone();
        let _ = rt::spawn(async move {
            // Phone-cornered photos also ask the card finder for corners.
            tokio::join!(warm.card_identity_suggestions.warm_up(), warm.extraction_corner_suggestions.warm_up());
            Ok(())
        });
        self.is_busy = true;
        self.status = "Loading the identification queue…".into();
        cx.notify();
        let newest_first = self.newest_first;
        let store = self.services.camera_annotation_store.clone();
        let scan =
            rt::spawn(async move { tokio::task::spawn_blocking(move || scan_queue(&store, newest_first)).await? });
        cx.spawn(async move |this, cx| {
            let result = match scan.await {
                Ok(queue) => match this.update(cx, |page, cx| {
                    let mut queue = queue;
                    // The order switch may have flipped while the scan ran.
                    if page.newest_first != newest_first {
                        order_by_queue_by(&mut queue, |item: &QueueItem| &item.photo, page.newest_first);
                    }
                    page.queue = queue.into_iter().map(Rc::new).collect();
                    let first = page
                        .queue
                        .iter()
                        .find(|item| !page.skipped.contains(&skip_key(&item.photo.image_path)))
                        .or(page.queue.first())
                        .cloned();
                    page.show(first, cx)
                }) {
                    Ok(show) => show.await,
                    Err(error) => Err(error),
                },
                Err(error) => Err(error),
            };
            this.update(cx, |page, cx| {
                page.status = match (result, &page.current) {
                    (Err(error), _) => {
                        format!("Could not load the identification queue: {error:#}")
                    }
                    (Ok(()), None) => "No photos are waiting for identification.".into(),
                    (Ok(()), Some(current)) if current.identity.is_none() => {
                        "This photo has no card guess yet: use Suggest cards, or search below.".into()
                    }
                    (Ok(()), Some(current)) => format!("Ready: {}.", current.file_name()),
                };
                page.is_busy = false;
                cx.notify();
            })
        })
    }

    // Shows the current artwork model's guesses for this photo in place of the phone's. Nothing is written until the
    // photo is saved, and then the phone's guesses are kept next to these.
    fn suggest_cards(&mut self, cx: &mut Context<Self>) -> Task<Result<()>> {
        let Some(item) = self.current.clone() else {
            return Task::ready(Ok(()));
        };
        self.is_busy = true;
        self.status = "Guessing this card with the current artwork model…".into();
        cx.notify();
        let corners = self.current_corners.clone();
        let services = self.services.clone();
        cx.spawn(async move |this, cx| {
            let corners = corners.await;
            let (path, points) = (item.photo.image_path.clone(), corners.points.clone());
            let result =
                rt::spawn(async move { services.card_identity_suggestions.suggest(&path, &points).await }).await;
            let shown = this.update(cx, |page, cx| match result {
                Err(error) => {
                    page.status = format!("Could not suggest cards: {error:#}");
                    None
                }
                Ok(suggestion) => {
                    if !page.is_current(&item) {
                        return None;
                    }
                    page.suggestion = Some(suggestion.clone());
                    page.candidate_generation += 1;
                    page.set_selected(None, cx);
                    page.candidates.clear();
                    page.capture_details = describe(&item, &corners, Some(&suggestion));
                    let task = page.show_candidates(
                        page.candidate_generation,
                        suggestion.candidates.clone(),
                        Some(suggestion.model_version.clone()),
                        None,
                        cx,
                    );
                    Some((task, suggestion))
                }
            })?;
            if let Some((task, suggestion)) = shown {
                let result = task.await;
                this.update(cx, |page, _| {
                    page.status = match result {
                        Err(error) => format!("Could not suggest cards: {error:#}"),
                        Ok(()) if suggestion.candidates.is_empty() => {
                            format!("{} found no likely card; search below.", suggestion.model_version)
                        }
                        Ok(()) => format!(
                            "Showing {}'s guesses. Saving keeps the phone's guesses too.",
                            suggestion.model_version
                        ),
                    };
                })?;
            }
            this.update(cx, |page, cx| {
                page.is_busy = false;
                cx.notify();
            })
        })
    }

    fn select(&mut self, choice: Rc<CardChoice>, cx: &mut Context<Self>) {
        self.set_selected(Some(choice), cx);
    }

    fn search(&mut self, cx: &mut Context<Self>) -> Task<Result<()>> {
        let text = self.search_text.clone();
        self.search_results.clear();
        cx.notify();
        if text.trim().encode_utf16().count() < 2 {
            return Task::ready(Ok(()));
        }
        let lookup = self.services.card_catalogue_lookup.clone();
        let query = text.clone();
        let search = rt::spawn(async move { lookup.search(&query).await });
        cx.spawn(async move |this, cx| {
            let result = search.await;
            this.update(cx, |page, cx| {
                match result {
                    Err(error) => page.status = format!("Card search failed: {error:#}"),
                    Ok(cards) => {
                        if text != page.search_text {
                            return;
                        }
                        page.search_results = cards.into_iter().map(|card| CardChoice::create(card, None)).collect();
                        if page.search_results.is_empty() {
                            page.status = format!("No card names contain \"{}\".", text.trim());
                        }
                    }
                }
                cx.notify();
            })
        })
    }

    fn confirm(&mut self, cx: &mut Context<Self>) -> Task<Result<()>> {
        // Everything this photo's label needs, taken now: the lookups below can take seconds on first use.
        let (Some(item), Some(card), Some(printing)) =
            (self.current.clone(), self.selected.clone(), self.selected_printing.clone())
        else {
            return Task::ready(Ok(()));
        };
        let suggestion = self.suggestion.clone();
        // Judged against the photo's first answer: the phone's lock, an older toolbox guess, or (for a photo with no
        // earlier guess) the top guess of "Suggest cards". A phone scan it could not identify had no answer, so any
        // pick there corrects it.
        let earlier = item.identity.as_ref().filter(|identity| {
            matches!(identity.source.as_str(), "phone" | "shared") || !identity.candidates.is_empty()
        });
        let (predicted, model_version, candidates) = match earlier {
            Some(identity) => (
                identity.predicted_oracle_id.clone().or_else(|| {
                    (identity.source == "toolbox")
                        .then(|| identity.candidates.first().map(|candidate| candidate.oracle_id.clone()))
                        .flatten()
                }),
                identity.model_version.clone(),
                identity.candidates.clone(),
            ),
            None => (
                suggestion.as_ref().and_then(|s| s.candidates.first().map(|candidate| candidate.oracle_id.clone())),
                suggestion.as_ref().map(|s| s.model_version.clone()),
                suggestion.as_ref().map(|s| s.candidates.clone()).unwrap_or_default(),
            ),
        };
        let right = predicted.as_deref().is_some_and(|predicted| predicted.eq_ignore_ascii_case(&card.oracle_id));
        self.is_busy = true;
        cx.notify();
        let lookup = self.services.card_catalogue_lookup.clone();
        let printing_id = printing.printing_id.clone();
        // The right card with another printing's art is still a miss for an artwork model. When the guessing model's
        // labels are not on this computer its printing is unknown, and only the card is judged.
        let judge = rt::spawn(async move {
            let guessed = candidates
                .iter()
                .find(|candidate| predicted.as_deref().is_some_and(|p| candidate.oracle_id.eq_ignore_ascii_case(p)))
                .map(|candidate| candidate.prototype);
            if right
                && let Some(guessed_printing) = lookup.printing_for_prototype(model_version.as_deref(), guessed).await?
            {
                return lookup.same_artwork(&guessed_printing, &printing_id).await;
            }
            Ok(right)
        });
        cx.spawn(async move |this, cx| match judge.await {
            Err(error) => this.update(cx, |page, cx| {
                page.status = format!("Could not save the card identity: {error:#}");
                page.is_busy = false;
                cx.notify();
            }),
            Ok(right) => {
                let save = this.update(cx, |page, cx| {
                    let status = if right { CardIdentityStatus::CONFIRMED } else { CardIdentityStatus::CORRECTED };
                    let message = format!("Saved {} ({}).", card.name, printing.label);
                    page.save(
                        item,
                        suggestion,
                        status,
                        Some(card.oracle_id.clone()),
                        Some(printing.printing_id.clone()),
                        message,
                        cx,
                    )
                })?;
                save.await
            }
        })
    }

    /// Not a card / Unreadable.
    fn mark(&mut self, status: &'static str, message: &str, cx: &mut Context<Self>) -> Task<Result<()>> {
        let Some(item) = self.current.clone() else {
            return Task::ready(Ok(()));
        };
        self.save(item, self.suggestion.clone(), status, None, None, message.to_string(), cx)
    }

    fn skip(&mut self, cx: &mut Context<Self>) -> Task<Result<()>> {
        let Some(current) = self.current.clone() else {
            return Task::ready(Ok(()));
        };
        self.skipped.insert(skip_key(&current.photo.image_path));
        self.status = "Skipped for this pass.".into();
        // next_after may restart the pass (and say so); the only photo left comes straight back.
        let next = self.next_after(&current).unwrap_or(current);
        self.show(Some(next), cx)
    }

    fn move_by(&mut self, offset: isize, cx: &mut Context<Self>) -> Task<Result<()>> {
        let Some(current) = self.current.clone() else {
            return Task::ready(Ok(()));
        };
        let index = self.queue.iter().position(|item| Rc::ptr_eq(item, &current)).map_or(-1, |index| index as isize);
        let index = index + offset;
        if index < 0 || index as usize >= self.queue.len() {
            return Task::ready(Ok(()));
        }
        let item = self.queue[index as usize].clone();
        self.show(Some(item), cx)
    }

    fn save(
        &mut self,
        item: Rc<QueueItem>,
        suggestion: Option<CardIdentitySuggestion>,
        status: &'static str,
        oracle_id: Option<String>,
        printing_id: Option<String>,
        message: String,
        cx: &mut Context<Self>,
    ) -> Task<Result<()>> {
        self.is_busy = true;
        cx.notify();
        let previous = item.identity.as_ref();
        let identity = CardIdentity {
            source: previous.map_or_else(|| "toolbox".to_string(), |p| p.source.clone()),
            captured_utc: previous.and_then(|p| p.captured_utc),
            user_id: previous.and_then(|p| p.user_id.clone()),
            kind: previous.and_then(|p| p.kind.clone()),
            model_version: previous.and_then(|p| p.model_version.clone()),
            extractor_version: previous.and_then(|p| p.extractor_version.clone()),
            predicted_corners: previous.and_then(|p| p.predicted_corners.clone()),
            candidates: previous.map(|p| p.candidates.clone()).unwrap_or_default(),
            predicted_oracle_id: previous.and_then(|p| p.predicted_oracle_id.clone()),
            toolbox_model_version: suggestion
                .as_ref()
                .map(|s| s.model_version.clone())
                .or_else(|| previous.and_then(|p| p.toolbox_model_version.clone())),
            toolbox_candidates: suggestion
                .as_ref()
                .map(|s| s.candidates.clone())
                .or_else(|| previous.and_then(|p| p.toolbox_candidates.clone())),
            status: status.to_string(),
            oracle_id,
            printing_id,
            reviewed_utc: Some(std::time::SystemTime::now().into()),
            ..CardIdentity::new(item.file_name())
        };
        let store = self.services.camera_annotation_store.clone();
        let coordinator = self.services.coordinator.clone();
        let photo = item.photo.clone();
        let write = rt::spawn(async move {
            let _operation = coordinator.acquire("save card identity")?;
            tokio::task::spawn_blocking(move || -> Result<()> {
                store.save_identity(&photo.image_path, &identity)?;
                if status == CardIdentityStatus::NOT_A_CARD {
                    save_no_card_annotation(&store, &photo)?;
                }
                Ok(())
            })
            .await?
        });
        cx.spawn(async move |this, cx| {
            let result = write.await;
            this.update(cx, |page, cx| {
                match result {
                    Ok(()) => {
                        let next = page.next_after(&item);
                        page.queue.retain(|other| !Rc::ptr_eq(other, &item));
                        let show = page.show(next, cx);
                        // The next photo and its guesses are on screen, which is all saving it needs: the model's
                        // corners and the crop keep coming in behind, and Save is ready meanwhile.
                        cx.spawn(async move |this, cx| {
                            if let Err(error) = show.await {
                                let _ = this.update(cx, |page, cx| {
                                    page.status = format!("Could not save the card identity: {error:#}");
                                    cx.notify();
                                });
                            }
                        })
                        .detach();
                        page.status = format!("{message} {}", item.file_name());
                    }
                    Err(error) => page.status = format!("Could not save the card identity: {error:#}"),
                }
                page.is_busy = false;
                cx.notify();
            })
        })
    }

    fn next_after(&mut self, item: &Rc<QueueItem>) -> Option<Rc<QueueItem>> {
        let others: Vec<Rc<QueueItem>> = match self.queue.iter().position(|other| Rc::ptr_eq(other, item)) {
            Some(index) => self.queue[index + 1..].iter().chain(&self.queue[..index]).cloned().collect(),
            None => self.queue.clone(),
        };
        let next = others.iter().find(|other| !self.skipped.contains(&skip_key(&other.photo.image_path))).cloned();
        if next.is_some() || others.is_empty() {
            return next;
        }
        // Everything left was skipped: start another pass over them.
        self.skipped.clear();
        self.status = "Reached the end of this pass; returning to skipped photos.".into();
        others.into_iter().next()
    }

    fn show(&mut self, item: Option<Rc<QueueItem>>, cx: &mut Context<Self>) -> Task<Result<()>> {
        self.load_generation += 1;
        self.candidate_generation += 1;
        let (generation, candidate_generation) = (self.load_generation, self.candidate_generation);
        self.current = item.clone();
        self.suggestion = None;
        self.set_selected(None, cx);
        self.candidates.clear();
        self.search_results.clear();
        self.search_text.clear();
        self.reset_search = true;
        images::release(self.card_crop.take(), cx);
        self.current_file_name = item.as_ref().map_or_else(|| "No photos to identify".into(), |item| item.file_name());
        self.capture_details.clear();
        cx.notify();
        let Some(item) = item else {
            return Task::ready(Ok(()));
        };

        // The phone's guesses do not depend on the corners, so they show while the model finds the card.
        let identity = item.identity.as_ref();
        let candidates = self.show_candidates(
            candidate_generation,
            identity.map(|identity| identity.candidates.clone()).unwrap_or_default(),
            identity.and_then(|identity| identity.model_version.clone()),
            identity.and_then(|identity| identity.predicted_oracle_id.clone()),
            cx,
        );
        let corners_task = self.corners_for(item.clone(), cx).shared();
        self.current_corners = corners_task.clone();
        cx.spawn(async move |this, cx| {
            // The corners the photo came with show at once; the model's (its worker takes seconds to start) replace
            // them when they come.
            let known = Corners { points: item.corners.clone(), source: item.corner_source.clone() };
            let crop = crop_card(item.photo.image_path.clone(), known.points.clone()).await;
            let shown = this.update(cx, |page, cx| {
                if page.load_generation != generation {
                    return false;
                }
                page.capture_details = describe(&item, &known, None);
                images::release(std::mem::replace(&mut page.card_crop, crop.map(images::from_rgba)), cx);
                cx.notify();
                true
            })?;
            if shown {
                let corners = corners_task.await;
                let changed = corners.source != item.corner_source
                    && this.update(cx, |page, cx| {
                        if page.load_generation != generation {
                            return false;
                        }
                        page.capture_details = describe(&item, &corners, None);
                        cx.notify();
                        true
                    })?;
                if changed {
                    let crop = crop_card(item.photo.image_path.clone(), corners.points).await;
                    this.update(cx, |page, cx| {
                        if page.load_generation == generation {
                            images::release(std::mem::replace(&mut page.card_crop, crop.map(images::from_rgba)), cx);
                            cx.notify();
                        }
                    })?;
                }
            }
            candidates.await
        })
    }

    fn show_candidates(
        &mut self,
        generation: u64,
        candidates: Vec<IdentityCandidate>,
        model_version: Option<String>,
        preferred: Option<String>,
        cx: &mut Context<Self>,
    ) -> Task<Result<()>> {
        let preferred = preferred.or_else(|| candidates.first().map(|candidate| candidate.oracle_id.clone()));
        let lookup = self.services.card_catalogue_lookup.clone();
        cx.spawn(async move |this, cx| {
            for candidate in candidates {
                let (lookup, oracle_id, version) = (lookup.clone(), candidate.oracle_id.clone(), model_version.clone());
                let prototype = candidate.prototype;
                let card = rt::spawn(async move { lookup.find(&oracle_id, version.as_deref(), Some(prototype)).await })
                    .await?;
                let stop = this.update(cx, |page, cx| {
                    if generation != page.candidate_generation {
                        return true;
                    }
                    let card = card.unwrap_or_else(|| CatalogueCard {
                        name: format!("Unknown card {}", candidate.oracle_id.get(..8).unwrap_or(&candidate.oracle_id)),
                        oracle_id: candidate.oracle_id.clone(),
                        art_path: None,
                        printing_id: None,
                    });
                    let choice = CardChoice::create(card, Some(candidate.score));
                    page.candidates.push(choice.clone());
                    if page.selected.is_none()
                        && preferred
                            .as_deref()
                            .is_some_and(|preferred| choice.oracle_id.eq_ignore_ascii_case(preferred))
                    {
                        page.select(choice, cx);
                    }
                    cx.notify();
                    false
                })?;
                if stop {
                    return Ok(());
                }
            }
            this.update(cx, |page, cx| {
                if generation == page.candidate_generation
                    && page.selected.is_none()
                    && let Some(first) = page.candidates.first().cloned()
                {
                    page.select(first, cx);
                }
            })
        })
    }

    /// OnSelectedChanged: lists the selected card's printings and preselects the one the model matched, or the only
    /// one there is.
    fn set_selected(&mut self, value: Option<Rc<CardChoice>>, cx: &mut Context<Self>) {
        let same = match (&self.selected, &value) {
            (Some(a), Some(b)) => Rc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        };
        if same {
            return;
        }
        self.selected = value.clone();
        self.all_printings.clear();
        self.printings.clear();
        self.printing_filter.clear();
        self.reset_filter = true;
        self.selected_printing = None;
        self.printing_scroll.scroll_to_item(0, ScrollStrategy::Top);
        cx.notify();
        let Some(card) = value else { return };
        let lookup = self.services.card_catalogue_lookup.clone();
        let oracle_id = card.oracle_id.clone();
        let printings = rt::spawn(async move { lookup.printings(&oracle_id).await });
        cx.spawn(async move |this, cx| {
            let result = printings.await;
            let _ = this.update(cx, |page, cx| {
                let printings = match result {
                    Ok(printings) => printings,
                    Err(error) => {
                        page.status = format!("Could not list the printings of {}: {error:#}", card.name);
                        cx.notify();
                        return;
                    }
                };
                if !page.selected.as_ref().is_some_and(|selected| Rc::ptr_eq(selected, &card)) {
                    return;
                }
                page.all_printings = printings.into_iter().map(PrintingChoice::create).collect();
                if page.all_printings.is_empty() {
                    page.status = format!(
                        "{} has no paper printing in the catalogue, so a photo cannot show it; pick another card.",
                        card.name
                    );
                }
                page.printings = page.all_printings.clone();
                page.selected_printing = if page.all_printings.len() == 1 {
                    page.all_printings.first().cloned()
                } else {
                    page.all_printings
                        .iter()
                        .find(|printing| {
                            card.printing_id.as_deref().is_some_and(|id| printing.printing_id.eq_ignore_ascii_case(id))
                        })
                        .cloned()
                };
                cx.notify();
            });
        })
        .detach();
    }

    fn set_printing_filter(&mut self, value: String, cx: &mut Context<Self>) {
        let text = value.trim().to_string();
        self.printing_filter = value;
        self.printings = self.all_printings.iter().filter(|printing| printing.matches(&text)).cloned().collect();
        cx.notify();
    }

    // Reorders the loaded queue in memory; nothing on disk changed, and the photo being reviewed stays on screen.
    fn set_newest_first(&mut self, value: bool, cx: &mut Context<Self>) {
        if self.newest_first == value {
            return;
        }
        self.newest_first = value;
        order_by_queue_by(&mut self.queue, |item: &Rc<QueueItem>| &item.photo, value);
        cx.notify();
    }

    // Hand-annotated corners are kept as they are. Otherwise the latest extractor and refiner find the card in the
    // photo; the phone's own corners are the fallback when that model is missing or fails.
    fn corners_for(&mut self, item: Rc<QueueItem>, cx: &mut Context<Self>) -> Task<Corners> {
        let fallback = Corners { points: item.corners.clone(), source: item.corner_source.clone() };
        if item.corner_source != PHONE_CORNERS {
            return Task::ready(fallback);
        }
        let gate = self.corner_gate.clone();
        let services = self.services.clone();
        cx.spawn(async move |this, cx| {
            // One request at a time from this page, and none for a photo already left behind: browsing quickly would
            // otherwise queue a model run per photo passed over in front of the one on screen.
            let _gate = gate.lock().await;
            if !this.read_with(cx, |page, _| page.is_current(&item)).unwrap_or(false) {
                return fallback;
            }
            let path = item.photo.image_path.clone();
            // Never cancelled: a cancelled request restarts the worker, and browsing quickly would do that per photo.
            let result = rt::spawn(async move {
                services.extraction_corner_suggestions.suggest(&path, &CancellationToken::new()).await
            })
            .await;
            let status = match result {
                Ok(suggestion) => match suggestion.corners {
                    Some(points) if points.len() == 4 => {
                        return Corners { points, source: format!("{} corners", suggestion.model_version) };
                    }
                    _ => format!("{} found no card here; showing the phone's corners.", suggestion.model_version),
                },
                Err(error) => format!("Showing the phone's corners; the extraction model could not run: {error:#}"),
            };
            let _ = this.update(cx, |page, cx| {
                if page.is_current(&item) {
                    page.status = status;
                    cx.notify();
                }
            });
            fallback
        })
    }

    /// The art of a card image, loaded off the UI thread; None while it loads or isn't downloaded yet.
    fn art(&mut self, path: Option<&PathBuf>, cx: &mut Context<Self>) -> Option<ImageSource> {
        let path = path?;
        let attempt = match self.art.get(path) {
            Some(Art::Ready(image)) => return Some(image.clone().into()),
            Some(Art::Loading | Art::Failed) => return None,
            Some(Art::Retry(attempt)) => *attempt,
            None => 0,
        };
        if self.art.len() >= ART_CACHE_LIMIT {
            let evicted: Vec<_> = self
                .art
                .extract_if(|_, art| matches!(art, Art::Ready(_)))
                .filter_map(|(_, art)| if let Art::Ready(image) = art { Some(image) } else { None })
                .collect();
            images::release(evicted, cx);
        }
        self.art.insert(path.clone(), Art::Loading);
        let (path, source) = (path.clone(), path.clone());
        let crop = rt::spawn(async move {
            tokio::task::spawn_blocking(move || card_images::crop_card_art(&source).map(images::from_rgb)).await?
        });
        cx.spawn(async move |this, cx| match crop.await {
            Ok(image) => {
                let _ = this.update(cx, |page, cx| {
                    page.art.insert(path, Art::Ready(image));
                    cx.notify();
                });
            }
            Err(_) => {
                let _ = this.update(cx, |page, _| page.art.insert(path.clone(), Art::Failed));
                let delay = Duration::from_secs(5u64.saturating_mul(1 << attempt.min(4)).min(60));
                cx.background_executor().timer(delay).await;
                let _ = this.update(cx, |page, cx| {
                    if let Some(art @ Art::Failed) = page.art.get_mut(&path) {
                        *art = Art::Retry(attempt + 1);
                        cx.notify();
                    }
                });
            }
        })
        .detach();
        None
    }

    fn choice_tiles(&mut self, search: bool, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let choices = if search { self.search_results.clone() } else { self.candidates.clone() };
        choices
            .into_iter()
            .enumerate()
            .map(|(index, choice)| {
                let art = self.art(choice.art_path.as_ref(), cx);
                let selected = self.selected.as_ref().is_some_and(|selected| Rc::ptr_eq(selected, &choice));
                let (name, score) = (choice.name.clone(), choice.score_text.clone());
                h_flex()
                    .id((if search { "search-result" } else { "candidate" }, index))
                    .gap(px(10.))
                    .p(px(6.))
                    .rounded(px(4.))
                    .border_2()
                    .cursor_pointer()
                    .map(|el| {
                        if selected {
                            el.border_color(theme::violet()).bg(theme::tint_strong())
                        } else {
                            el.border_color(transparent_black())
                                .bg(theme::color_alpha(0xFFFFFF08))
                                .hover(|el| el.bg(theme::color_alpha(0xFFFFFF0F)))
                        }
                    })
                    .on_click(cx.listener(move |page, _, _, cx| page.select(choice.clone(), cx)))
                    .child(
                        div()
                            .flex_none()
                            .w(px(84.))
                            .h(px(62.))
                            .relative()
                            .overflow_hidden()
                            .rounded(px(6.))
                            .bg(theme::color_alpha(0x00000073))
                            .children(
                                art.map(|art| img(art).absolute().inset_0().size_full().object_fit(ObjectFit::Cover)),
                            ),
                    )
                    .child(
                        v_flex()
                            .gap(px(2.))
                            .min_w_0()
                            .child(div().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).line_clamp(2).child(name))
                            .when(!score.is_empty(), |el| {
                                el.child(
                                    div()
                                        .font_family(theme::MONO_FONT)
                                        .text_size(px(11.))
                                        .text_color(theme::text_muted())
                                        .child(score),
                                )
                            }),
                    )
                    .into_any_element()
            })
            .collect()
    }

    /// One row of four in the printings grid (a uniform list, so only the printings in view load their art).
    fn printing_row(&mut self, row: usize, cx: &mut Context<Self>) -> AnyElement {
        let cells = (row * 4..row * 4 + 4).map(|index| {
            let Some(printing) = self.printings.get(index).cloned() else {
                return div().flex_1().min_w_0().into_any_element();
            };
            let art = self.art(printing.art_path.as_ref(), cx);
            let selected =
                self.selected_printing.as_ref().is_some_and(|chosen| chosen.printing_id == printing.printing_id);
            let tooltip: SharedString = printing.set_name.clone().unwrap_or_else(|| printing.label.clone()).into();
            let label = printing.label.clone();
            div()
                .id(("printing", index))
                .flex_1()
                .min_w_0()
                .p(px(3.))
                .rounded(px(8.))
                .border_2()
                .cursor_pointer()
                .map(|el| {
                    if selected {
                        el.border_color(theme::violet()).bg(theme::tint_strong())
                    } else {
                        el.border_color(transparent_black()).hover(|el| el.bg(theme::color_alpha(0xFFFFFF0F)))
                    }
                })
                .tooltip(move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx))
                .on_click(cx.listener(move |page, _, _, cx| {
                    page.selected_printing = Some(printing.clone());
                    cx.notify();
                }))
                .child(
                    div()
                        .h(px(70.))
                        .relative()
                        .overflow_hidden()
                        .rounded(px(6.))
                        .bg(theme::color_alpha(0x00000073))
                        .children(
                            art.map(|art| img(art).absolute().inset_0().size_full().object_fit(ObjectFit::Cover)),
                        ),
                )
                .child(
                    div()
                        .font_family(theme::MONO_FONT)
                        .text_size(px(10.))
                        .text_color(theme::text_muted())
                        .text_center()
                        .truncate()
                        .child(label),
                )
                .into_any_element()
        });
        h_flex().items_start().gap(px(6.)).pb(px(6.)).pr(px(8.)).children(cells.collect::<Vec<_>>()).into_any_element()
    }

    fn command(cx: &Context<Self>, name: &'static str) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
        cx.listener(move |page, _, _, cx| page.execute(name, cx))
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // Not while typing in a field.
        let typing = [&self.search_input, &self.filter_input]
            .iter()
            .any(|input| Focusable::focus_handle(input.read(cx), cx).is_focused(window));
        if typing {
            return;
        }
        match event.keystroke.key.as_str() {
            // A held Enter never saves photo after photo unseen, and a button Tab moved to keeps its own Enter.
            "enter" => {
                if event.is_held || !self.focus.is_focused(window) {
                    return;
                }
                self.execute("confirm", cx);
            }
            "right" => self.execute("moveNext", cx),
            "left" => self.execute("movePrevious", cx),
            _ => return,
        }
        cx.stop_propagation();
    }
}

impl Render for CardIdentificationPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if std::mem::take(&mut self.reset_search) {
            self.search_input.update(cx, |input, cx| input.set_value("", window, cx));
        }
        if std::mem::take(&mut self.reset_filter) {
            self.filter_input.update(cx, |input, cx| input.set_value("", window, cx));
        }

        let header = ui::page_header(
            "Identify Card",
            "Confirm or correct which card each camera photo shows.",
            None,
            vec![
                Switch::new("newest-first")
                    .checked(self.newest_first)
                    .label("Newest first")
                    .on_click(cx.listener(|page, checked: &bool, _, cx| page.set_newest_first(*checked, cx)))
                    .mr(px(8.))
                    .into_any_element(),
                Button::new("refresh-queue")
                    .ghost()
                    .rounded(px(999.))
                    .icon(ui::icon(IconName::RefreshCw))
                    .label("Refresh queue")
                    .disabled(!self.can("refresh"))
                    .on_click(Self::command(cx, "refresh"))
                    .into_any_element(),
                ui::secondary_button("suggest-cards", "Suggest cards", Some(IconName::Sparkles))
                    .tooltip("Show the current artwork model's guesses for this photo. Saving keeps the phone's guesses too.")
                    .disabled(!self.can("suggestCards"))
                    .on_click(Self::command(cx, "suggestCards"))
                    .into_any_element(),
            ],
        );

        let info = h_flex()
            .flex_none()
            .flex_wrap()
            .gap_x(px(18.))
            .gap_y(px(10.))
            .py(px(10.))
            .px(px(16.))
            .rounded(px(14.))
            .bg(theme::glass())
            .border_1()
            .border_color(theme::hairline())
            .child(div().font_weight(FontWeight::SEMIBOLD).child(self.current_file_name.clone()))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .font_family(theme::MONO_FONT)
                    .text_size(px(12.))
                    .text_color(theme::text_muted())
                    .truncate()
                    .child(self.capture_details.clone()),
            )
            .child(
                div()
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme::violet())
                    .child(format!("Pending  {}", n0(self.queue.len()))),
            );

        let in_photo = ui::section(Some("In the photo"), None, vec![]).flex_1().min_w_0().min_h_0().child(
            ui::image_well(self.card_crop.clone().map(Into::into), "No photo to identify").flex_1().min_h(px(120.)),
        );

        // The chosen printing's art, or the card's while that printing's image isn't downloaded: one file looked at.
        let saved_art_path = match &self.selected_printing {
            Some(printing) if printing.art_path.as_ref().is_some_and(|path| path.is_file()) => {
                printing.art_path.clone()
            }
            _ => self.selected.as_ref().and_then(|selected| selected.art_path.clone()),
        };
        let saved_art = self.art(saved_art_path.as_ref(), cx);
        let saved_printing_text = match &self.selected_printing {
            Some(printing) => printing.label.clone(),
            None if self.has_printing_choice() => {
                format!("Pick the printing in the photo · {} printings", n0(self.all_printings.len()))
            }
            None => String::new(),
        };
        let printing_rows = self.printings.len().div_ceil(4);
        let saved_as = ui::section(Some("Will be saved as"), None, vec![])
            .flex_1()
            .min_w_0()
            .min_h_0()
            .child(
                ui::image_well(
                    saved_art,
                    if self.selected.is_some() { "Card image not downloaded yet" } else { "Pick a card" },
                )
                .flex_1()
                .min_h(px(120.)),
            )
            .child(
                v_flex()
                    .flex_none()
                    .items_center()
                    .gap(px(2.))
                    .my(px(12.))
                    .child(
                        ui::heading(
                            self.selected
                                .as_ref()
                                .map_or_else(|| "Pick a card".to_string(), |selected| selected.name.clone()),
                            24.,
                        )
                        .text_center(),
                    )
                    .child(
                        div()
                            .font_family(theme::MONO_FONT)
                            .text_size(px(12.))
                            .text_color(theme::text_muted())
                            .child(saved_printing_text),
                    ),
            )
            .when(self.has_printing_choice(), |el| {
                el.child(
                    Input::new(&self.filter_input).small().rounded_full().prefix(ui::icon(IconName::Search).small()),
                )
                .child(
                    div().flex_none().h(px(230.)).mt(px(8.)).child(
                        uniform_list(
                            "printings",
                            printing_rows,
                            cx.processor(|page, range: Range<usize>, _, cx| {
                                range.map(|row| page.printing_row(row, cx)).collect::<Vec<_>>()
                            }),
                        )
                        .track_scroll(&self.printing_scroll)
                        .size_full(),
                    ),
                )
            });

        let candidates = self.choice_tiles(false, cx);
        let search_results = self.choice_tiles(true, cx);
        let choices = ui::section(None, None, vec![]).flex_1().min_h_0().child(
            v_flex()
                .id("choices")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .gap(px(6.))
                .pr(px(8.))
                .child(eyebrow("Model candidates"))
                .children(candidates)
                .child(eyebrow("Not listed? Search by name").mt(px(8.)))
                .child(Input::new(&self.search_input).rounded_full().prefix(ui::icon(IconName::Search).small()))
                .children(search_results),
        );

        let actions = v_flex()
            .flex_none()
            .gap(px(8.))
            .child(
                ui::primary_button("confirm", "Save card & next", Some(IconName::Check))
                    .large()
                    .w_full()
                    .disabled(!self.can("confirm"))
                    .on_click(Self::command(cx, "confirm")),
            )
            .child(
                h_flex()
                    .gap(px(8.))
                    .child(
                        ui::secondary_button("not-a-card", "Not a card", Some(IconName::X))
                            .flex_1()
                            .disabled(!self.can("notACard"))
                            .on_click(Self::command(cx, "notACard")),
                    )
                    .child(
                        ui::secondary_button("unreadable", "Unreadable", Some(IconName::EyeOff))
                            .flex_1()
                            .tooltip("Too blurry or covered to tell which card it is")
                            .disabled(!self.can("unreadable"))
                            .on_click(Self::command(cx, "unreadable")),
                    ),
            )
            .child(
                h_flex()
                    .gap(px(4.))
                    .child(
                        Button::new("previous")
                            .ghost()
                            .rounded(px(999.))
                            .flex_1()
                            .icon(ui::icon(IconName::ArrowLeft))
                            .label("Previous")
                            .disabled(!self.can("movePrevious"))
                            .on_click(Self::command(cx, "movePrevious")),
                    )
                    .child(
                        Button::new("skip")
                            .ghost()
                            .rounded(px(999.))
                            .flex_1()
                            .icon(ui::icon(IconName::SkipForward))
                            .label("Skip")
                            .disabled(!self.can("skip"))
                            .on_click(Self::command(cx, "skip")),
                    )
                    .child(
                        Button::new("next")
                            .ghost()
                            .rounded(px(999.))
                            .flex_1()
                            .label("Next")
                            .child(ui::icon(IconName::ArrowRight))
                            .disabled(!self.can("moveNext"))
                            .on_click(Self::command(cx, "moveNext")),
                    ),
            )
            .child(div().text_size(px(12.)).text_color(theme::text_muted()).line_clamp(3).child(self.status.clone()));

        let side = v_flex().flex_none().w(px(340.)).min_h_0().gap(px(12.)).child(choices).child(actions);

        let hint = h_flex()
            .flex_none()
            .flex_wrap()
            .gap(px(4.))
            .text_size(px(12.))
            .text_color(theme::text_dim())
            .child("Click a card to select it ·")
            .child(kbd("Enter"))
            .child("save & next ·")
            .child(kbd("←"))
            .child(kbd("→"))
            .child("browse queue");

        ui::page("card-identification", false)
            .track_focus(&self.focus)
            // A click anywhere leaves a text field (as in a browser), so the shortcuts work again; a field clicked
            // takes the focus back after this.
            .capture_any_mouse_down(cx.listener(|page, _: &MouseDownEvent, window, cx| page.focus.focus(window, cx)))
            .on_key_down(cx.listener(Self::on_key_down))
            .child(header)
            .child(info)
            .child(h_flex().flex_1().min_h_0().items_stretch().gap(px(16.)).child(in_photo).child(saved_as).child(side))
            .child(hint)
    }
}

fn eyebrow(text: &str) -> Div {
    div().text_size(px(11.)).font_weight(FontWeight::SEMIBOLD).text_color(theme::text_dim()).child(text.to_uppercase())
}

fn kbd(text: &'static str) -> Div {
    div()
        .min_w(px(20.))
        .px(px(5.))
        .rounded(px(6.))
        .border_1()
        .border_color(theme::color_alpha(0xFFFFFF24))
        .bg(theme::color_alpha(0xFFFFFF0D))
        .font_family(theme::MONO_FONT)
        .text_size(px(11.))
        .line_height(px(18.))
        .text_center()
        .text_color(theme::text_muted())
        .child(text)
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The skipped set compares paths ignoring case, as the C# OrdinalIgnoreCase set did.
fn skip_key(path: &Path) -> String {
    path.to_string_lossy().to_uppercase()
}

fn scan_queue(store: &CameraAnnotationStore, newest_first: bool) -> Result<Vec<QueueItem>> {
    let (mut photos, _) = store.scan_photos()?;
    order_by_queue(&mut photos, newest_first);
    Ok(photos
        .into_iter()
        .filter_map(|photo| {
            let identity = store.try_load_identity(&photo.image_path);
            if identity.as_ref().is_some_and(|identity| identity.status != CardIdentityStatus::UNREVIEWED) {
                return None;
            }
            let annotation = if photo.is_annotated { store.try_load(&photo.annotation_path) } else { None };
            if annotation.as_ref().is_some_and(|annotation| !annotation.card_present) || photo.has_invalid_annotation {
                return None;
            }
            let (corners, source) = match &annotation {
                Some(annotation) => (Some(annotation.points().into_iter().flatten().collect()), "annotated corners"),
                None => (identity.as_ref().and_then(|identity| identity.predicted_corners.clone()), PHONE_CORNERS),
            };
            let corners: Vec<NormalizedPoint> = corners.filter(|corners: &Vec<NormalizedPoint>| corners.len() == 4)?;
            Some(QueueItem { photo, identity, corners, corner_source: source.to_string() })
        })
        .collect())
}

// "Not a card" is a corner label too: without it the photo would wait in the Corner Annotator, or keep an annotation
// that tells extraction training a card is there.
fn save_no_card_annotation(store: &CameraAnnotationStore, photo: &CameraPhoto) -> Result<()> {
    let exists = photo.annotation_path.exists();
    let existing = if exists { store.try_load(&photo.annotation_path) } else { None };
    let annotation = CardAnnotation {
        dataset_version: existing.as_ref().map_or_else(|| "corners-v1".to_string(), |e| e.dataset_version.clone()),
        card_present: false,
        image_width: photo.image_width as i32,
        image_height: photo.image_height as i32,
        source_group: existing.as_ref().map_or_else(|| photo.source_group.clone(), |e| e.source_group.clone()),
        // existing?.CaptureCondition ?? photo.CaptureCondition: a saved annotation without one takes the batch's.
        capture_condition: existing
            .as_ref()
            .and_then(|e| e.capture_condition.clone())
            .or_else(|| photo.capture_condition.clone()),
        split: existing.as_ref().and_then(|e| e.split.clone()),
        ..CardAnnotation::new(file_name(&photo.image_path))
    };
    if exists {
        store.update_existing(&photo.image_path, &annotation)
    } else {
        store.save_new(&photo.image_path, &annotation)
    }
}

/// The card cut out of the photo along its corners; None when the photo was deleted by a sync, is unreadable, or the
/// corners are too degenerate to rectify (the candidates still show).
async fn crop_card(path: PathBuf, points: Vec<NormalizedPoint>) -> Option<image::RgbaImage> {
    rt::spawn(async move {
        tokio::task::spawn_blocking(move || {
            let photo = image::ImageReader::open(&path)?.with_guessed_format()?.decode()?.to_rgba8();
            CardGeometryService::create_perspective_preview(&photo, &points)
        })
        .await?
    })
    .await
    .ok()
}

fn describe(item: &QueueItem, corners: &Corners, suggestion: Option<&CardIdentitySuggestion>) -> String {
    let identity = item.identity.as_ref();
    let mut parts = vec![corners.source.clone()];
    if let Some(identity) = identity.filter(|identity| matches!(identity.source.as_str(), "phone" | "shared")) {
        let from = if identity.source == "shared" { "shared photo" } else { "phone" };
        parts.push(if identity.kind.as_deref() == Some("locked") {
            format!("{from} locked on a card")
        } else {
            format!("{from} could not identify it")
        });
        if let Some(captured) = identity.captured_utc {
            parts.push(
                local_short_date_time(&captured.format("%Y %m %d %H %M %S").to_string())
                    .unwrap_or_else(|| captured.format("%Y-%m-%d %H:%M UTC").to_string()),
            );
        }
    }
    if let Some(version) = identity.and_then(|identity| identity.model_version.as_ref()) {
        parts.push(if suggestion.is_none() { version.clone() } else { format!("first guessed by {version}") });
    }
    if let Some(suggestion) = suggestion {
        parts.push(format!("showing {}", suggestion.model_version));
    }
    parts.join("  ·  ")
}

/// C#'s `ToLocalTime().ToString("g")`: Windows' short date and time for this user, DST included. `utc` is
/// "%Y %m %d %H %M %S". Win32, since chrono has no user locale formats.
fn local_short_date_time(utc: &str) -> Option<String> {
    // SYSTEMTIME: year, month, day of week, day, hour, minute, second, milliseconds.
    type SystemTime = [u16; 8];
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SystemTimeToTzSpecificLocalTime(
            time_zone: *const std::ffi::c_void,
            universal_time: *const SystemTime,
            local_time: *mut SystemTime,
        ) -> i32;
        fn GetDateFormatEx(
            locale: *const u16,
            flags: u32,
            date: *const SystemTime,
            format: *const u16,
            out: *mut u16,
            length: i32,
            calendar: *const u16,
        ) -> i32;
        fn GetTimeFormatEx(
            locale: *const u16,
            flags: u32,
            time: *const SystemTime,
            format: *const u16,
            out: *mut u16,
            length: i32,
        ) -> i32;
    }
    const DATE_SHORTDATE: u32 = 1;
    const TIME_NOSECONDS: u32 = 2;
    let parts: Vec<u16> = utc.split(' ').map(|part| part.parse().ok()).collect::<Option<_>>()?;
    let [year, month, day, hour, minute, second] = parts[..] else {
        return None;
    };
    let universal: SystemTime = [year, month, 0, day, hour, minute, second, 0];
    let mut local: SystemTime = [0; 8];
    let (mut date, mut time) = ([0u16; 128], [0u16; 128]);
    let null = std::ptr::null();
    // SAFETY: Win32 calls with valid pointers; the buffers' lengths are passed with them.
    let (date_length, time_length) = unsafe {
        if SystemTimeToTzSpecificLocalTime(std::ptr::null(), &universal, &mut local) == 0 {
            return None;
        }
        (
            GetDateFormatEx(null, DATE_SHORTDATE, &local, null, date.as_mut_ptr(), 128, null),
            GetTimeFormatEx(null, TIME_NOSECONDS, &local, null, time.as_mut_ptr(), 128),
        )
    };
    if date_length <= 0 || time_length <= 0 {
        return None;
    }
    // The lengths count the terminating null.
    Some(format!(
        "{} {}",
        String::from_utf16_lossy(&date[..date_length as usize - 1]),
        String::from_utf16_lossy(&time[..time_length as usize - 1])
    ))
}
