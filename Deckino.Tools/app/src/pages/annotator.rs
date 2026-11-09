//! Corner Annotator (AnnotatorViewModel.cs + Annotator.tsx): label new camera photos with the card's four corners, or
//! review and adjust saved annotations. Model suggestions place the corners first when they can.

#[path = "annotation_canvas.rs"]
mod annotation_canvas;

use deckino_core::n0;
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Arc;

use anyhow::Result;
use deckino_core::camera_annotation::{CameraPhoto, CardAnnotation, NormalizedPoint};
use deckino_core::camera_annotation_store::{CameraAnnotationStore, order_by_queue};
use deckino_core::card_geometry::{CardGeometryService, GeometryValidation};
use deckino_core::error::is_cancelled;
use deckino_core::extraction_corner_suggestions::{ExtractionCornerRefinement, ExtractionCornerSuggestion};
use deckino_core::services::Services;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable, Sizable, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use image::RgbaImage;
use tokio_util::sync::CancellationToken;

use annotation_canvas::{BUTTON_STEP, DRAG_THRESHOLD, Geometry, HIT_RADIUS, Scene, View, WHEEL_STEP};

use crate::shell::PageEntry;
use crate::ui::{self, IconName};
use crate::{events, images, rt, theme};

const DISPLAY_NAME: &str = "Corner Annotator";
const DESCRIPTION: &str = "Label new camera photos or review and adjust saved card annotations.";

// Where the card is (on-surface, in-hand, binder, stack), then the situations the card finder struggles with.
// Training splits CaptureCondition on commas into these tags; on-surface is the baseline the others compare to.
const CONDITION_TAGS: [&str; 10] =
    ["on-surface", "in-hand", "binder", "stack", "sleeve", "toploader", "glare", "close-up", "low-light", "blur"];

pub fn entry(services: Arc<Services>, _window: &mut Window, cx: &mut App) -> PageEntry {
    let page = cx.new(|cx| AnnotatorPage::new(services, cx));
    let opened = page.clone();
    PageEntry {
        key: "annotator",
        name: "Annotator".into(),
        icon: IconName::VectorSquare,
        view: page.into(),
        opened: Some(Rc::new(move |window, cx| {
            opened.update(cx, |page, cx| {
                page.focus.focus(window, cx);
                // The corner worker loads while the queue does, not after the first photo asks for it.
                if page.use_model_suggestions {
                    let services = page.services.clone();
                    let _ = rt::spawn(async move {
                        services.extraction_corner_suggestions.warm_up().await;
                        Ok(())
                    });
                }
                page.refresh(cx);
            });
        })),
        left: None,
    }
}

/// A photo ready to show: decoded for the perspective preview, converted for the canvas, with its saved annotation
/// when reviewing.
struct Prepared {
    photo: CameraPhoto,
    bitmap: Arc<RgbaImage>,
    shown: Arc<RenderImage>,
    saved: Option<CardAnnotation>,
}

/// A marker held by the pointer. `from`: where the pointer went down, in canvas pixels (a marker only clicked, not
/// moved, is just selected). `offset`: the marker from the pointer, kept wherever on the marker it was grabbed.
struct Drag {
    index: usize,
    point: NormalizedPoint,
    from: (f32, f32),
    offset: (f32, f32),
    moved: bool,
}

struct AnnotatorPage {
    services: Arc<Services>,
    focus: FocusHandle,
    skipped: HashSet<String>,
    undo: Vec<Vec<NormalizedPoint>>,
    review_ordinals: HashMap<String, usize>,
    pending: Vec<CameraPhoto>,
    current: Option<CameraPhoto>,
    saved_annotation: Option<CardAnnotation>,
    defer_preview: bool,
    suggestion_cancel: Option<CancellationToken>,
    suggestion_generation: u64,
    prefetch_generation: u64,
    bitmap: Option<Arc<RgbaImage>>,
    photo_image: Option<Arc<RenderImage>>,
    prefetched: Option<Prepared>,

    points: Vec<NormalizedPoint>,
    preview: Option<Arc<RenderImage>>,
    current_file_name: String,
    current_relative_path: String,
    status: String,
    geometry_status: String,
    geometry_is_valid: bool,
    queue_count: usize,
    is_busy: bool,
    is_loading_workspace: bool,
    use_model_suggestions: bool,
    // A suggestion the model accepts is snapped to the card edges with the extractor's full-resolution refiner.
    snap_suggestions: bool,
    is_suggesting: bool,
    suggestion_is_warning: bool,
    suggestion_status: String,
    is_reviewing: bool,
    current_is_no_card: bool,
    capture_condition: String,
    newest_first: bool,

    // The canvas.
    view: View,
    selected: Option<usize>,
    drag: Option<Drag>,
    pan: Option<(f32, f32)>,
    canvas_bounds: Rc<Cell<Bounds<Pixels>>>,
}

impl AnnotatorPage {
    fn new(services: Arc<Services>, cx: &mut Context<Self>) -> Self {
        Self {
            services,
            focus: cx.focus_handle(),
            skipped: HashSet::new(),
            undo: Vec::new(),
            review_ordinals: HashMap::new(),
            pending: Vec::new(),
            current: None,
            saved_annotation: None,
            defer_preview: false,
            suggestion_cancel: None,
            suggestion_generation: 0,
            prefetch_generation: 0,
            bitmap: None,
            photo_image: None,
            prefetched: None,
            points: Vec::new(),
            preview: None,
            current_file_name: "No unannotated photos".into(),
            current_relative_path: String::new(),
            status: "Import folders or refresh the queue to begin.".into(),
            geometry_status: "Add the TopLeft corner.".into(),
            geometry_is_valid: false,
            queue_count: 0,
            is_busy: false,
            is_loading_workspace: false,
            use_model_suggestions: true,
            snap_suggestions: true,
            is_suggesting: false,
            suggestion_is_warning: false,
            suggestion_status: "Model suggestions are on and will run when a photo is available.".into(),
            is_reviewing: false,
            current_is_no_card: false,
            capture_condition: String::new(),
            newest_first: true,
            view: View::FIT,
            selected: None,
            drag: None,
            pan: None,
            canvas_bounds: Rc::new(Cell::new(Bounds::default())),
        }
    }

    fn has_photo(&self) -> bool {
        self.current.is_some()
    }

    fn queue_summary(&self) -> String {
        if self.is_reviewing {
            format!("Review  {}", n0(self.queue_count))
        } else {
            format!("Pending  {}", n0(self.queue_count))
        }
    }

    fn next_corner_name(&self) -> &'static str {
        CameraAnnotationStore::CORNER_ORDER.get(self.points.len()).copied().unwrap_or("All corners placed")
    }

    fn review_position(&self) -> String {
        match self
            .current
            .as_ref()
            .filter(|_| self.is_reviewing)
            .and_then(|photo| self.review_ordinals.get(&key(&photo.image_path)))
        {
            Some(ordinal) => format!("Reviewing {} / {}", n0(*ordinal), n0(self.review_ordinals.len())),
            None => String::new(),
        }
    }

    fn empty_queue_status(&self) -> String {
        if self.is_reviewing {
            "No saved annotations are available to review.".into()
        } else {
            "No unannotated photos are waiting.".into()
        }
    }

    // CanExecute.
    fn can_save(&self) -> bool {
        self.has_photo() && self.geometry_is_valid && !self.is_busy
    }
    fn can_use_photo(&self) -> bool {
        self.has_photo() && !self.is_busy
    }
    fn can_clear(&self) -> bool {
        !self.points.is_empty() && !self.is_busy
    }
    fn can_undo(&self) -> bool {
        !self.undo.is_empty() && !self.is_busy
    }
    fn can_rotate(&self) -> bool {
        self.points.len() == 4 && !self.is_busy
    }
    fn can_move(&self, offset: isize) -> bool {
        self.select_adjacent_photo(offset).is_some() && !self.is_busy
    }
    fn can_snap_to_edges(&self) -> bool {
        self.has_photo() && self.points.len() == 4 && self.geometry_is_valid && !self.is_suggesting && !self.is_busy
    }

    // ---- Queue -------------------------------------------------------------------------------------------------

    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.load_queue(false, cx);
    }

    fn review_annotated(&mut self, cx: &mut Context<Self>) {
        self.load_queue(true, cx);
    }

    /// RefreshAsync (`review` false) and ReviewAnnotatedAsync (true).
    fn load_queue(&mut self, review: bool, cx: &mut Context<Self>) {
        if self.is_busy {
            return;
        }
        self.is_busy = true;
        self.is_loading_workspace = true;
        self.is_reviewing = review;
        if review {
            self.skipped.clear();
            self.status = "Loading saved annotations for review…".into();
        } else {
            self.status = "Loading annotation queue…".into();
        }
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = Self::reload_queue(&this, cx).await;
            let _ = this.update(cx, |page, cx| {
                page.status = match result {
                    Ok(()) => match &page.current {
                        None => page.empty_queue_status(),
                        Some(_) if review => {
                            format!("Reviewing saved annotation for {}.", page.current_file_name)
                        }
                        Some(_) => format!("Ready to annotate {}.", page.current_file_name),
                    },
                    Err(error) if review => format!("Could not load saved annotations: {error:#}"),
                    Err(error) => format!("Could not refresh the annotation queue: {error:#}"),
                };
                page.is_loading_workspace = false;
                page.is_busy = false;
                cx.notify();
            });
        })
        .detach();
    }

    async fn reload_queue(this: &WeakEntity<Self>, cx: &mut AsyncApp) -> Result<()> {
        let (services, reviewing, newest_first, skipped) = this.read_with(cx, |page, _| {
            (page.services.clone(), page.is_reviewing, page.newest_first, page.skipped.clone())
        })?;
        let store = services.camera_annotation_store.clone();
        let mut photos = rt::spawn(async move {
            tokio::task::spawn_blocking(move || -> Result<Vec<CameraPhoto>> {
                let (all, _) = store.scan_photos()?;
                let mut photos: Vec<CameraPhoto> = all
                    .into_iter()
                    .filter(|photo| {
                        if reviewing {
                            photo.is_annotated
                        } else {
                            !photo.is_annotated && !photo.has_invalid_annotation
                        }
                    })
                    .collect();
                order_by_queue(&mut photos, newest_first);
                Ok(photos)
            })
            .await?
        })
        .await?;
        let next = this.update(cx, |page, cx| {
            // The order switch may have flipped while the scan ran.
            if page.newest_first != newest_first {
                order_by_queue(&mut photos, page.newest_first);
            }
            page.pending = photos;
            page.number_review_queue();
            page.queue_count = page.pending.len();
            let mut next = page.pending.iter().find(|photo| !skipped.contains(&key(&photo.image_path))).cloned();
            if next.is_none() && !page.pending.is_empty() && !skipped.is_empty() {
                page.skipped.clear();
                next = Some(page.pending[0].clone());
                page.status = "Reached the end of this pass; returning to skipped photos.".into();
            }
            cx.notify();
            next
        })?;
        let prepared = match next {
            Some(photo) => Some(prepare(&services, photo, reviewing).await?),
            None => None,
        };
        this.update(cx, |page, cx| {
            page.set_current_photo(prepared, cx);
            page.begin_prefetch(cx);
        })
    }

    /// AdvanceToNextPhotoAsync: the prefetched photo when it is the next one.
    async fn advance(this: &WeakEntity<Self>, preferred_index: Option<Option<usize>>, cx: &mut AsyncApp) -> Result<()> {
        enum Next {
            Ready(Option<Prepared>),
            Load(CameraPhoto),
        }
        let (services, reviewing, next) = this.update(cx, |page, cx| {
            page.queue_count = page.pending.len();
            let mut next = match preferred_index {
                Some(removed) => page.select_review_continuation(removed),
                None => page.select_next_photo(),
            };
            if next.is_none() && !page.pending.is_empty() && !page.skipped.is_empty() {
                page.skipped.clear();
                next = Some(page.pending[0].clone());
                page.status = "Reached the end of this pass; returning to skipped photos.".into();
            }
            cx.notify();
            let next = match next {
                None => Next::Ready(None),
                Some(photo) => match page.take_prefetched(&photo) {
                    Some(prepared) => Next::Ready(Some(prepared)),
                    None => {
                        page.cancel_prefetch();
                        Next::Load(photo)
                    }
                },
            };
            (page.services.clone(), page.is_reviewing, next)
        })?;
        let prepared = match next {
            Next::Ready(prepared) => prepared,
            Next::Load(photo) => Some(prepare(&services, photo, reviewing).await?),
        };
        this.update(cx, |page, cx| {
            page.set_current_photo(prepared, cx);
            page.begin_prefetch(cx);
        })
    }

    fn take_prefetched(&mut self, photo: &CameraPhoto) -> Option<Prepared> {
        if self.prefetched.as_ref().is_some_and(|prepared| same(&prepared.photo, photo)) {
            self.prefetched.take()
        } else {
            None
        }
    }

    fn select_next_photo(&self) -> Option<CameraPhoto> {
        self.pending
            .iter()
            .find(|photo| {
                !self.current.as_ref().is_some_and(|current| same(current, photo))
                    && !self.skipped.contains(&key(&photo.image_path))
            })
            .cloned()
    }

    fn remove_current_from_queue(&mut self) -> Option<usize> {
        let current = self.current.clone()?;
        let removed = self.pending.iter().position(|photo| same(photo, &current));
        self.pending.retain(|photo| !same(photo, &current));
        self.queue_count = self.pending.len();
        removed
    }

    fn select_review_continuation(&self, removed_index: Option<usize>) -> Option<CameraPhoto> {
        let removed = removed_index?;
        if self.pending.is_empty() {
            return None;
        }
        Some(self.pending.get(removed).unwrap_or(&self.pending[0]).clone())
    }

    fn select_adjacent_photo(&self, offset: isize) -> Option<&CameraPhoto> {
        let current = self.current.as_ref()?;
        let index = self.pending.iter().position(|photo| same(photo, current))?;
        let target = index.checked_add_signed(offset)?;
        self.pending.get(target)
    }

    fn begin_prefetch(&mut self, cx: &mut Context<Self>) {
        self.cancel_prefetch();
        let Some(next) = self.select_adjacent_photo(1).cloned().or_else(|| self.select_next_photo()) else {
            return;
        };
        let generation = self.prefetch_generation;
        let work = prepare(&self.services, next, self.is_reviewing);
        cx.spawn(async move |this, cx| {
            // Prefetch is an optimization. The foreground transition retries and reports any real image-loading
            // failure through its normal command path.
            if let Ok(prepared) = work.await {
                let _ = this.update(cx, |page, _| {
                    if generation == page.prefetch_generation {
                        page.prefetched = Some(prepared);
                    }
                });
            }
        })
        .detach();
    }

    fn cancel_prefetch(&mut self) {
        self.prefetch_generation += 1;
        self.prefetched = None;
    }

    fn number_review_queue(&mut self) {
        self.review_ordinals.clear();
        if !self.is_reviewing {
            return;
        }
        for (index, photo) in self.pending.iter().enumerate() {
            self.review_ordinals.insert(key(&photo.image_path), index + 1);
        }
    }

    // Reorders the loaded queue in memory: the current photo and any placed corners stay as they are.
    fn set_newest_first(&mut self, value: bool, cx: &mut Context<Self>) {
        if self.newest_first == value {
            return;
        }
        self.newest_first = value;
        order_by_queue(&mut self.pending, value);
        self.number_review_queue();
        self.cancel_prefetch();
        self.begin_prefetch(cx);
        cx.notify();
    }

    fn set_current_photo(&mut self, prepared: Option<Prepared>, cx: &mut Context<Self>) {
        self.cancel_pending_suggestion();
        images::release(self.photo_image.take(), cx);
        self.bitmap = None;
        let (photo, saved, bitmap, shown) = match prepared {
            Some(prepared) => (Some(prepared.photo), prepared.saved, Some(prepared.bitmap), Some(prepared.shown)),
            None => (None, None, None, None),
        };
        self.current = photo.clone();
        self.saved_annotation = saved;
        self.capture_condition = self
            .saved_annotation
            .as_ref()
            .and_then(|saved| saved.capture_condition.clone())
            .or_else(|| photo.as_ref().and_then(|photo| photo.capture_condition.clone()))
            .unwrap_or_default();
        self.current_is_no_card = false;
        self.points.clear();
        self.update_geometry(cx);
        self.undo.clear();
        self.set_preview(None, cx);
        // A new photo starts fitted, with nothing selected.
        self.view = View::FIT;
        self.selected = None;
        self.drag = None;
        self.pan = None;
        match &photo {
            None => {
                self.current_file_name =
                    if self.is_reviewing { "No saved annotations".into() } else { "No unannotated photos".into() };
                self.current_relative_path = String::new();
                self.geometry_status = if self.is_reviewing {
                    "There are no saved annotations to review.".into()
                } else {
                    "Import more photos or remove an annotation in Photo Library.".into()
                };
            }
            Some(photo) => {
                self.bitmap = bitmap;
                self.photo_image = shown;
                self.current_file_name = file_name(&photo.image_path);
                self.current_relative_path = photo.relative_path.clone();
                match &self.saved_annotation {
                    Some(saved) if !saved.card_present => {
                        self.current_is_no_card = true;
                        self.geometry_status = "No Card selected".into();
                    }
                    Some(saved) => {
                        let points = saved.points().into_iter().flatten().collect();
                        self.replace_points(points, cx);
                    }
                    None => self.geometry_status = "Add the TopLeft corner.".into(),
                }
            }
        }
        if photo.is_some() && self.use_model_suggestions && !self.is_reviewing {
            self.suggest_current_photo(cx);
        }
        cx.notify();
    }

    // ---- Commands ----------------------------------------------------------------------------------------------

    /// SaveNextAsync (`card_present`) and MarkNoCardNextAsync.
    fn save(&mut self, card_present: bool, cx: &mut Context<Self>) {
        let Some(photo) = self.current.clone() else {
            return;
        };
        if self.is_busy || (card_present && !self.geometry_is_valid) {
            return;
        }
        self.is_busy = true;
        cx.notify();
        let annotation = self.build_annotation(&photo, card_present);
        let reviewing = self.is_reviewing;
        let store = self.services.camera_annotation_store.clone();
        let coordinator = self.services.coordinator.clone();
        let operation = if card_present { "save camera annotation" } else { "save no-card annotation" };
        let path = photo.image_path.clone();
        let work = rt::spawn(async move {
            let _permit = coordinator.acquire(operation)?;
            tokio::task::spawn_blocking(move || {
                if reviewing { store.update_existing(&path, &annotation) } else { store.save_new(&path, &annotation) }
            })
            .await?
        });
        cx.spawn(async move |this, cx| {
            let result = async {
                work.await?;
                let removed = this.update(cx, |page, cx| {
                    page.status = match (card_present, reviewing) {
                        (false, _) => format!("Marked {} as no card.", page.current_file_name),
                        (true, true) => format!("Updated {}.", page.current_file_name),
                        (true, false) => format!("Saved {}.", page.current_file_name),
                    };
                    page.skipped.remove(&key(&photo.image_path));
                    let removed = page.remove_current_from_queue();
                    cx.notify();
                    removed
                })?;
                Self::advance(&this, reviewing.then_some(removed), cx).await
            }
            .await;
            let _ = this.update(cx, |page, cx| {
                if let Err(error) = result {
                    page.status = if card_present {
                        format!("Could not save the annotation: {error:#}")
                    } else {
                        format!("Could not save the no-card annotation: {error:#}")
                    };
                }
                page.is_busy = false;
                cx.notify();
            });
        })
        .detach();
    }

    fn skip(&mut self, cx: &mut Context<Self>) {
        let Some(photo) = self.current.clone() else {
            return;
        };
        if self.is_busy {
            return;
        }
        self.is_busy = true;
        let mut next_review_index = None;
        if self.is_reviewing {
            self.status = format!("Reviewed {} with no changes.", self.current_file_name);
            next_review_index = Some(self.remove_current_from_queue());
        } else {
            self.skipped.insert(key(&photo.image_path));
            self.status = format!("Skipped {} for this pass.", self.current_file_name);
        }
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = Self::advance(&this, next_review_index, cx).await;
            let _ = this.update(cx, |page, cx| {
                if let Err(error) = &result {
                    events::report_error(cx, &page.services.log, "annotator.skip", error);
                }
                page.is_busy = false;
                cx.notify();
            });
        })
        .detach();
    }

    /// MoveNextAsync (1) and MovePreviousAsync (-1).
    fn move_through_queue(&mut self, offset: isize, cx: &mut Context<Self>) {
        if self.is_busy {
            return;
        }
        let Some(target) = self.select_adjacent_photo(offset).cloned() else {
            return;
        };
        self.is_busy = true;
        cx.notify();
        let load: Pin<Box<dyn Future<Output = Result<Prepared>>>> = match self.take_prefetched(&target) {
            Some(prepared) => Box::pin(async move { Ok(prepared) }),
            None => {
                self.cancel_prefetch();
                Box::pin(prepare(&self.services, target, self.is_reviewing))
            }
        };
        cx.spawn(async move |this, cx| {
            let prepared = load.await;
            let _ = this.update(cx, |page, cx| {
                match prepared {
                    Ok(prepared) => {
                        page.set_current_photo(Some(prepared), cx);
                        page.status = if page.is_reviewing {
                            format!("Reviewing saved annotation for {}.", page.current_file_name)
                        } else {
                            format!("Ready to annotate {}.", page.current_file_name)
                        };
                        page.begin_prefetch(cx);
                    }
                    Err(error) => page.status = format!("Could not move through the annotation queue: {error:#}"),
                }
                page.is_busy = false;
                cx.notify();
            });
        })
        .detach();
    }

    fn import_folders(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let Some(folder) = events::pick_folder("Select a camera photo folder").await else {
                return;
            };
            // The picker doesn't block the window: another command may have started while it was open.
            let Ok(Some((services, capture_condition))) = this.update(cx, |page, cx| {
                if page.is_busy {
                    return None;
                }
                page.is_busy = true;
                page.status = "Importing and normalizing camera photos…".into();
                cx.notify();
                let condition = page.capture_condition.trim();
                Some((page.services.clone(), (!condition.is_empty()).then(|| condition.to_string())))
            }) else {
                return;
            };
            let result = async {
                let importer = services.camera_image_import.clone();
                let coordinator = services.coordinator.clone();
                let imported = rt::spawn(async move {
                    let _permit = coordinator.acquire("import camera photos")?;
                    tokio::task::spawn_blocking(move || importer.import(&[folder], capture_condition.as_deref()))
                        .await?
                })
                .await?;
                this.update(cx, |page, cx| {
                    page.skipped.clear();
                    page.is_reviewing = false;
                    page.is_loading_workspace = true;
                    page.status = format!(
                        "Imported {}; skipped {}; failed {}.",
                        n0(imported.imported),
                        n0(imported.skipped),
                        n0(imported.failed)
                    );
                    cx.notify();
                })?;
                if !imported.errors.is_empty() {
                    let text = imported.errors.iter().take(20).cloned().collect::<Vec<_>>().join("\n");
                    let answer =
                        this.update(cx, |_, cx| events::message(cx, "Camera import completed with errors", text))?;
                    let _ = answer.await;
                }
                Self::reload_queue(&this, cx).await
            }
            .await;
            let _ = this.update(cx, |page, cx| {
                if let Err(error) = result {
                    page.status = format!("Camera import failed: {error:#}");
                }
                page.is_loading_workspace = false;
                page.is_busy = false;
                cx.notify();
            });
        })
        .detach();
    }

    // ---- Points ------------------------------------------------------------------------------------------------

    fn add_point(&mut self, point: NormalizedPoint, cx: &mut Context<Self>) {
        if !self.has_photo() || self.points.len() >= 4 {
            return;
        }
        self.cancel_suggestion_for_manual_edit();
        self.push_undo();
        self.current_is_no_card = false;
        self.points.push(clamp(point));
        self.update_geometry(cx);
    }

    /// A marker dragged to a new place: one undo step, one preview.
    fn place_corner(&mut self, index: usize, point: NormalizedPoint, cx: &mut Context<Self>) {
        if index >= self.points.len() {
            return;
        }
        self.cancel_suggestion_for_manual_edit();
        self.push_undo();
        self.points[index] = clamp(point);
        self.update_geometry(cx);
    }

    fn clear_points(&mut self, cx: &mut Context<Self>) {
        self.cancel_suggestion_for_manual_edit();
        self.push_undo();
        self.points.clear();
        self.update_geometry(cx);
    }

    fn undo(&mut self, cx: &mut Context<Self>) {
        self.cancel_suggestion_for_manual_edit();
        if let Some(snapshot) = self.undo.pop() {
            self.replace_points(snapshot, cx);
        }
    }

    fn rotate_points_clockwise(&mut self, cx: &mut Context<Self>) {
        if self.points.len() != 4 {
            return;
        }
        self.cancel_suggestion_for_manual_edit();
        self.push_undo();
        let p = &self.points;
        let rotated = vec![p[3], p[0], p[1], p[2]];
        self.replace_points(rotated, cx);
    }

    fn push_undo(&mut self) {
        self.undo.push(self.points.clone());
    }

    fn replace_points(&mut self, points: Vec<NormalizedPoint>, cx: &mut Context<Self>) {
        self.points = points;
        self.update_geometry(cx);
    }

    fn build_annotation(&self, photo: &CameraPhoto, card_present: bool) -> CardAnnotation {
        let saved = self.saved_annotation.as_ref();
        let corner = |index: usize| {
            if card_present { self.points.get(index).copied() } else { None }
        };
        let condition = self.capture_condition.trim();
        CardAnnotation {
            schema_version: saved.map_or(1, |saved| saved.schema_version),
            dataset_version: saved.map_or_else(|| "corners-v1".into(), |saved| saved.dataset_version.clone()),
            image_file: file_name(&photo.image_path),
            card_present,
            corner_order: saved.map_or_else(
                || CameraAnnotationStore::CORNER_ORDER.iter().map(|corner| corner.to_string()).collect(),
                |saved| saved.corner_order.clone(),
            ),
            top_left: corner(0),
            top_right: corner(1),
            bottom_right: corner(2),
            bottom_left: corner(3),
            image_width: photo.image_width as i32,
            image_height: photo.image_height as i32,
            source_group: photo.source_group.clone(),
            capture_condition: (!condition.is_empty()).then(|| condition.to_string()),
            split: saved.and_then(|saved| saved.split.clone()),
            corner_convention: card_present.then(|| CameraAnnotationStore::CORNER_CONVENTION.to_string()),
        }
    }

    fn update_geometry(&mut self, cx: &mut Context<Self>) {
        let validation = CardGeometryService::validate(&self.points);
        self.geometry_is_valid = validation.is_valid;
        self.geometry_status = if self.current_is_no_card && self.points.is_empty() {
            "No Card selected".into()
        } else if self.points.len() < 4 {
            format!("Next: {}", self.next_corner_name())
        } else {
            validation.message
        };
        if !self.defer_preview
            && validation.is_valid
            && let Some(bitmap) = self.bitmap.clone()
        {
            match CardGeometryService::create_perspective_preview(&bitmap, &self.points) {
                Ok(preview) => self.set_preview(Some(images::from_rgba(preview)), cx),
                Err(error) => {
                    self.geometry_is_valid = false;
                    self.geometry_status = format!("Perspective preview failed: {error:#}");
                    self.set_preview(None, cx);
                }
            }
        } else if !self.defer_preview {
            self.set_preview(None, cx);
        }
        cx.notify();
    }

    fn set_preview(&mut self, preview: Option<Arc<RenderImage>>, cx: &mut Context<Self>) {
        let old = std::mem::replace(&mut self.preview, preview);
        images::release(old, cx);
    }

    // ---- Model suggestions -------------------------------------------------------------------------------------

    fn suggest_current_photo(&mut self, cx: &mut Context<Self>) {
        let Some(photo) = self.current.clone() else {
            return;
        };
        if !self.use_model_suggestions || self.is_reviewing || !self.points.is_empty() {
            return;
        }
        self.cancel_pending_suggestion();
        let generation = self.suggestion_generation;
        let cancel = CancellationToken::new();
        self.suggestion_cancel = Some(cancel.clone());
        self.is_suggesting = true;
        self.suggestion_is_warning = false;
        self.suggestion_status = "Finding card corners with the current extraction model…".into();
        cx.notify();
        let services = self.services.clone();
        let (path, token) = (photo.image_path.clone(), cancel.clone());
        let work = rt::spawn(async move { services.extraction_corner_suggestions.suggest(&path, &token).await });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |page, cx| page.finish_suggestion(result, &photo, generation, &cancel, cx));
        })
        .detach();
    }

    fn finish_suggestion(
        &mut self,
        result: Result<ExtractionCornerSuggestion>,
        photo: &CameraPhoto,
        generation: u64,
        cancel: &CancellationToken,
        cx: &mut Context<Self>,
    ) {
        let mut snap_after = None;
        match result {
            Ok(result) => {
                let stale = cancel.is_cancelled()
                    || generation != self.suggestion_generation
                    || !self.use_model_suggestions
                    || !self.is_current(photo)
                    || !self.points.is_empty();
                if !stale {
                    let version = short_version(&result.model_version);
                    let confidence = percent(result.presence_probability);
                    let validation = match &result.corners {
                        None => GeometryValidation {
                            is_valid: false,
                            message: result
                                .rejection_reason
                                .clone()
                                .unwrap_or_else(|| "The model did not return four usable corners.".into()),
                        },
                        Some(corners) => CardGeometryService::validate(corners),
                    };
                    match result.corners {
                        Some(corners) if validation.is_valid => {
                            self.push_undo();
                            self.replace_points(corners, cx);
                            self.suggestion_is_warning = !result.would_be_accepted;
                            self.suggestion_status = if result.would_be_accepted {
                                format!("Suggested by {version} · confidence {confidence}. Review, adjust, then save.")
                            } else {
                                format!(
                                    "Low-confidence suggestion from {version} · confidence {confidence} · {}. Review carefully before saving.",
                                    friendly_reason(result.rejection_reason.as_deref())
                                )
                            };
                            // A low-confidence suggestion keeps its warning; snapping corners in the wrong place won't
                            // help it.
                            if result.would_be_accepted && self.snap_suggestions {
                                snap_after = Some(format!("Suggested by {version} · confidence {confidence}. "));
                            }
                        }
                        _ => {
                            self.suggestion_is_warning = true;
                            self.suggestion_status =
                                format!("No usable suggestion from {version}: {}", validation.message);
                        }
                    }
                }
            }
            Err(error) if is_cancelled(&error) && cancel.is_cancelled() => {}
            Err(error) => {
                if generation == self.suggestion_generation {
                    self.set_use_model_suggestions(false, cx);
                    self.suggestion_is_warning = true;
                    self.suggestion_status = format!("Model suggestions were turned off: {error:#}");
                }
            }
        }
        // Nothing cancelled or replaced this request meanwhile: it is still the pending one.
        if generation == self.suggestion_generation {
            self.suggestion_cancel = None;
            self.is_suggesting = false;
        }
        cx.notify();
        if let Some(prefix) = snap_after
            && self.is_current(photo)
            && self.can_snap_to_edges()
        {
            self.snap(prefix, cx);
        }
    }

    fn cancel_pending_suggestion(&mut self) {
        self.suggestion_generation += 1;
        if let Some(cancel) = self.suggestion_cancel.take() {
            cancel.cancel();
        }
        self.is_suggesting = false;
    }

    fn cancel_suggestion_for_manual_edit(&mut self) {
        self.cancel_pending_suggestion();
        if !self.use_model_suggestions {
            return;
        }
        self.suggestion_is_warning = false;
        self.suggestion_status = "Manual points kept. Model suggestions will run again on the next photo.".into();
    }

    fn set_use_model_suggestions(&mut self, value: bool, cx: &mut Context<Self>) {
        if self.use_model_suggestions == value {
            return;
        }
        self.use_model_suggestions = value;
        cx.notify();
        if !value {
            self.cancel_pending_suggestion();
            self.suggestion_is_warning = false;
            self.suggestion_status = "Model suggestions are off.".into();
            let services = self.services.clone();
            let _ = rt::spawn(async move {
                services.extraction_corner_suggestions.stop().await;
                Ok(())
            });
            return;
        }

        self.suggestion_is_warning = false;
        if self.is_reviewing {
            self.suggestion_status = "Saved annotations are loaded as-is during review.".into();
        } else if self.current.is_none() {
            self.suggestion_status = "Model suggestions are on and will run when a photo is available.".into();
        } else if !self.points.is_empty() {
            self.suggestion_status = "Model suggestions are on and will run automatically on the next photo. Existing points will not be replaced.".into();
        } else {
            self.suggest_current_photo(cx);
        }
    }

    /// SnapToEdgesAsync. `prefix` keeps an automatic snap's suggestion details in front of the snap's own status.
    fn snap(&mut self, prefix: String, cx: &mut Context<Self>) {
        let Some(photo) = self.current.clone() else {
            return;
        };
        if self.points.len() != 4 {
            return;
        }
        self.cancel_pending_suggestion();
        let generation = self.suggestion_generation;
        let corners = self.points.clone();
        self.is_suggesting = true;
        self.suggestion_is_warning = false;
        self.suggestion_status = "Snapping corners to the card edges on the full-resolution photo…".into();
        cx.notify();
        let services = self.services.clone();
        let path = photo.image_path.clone();
        let work = rt::spawn(async move {
            services.extraction_corner_suggestions.refine(&path, &corners, &CancellationToken::new()).await
        });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |page, cx| page.finish_snap(result, &photo, generation, &prefix, cx));
        })
        .detach();
    }

    fn finish_snap(
        &mut self,
        result: Result<ExtractionCornerRefinement>,
        photo: &CameraPhoto,
        generation: u64,
        prefix: &str,
        cx: &mut Context<Self>,
    ) {
        match result {
            // A manual edit or photo change while the worker ran makes this result stale.
            Ok(_) if generation != self.suggestion_generation || !self.is_current(photo) => {}
            Ok(result) => match result.corners {
                Some(corners) if result.refiner_available => {
                    let validation = CardGeometryService::validate(&corners);
                    if !result.refined {
                        // The refiner fell back to the given points (low confidence or invalid result).
                        self.suggestion_is_warning = true;
                        self.suggestion_status = format!(
                            "{prefix}The refiner was not confident enough to move these corners. Zoom in and place them where the straight edges meet."
                        );
                    } else if !validation.is_valid {
                        self.suggestion_is_warning = true;
                        self.suggestion_status =
                            format!("{prefix}Snapped corners were rejected: {}", validation.message);
                    } else {
                        self.push_undo();
                        self.replace_points(corners, cx);
                        self.suggestion_status = format!(
                            "{prefix}Snapped to the card edges (largest move {} of the card diagonal). Corners the refiner was unsure about were left in place. Review, then save; Undo restores your points.",
                            percent(result.maximum_shift)
                        );
                    }
                }
                _ => {
                    self.suggestion_is_warning = true;
                    self.suggestion_status = if result.refiner_available {
                        format!("{prefix}The refiner could not snap these corners; adjust them manually.")
                    } else {
                        format!(
                            "{prefix}{} has no corner refiner. Train a newer extractor to enable snapping.",
                            short_version(&result.model_version)
                        )
                    };
                }
            },
            Err(error) => {
                if generation == self.suggestion_generation {
                    self.suggestion_is_warning = true;
                    self.suggestion_status = format!("{prefix}Snap to card edges failed: {error:#}");
                }
            }
        }
        if generation == self.suggestion_generation {
            self.is_suggesting = false;
        }
        cx.notify();
    }

    fn is_current(&self, photo: &CameraPhoto) -> bool {
        self.current.as_ref().is_some_and(|current| same(current, photo))
    }

    // ---- Canvas ------------------------------------------------------------------------------------------------

    fn geometry(&self) -> Geometry {
        let (width, height) = self.current.as_ref().map_or((0, 0), |photo| (photo.image_width, photo.image_height));
        Geometry::new(self.canvas_bounds.get().size, width, height, self.view)
    }

    fn local(&self, position: Point<Pixels>) -> (f32, f32) {
        let origin = self.canvas_bounds.get().origin;
        (f32::from(position.x - origin.x), f32::from(position.y - origin.y))
    }

    /// The points as drawn: a dragged marker where the pointer has it.
    fn shown_points(&self) -> Vec<NormalizedPoint> {
        self.points
            .iter()
            .enumerate()
            .map(|(index, point)| match &self.drag {
                Some(drag) if drag.index == index => drag.point,
                _ => *point,
            })
            .collect()
    }

    fn zoom_by(&mut self, factor: f32, cx: &mut Context<Self>) {
        let geometry = self.geometry();
        self.view = geometry.zoom_at(factor, geometry.center());
        cx.notify();
    }

    fn reset_zoom(&mut self, cx: &mut Context<Self>) {
        self.view = View::FIT;
        cx.notify();
    }

    fn mouse_down(&mut self, button: MouseButton, position: Point<Pixels>, cx: &mut Context<Self>) {
        let geometry = self.geometry();
        if !self.has_photo() || self.is_loading_workspace || geometry.fit_w == 0. {
            return;
        }
        let at = self.local(position);
        match button {
            MouseButton::Right | MouseButton::Middle => {
                if self.view.zoom > 1. {
                    self.pan = Some(at);
                    cx.notify();
                }
            }
            // A save or move in flight would drop the edit when the next photo replaces this one.
            MouseButton::Left if self.is_busy => {}
            MouseButton::Left => {
                let shown: Vec<(f32, f32)> =
                    self.shown_points().into_iter().map(|point| geometry.to_canvas(point)).collect();
                if let Some(hit) = shown.iter().position(|point| (point.0 - at.0).hypot(point.1 - at.1) <= HIT_RADIUS) {
                    self.selected = Some(hit);
                    let offset = (shown[hit].0 - at.0, shown[hit].1 - at.1);
                    self.drag = Some(Drag { index: hit, point: self.points[hit], from: at, offset, moved: false });
                    cx.notify();
                    return;
                }
                let point = geometry.to_photo(at.0, at.1);
                if self.points.len() >= 4 || !(0.0..=1.0).contains(&point.x) || !(0.0..=1.0).contains(&point.y) {
                    return;
                }
                self.selected = Some(self.points.len());
                self.add_point(point, cx);
            }
            _ => {}
        }
    }

    fn mouse_move(&mut self, position: Point<Pixels>, pressed: Option<MouseButton>, cx: &mut Context<Self>) {
        if self.drag.is_none() && self.pan.is_none() {
            return;
        }
        // A release the window never saw ends the drag as a cancel would.
        if pressed.is_none() {
            self.end_pointer(cx);
            return;
        }
        let at = self.local(position);
        let geometry = self.geometry();
        if let Some(drag) = &mut self.drag {
            if drag.moved || (at.0 - drag.from.0).hypot(at.1 - drag.from.1) > DRAG_THRESHOLD {
                drag.point = clamp(geometry.to_photo(at.0 + drag.offset.0, at.1 + drag.offset.1));
                drag.moved = true;
                cx.notify();
            }
        } else if let Some(last) = self.pan.replace(at) {
            let view = self.view;
            self.view = geometry.clamp(View { x: view.x + at.0 - last.0, y: view.y + at.1 - last.1, ..view });
            cx.notify();
        }
    }

    fn mouse_up(&mut self, cx: &mut Context<Self>) {
        if let Some(drag) = self.drag.take()
            && drag.moved
        {
            self.place_corner(drag.index, drag.point, cx);
        }
        self.end_pointer(cx);
    }

    /// Ends a drag or a pan.
    fn end_pointer(&mut self, cx: &mut Context<Self>) {
        if self.drag.take().is_some() | self.pan.take().is_some() {
            cx.notify();
        }
    }

    fn scroll(&mut self, position: Point<Pixels>, delta: ScrollDelta, cx: &mut Context<Self>) {
        let delta_y = f32::from(delta.pixel_delta(px(20.)).y);
        if !self.has_photo() || delta_y == 0. {
            return;
        }
        // Scrolling up (content moving down) zooms in.
        let factor = if delta_y > 0. { WHEEL_STEP } else { 1. / WHEEL_STEP };
        self.view = self.geometry().zoom_at(factor, self.local(position));
        cx.notify();
    }

    fn on_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let keystroke = &event.keystroke;
        let modifiers = keystroke.modifiers;
        let key = keystroke.key.to_lowercase();
        let typed = keystroke.key_char.as_deref().unwrap_or("");
        if modifiers.control && key == "z" {
            cx.stop_propagation();
            if self.can_undo() {
                self.undo(cx);
            }
            return;
        }
        if modifiers.control || modifiers.alt || modifiers.platform {
            return;
        }
        let plus = typed == "+" || key == "+" || key == "=";
        let minus = typed == "-" || key == "-";
        // A held key browses and zooms, but never saves or labels photo after photo unseen.
        if event.is_held && !(key == "left" || key == "right" || plus || minus) {
            return;
        }
        match key.as_str() {
            // A focused button takes Enter itself.
            "enter" => {
                if self.focus.is_focused(window) && self.can_save() {
                    self.save(true, cx);
                }
            }
            "n" if self.can_use_photo() => self.save(false, cx),
            "s" if self.can_use_photo() => self.skip(cx),
            "right" if self.can_move(1) => self.move_through_queue(1, cx),
            "left" if self.can_move(-1) => self.move_through_queue(-1, cx),
            "r" if self.can_rotate() => self.rotate_points_clockwise(cx),
            "delete" | "backspace" if self.can_clear() => self.clear_points(cx),
            "e" if self.can_snap_to_edges() => self.snap(String::new(), cx),
            "0" => self.reset_zoom(cx),
            _ if plus => self.zoom_by(BUTTON_STEP, cx),
            _ if minus => self.zoom_by(1. / BUTTON_STEP, cx),
            "n" | "s" | "right" | "left" | "r" | "delete" | "backspace" | "e" => {}
            _ => return,
        }
        cx.stop_propagation();
    }

    fn toggle_tag(&mut self, tag: &str, cx: &mut Context<Self>) {
        let mut chosen = condition_tags(&self.capture_condition);
        if let Some(index) = chosen.iter().position(|chosen| chosen == tag) {
            chosen.remove(index);
        } else {
            chosen.push(tag.to_string());
        }
        self.capture_condition = shown_tags(&self.capture_condition)
            .into_iter()
            .filter(|tag| chosen.contains(tag))
            .collect::<Vec<_>>()
            .join(", ");
        cx.notify();
    }

    // ---- Rendering ---------------------------------------------------------------------------------------------

    fn render_canvas(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let scene = Scene {
            image: self.photo_image.clone(),
            image_width: self.current.as_ref().map_or(0, |photo| photo.image_width),
            image_height: self.current.as_ref().map_or(0, |photo| photo.image_height),
            view: self.view,
            points: self.shown_points(),
            selected: self.selected,
        };
        let grabbing = self.drag.is_some() || self.pan.is_some();
        let bounds_cell = self.canvas_bounds.clone();
        let page = cx.entity().downgrade();
        let focus = self.focus.clone();
        let loading = self.is_loading_workspace;
        let empty = self.photo_image.is_none() && !loading;

        div()
            .relative()
            .size_full()
            .overflow_hidden()
            .rounded(px(annotation_canvas::RADIUS))
            .bg(theme::color_alpha(0x00000080))
            .child(
                canvas(
                    move |bounds, window, _| {
                        bounds_cell.set(bounds);
                        window.insert_hitbox(bounds, HitboxBehavior::Normal)
                    },
                    move |bounds, hitbox, window, cx| {
                        window.set_cursor_style(
                            if grabbing { CursorStyle::ClosedHand } else { CursorStyle::Crosshair },
                            &hitbox,
                        );
                        annotation_canvas::paint(&scene, bounds, window, cx);

                        let (down_page, down_hitbox) = (page.clone(), hitbox.clone());
                        window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
                            if phase != DispatchPhase::Bubble || !down_hitbox.is_hovered(window) {
                                return;
                            }
                            focus.focus(window, cx);
                            let _ = down_page.update(cx, |page, cx| page.mouse_down(event.button, event.position, cx));
                        });
                        let move_page = page.clone();
                        window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                            if phase == DispatchPhase::Bubble {
                                let _ = move_page
                                    .update(cx, |page, cx| page.mouse_move(event.position, event.pressed_button, cx));
                            }
                        });
                        let up_page = page.clone();
                        window.on_mouse_event(move |_: &MouseUpEvent, phase, _, cx| {
                            if phase == DispatchPhase::Bubble {
                                let _ = up_page.update(cx, |page, cx| page.mouse_up(cx));
                            }
                        });
                        window.on_mouse_event(move |event: &ScrollEvent, phase, window, cx| {
                            if phase == DispatchPhase::Bubble && hitbox.should_handle_scroll(window) {
                                let _ = page.update(cx, |page, cx| page.scroll(event.position, event.delta, cx));
                            }
                        });
                    },
                )
                .absolute()
                .inset_0()
                .size_full(),
            )
            .when(empty, |el| {
                el.child(
                    v_flex()
                        .absolute()
                        .inset_0()
                        .items_center()
                        .justify_center()
                        .gap(px(4.))
                        .child(div().font_weight(FontWeight::SEMIBOLD).child("No photo to annotate"))
                        .child(ui::muted("Import a folder or refresh the queue.")),
                )
            })
            .when(loading, |el| {
                el.child(
                    v_flex()
                        .absolute()
                        .inset_0()
                        .items_center()
                        .justify_center()
                        .gap(px(10.))
                        .bg(theme::color_alpha(0x0B061099))
                        .child(Spinner::new().color(theme::violet()))
                        .child(ui::muted("Loading workspace…")),
                )
            })
    }

    fn render_toolbars(&self, cx: &mut Context<Self>) -> [AnyElement; 2] {
        let toolbar = || {
            h_flex()
                .absolute()
                .bottom(px(18.))
                .gap(px(4.))
                .p(px(4.))
                .rounded_full()
                .bg(theme::glass())
                .border_1()
                .border_color(theme::hairline())
                .occlude()
        };
        let edit = toolbar()
            .id("annotator-edit-toolbar")
            .left(px(18.))
            .child(
                ui::icon_button("annotator-undo", IconName::Undo2, "Undo (Ctrl+Z)")
                    .disabled(!self.can_undo())
                    .on_click(cx.listener(|page, _, _, cx| page.undo(cx))),
            )
            .child(
                ui::icon_button(
                    "annotator-rotate",
                    IconName::RotateCw,
                    "Rotate the corner labels clockwise (R): TopLeft goes to the old BottomLeft. Press twice if off by two.",
                )
                .disabled(!self.can_rotate())
                .on_click(cx.listener(|page, _, _, cx| page.rotate_points_clockwise(cx))),
            )
            .child(
                ui::icon_button("annotator-clear", IconName::Eraser, "Clear all points (Del)")
                    .disabled(!self.can_clear())
                    .on_click(cx.listener(|page, _, _, cx| page.clear_points(cx))),
            )
            .child(
                ui::icon_button(
                    "annotator-snap",
                    IconName::Magnet,
                    "Snap the points to the card's edges with the trained corner refiner (E). Check the result before saving.",
                )
                .disabled(!self.can_snap_to_edges())
                .on_click(cx.listener(|page, _, _, cx| page.snap(String::new(), cx))),
            );
        let zoom = toolbar()
            .id("annotator-zoom-toolbar")
            .right(px(18.))
            .child(
                ui::icon_button("annotator-zoom-out", IconName::ZoomOut, "Zoom out (−)")
                    .on_click(cx.listener(|page, _, _, cx| page.zoom_by(1. / BUTTON_STEP, cx))),
            )
            .child(
                div()
                    .w(px(40.))
                    .text_center()
                    .font_family(theme::MONO_FONT)
                    .text_size(px(12.))
                    .text_color(theme::text_muted())
                    .child(format!("{}%", (self.view.zoom * 100.).round())),
            )
            .child(
                ui::icon_button("annotator-fit", IconName::Maximize2, "Fit photo to view (0)")
                    .on_click(cx.listener(|page, _, _, cx| page.reset_zoom(cx))),
            )
            .child(
                ui::icon_button("annotator-zoom-in", IconName::ZoomIn, "Zoom in (+)")
                    .on_click(cx.listener(|page, _, _, cx| page.zoom_by(BUTTON_STEP, cx))),
            );
        [edit.into_any_element(), zoom.into_any_element()]
    }

    fn render_rail(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let placing = self.points.len() < 4 && self.photo_image.is_some();
        let geometry_text =
            if placing { format!("Place next: {}", self.next_corner_name()) } else { self.geometry_status.clone() };
        let geometry_color = if self.geometry_is_valid {
            theme::success()
        } else if placing {
            theme::violet()
        } else {
            theme::text()
        };
        let preview = ui::section(None, None, vec![])
            .flex_1()
            .min_h(px(360.))
            .gap(px(12.))
            .child(
                h_flex()
                    .justify_between()
                    .items_start()
                    .gap(px(8.))
                    .child(div().text_size(px(14.)).font_weight(FontWeight::BOLD).text_color(geometry_color).child(geometry_text))
                    .child(
                        ui::icon_button(
                            "annotator-how-to",
                            IconName::Info,
                            "Click the four corners in order: top left, top right, bottom right, bottom left. Place each where the two straight card edges would meet, not on the rounded corner, and line the dashed guides up with the card's edges. Leave sleeves out.",
                        )
                        .small(),
                    ),
            )
            .child(
                ui::image_well(
                    self.preview.clone().map(ImageSource::Render),
                    "Place four corners to see the card straightened",
                )
                .flex_1()
                .w_full(),
            );

        let suggestion = (self.is_suggesting || self.suggestion_is_warning).then(|| {
            // Only a suggestion that went wrong says so; the points on the photo show the rest.
            h_flex()
                .items_start()
                .gap(px(8.))
                .mt(px(6.))
                .when(self.is_suggesting, |el| {
                    el.child(div().mt(px(2.)).child(Spinner::new().small().color(theme::violet())))
                })
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(if self.suggestion_is_warning { theme::warning() } else { theme::text_muted() })
                        .child(if self.is_suggesting {
                            "Suggesting corners…".to_string()
                        } else {
                            self.suggestion_status.clone()
                        }),
                )
        });

        // Stored comma-separated in CaptureCondition; training reports accuracy per tag. A condition typed before the
        // chips existed shows as a chip of its own, so tagging the photo doesn't drop it.
        let chosen = condition_tags(&self.capture_condition);
        let chips = shown_tags(&self.capture_condition).into_iter().enumerate().map(|(index, tag)| {
            let checked = chosen.contains(&tag);
            let label = tag.clone();
            chip(("annotator-tag", index), tag, checked)
                .on_click(cx.listener(move |page, _, _, cx| page.toggle_tag(&label, cx)))
        });

        let controls = ui::section(None, None, vec![])
            .child(
                v_flex()
                    .gap(px(8.))
                    .child(
                        Switch::new("annotator-suggest")
                            .small()
                            .label("Suggest corners with the current model")
                            .checked(self.use_model_suggestions)
                            .on_change(cx.listener(|page, checked: &bool, _, cx| page.set_use_model_suggestions(*checked, cx))),
                    )
                    .child(
                        Switch::new("annotator-snap-suggestions")
                            .small()
                            .label("Snap them to edges")
                            .tooltip("Move each confident suggestion onto the card's edges with the extractor's full-resolution corner refiner.")
                            .checked(self.snap_suggestions)
                            .disabled(!self.use_model_suggestions)
                            .on_change(cx.listener(|page, checked: &bool, _, cx| {
                                page.snap_suggestions = *checked;
                                cx.notify();
                            })),
                    ),
            )
            .children(suggestion)
            .child(div().mt(px(12.)).mb(px(4.)).text_size(px(12.)).text_color(theme::text_muted()).child("Conditions"))
            .child(h_flex().flex_wrap().gap(px(4.)).children(chips))
            .child(
                v_flex()
                    .gap(px(6.))
                    .mt(px(12.))
                    .child(
                        ui::primary_button("annotator-save", "Save & next", Some(IconName::Check))
                            .w_full()
                            .disabled(!self.can_save())
                            .on_click(cx.listener(|page, _, _, cx| page.save(true, cx))),
                    )
                    .child(
                        h_flex()
                            .gap(px(6.))
                            .child(
                                ui::secondary_button("annotator-skip", "Skip", Some(IconName::SkipForward))
                                    .flex_1()
                                    .disabled(!self.can_use_photo())
                                    .on_click(cx.listener(|page, _, _, cx| page.skip(cx))),
                            )
                            .child(
                                ui::secondary_button("annotator-no-card", "No card", Some(IconName::SquareX))
                                    .flex_1()
                                    .disabled(!self.can_use_photo())
                                    .on_click(cx.listener(|page, _, _, cx| page.save(false, cx))),
                            ),
                    )
                    .child(ui::dim(self.status.clone()).text_color(theme::text_muted())),
            );

        v_flex()
            .id("annotator-rail")
            .flex_none()
            .w(px(340.))
            .h_full()
            .min_h_0()
            .gap(px(12.))
            .overflow_y_scroll()
            .child(preview)
            .child(controls)
    }
}

impl Render for AnnotatorPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let busy = self.is_busy;
        let actions = vec![
            Switch::new("annotator-newest-first")
                .label("Newest first")
                .checked(self.newest_first)
                .mr(px(8.))
                .on_change(cx.listener(|page, checked: &bool, _, cx| page.set_newest_first(*checked, cx)))
                .into_any_element(),
            ui::icon_button("annotator-refresh", IconName::RefreshCw, "Refresh queue")
                .disabled(busy)
                .on_click(cx.listener(|page, _, _, cx| page.refresh(cx)))
                .into_any_element(),
            ui::secondary_button("annotator-review", "Review annotated", Some(IconName::ListChecks))
                .disabled(busy)
                .on_click(cx.listener(|page, _, _, cx| page.review_annotated(cx)))
                .into_any_element(),
            ui::primary_button("annotator-import", "Import folder", Some(IconName::FolderPlus))
                .disabled(busy)
                .on_click(cx.listener(|page, _, _, cx| page.import_folders(cx)))
                .into_any_element(),
        ];
        let review_position = self.review_position();

        let info = h_flex()
            .flex_none()
            .flex_wrap()
            .gap_x(px(18.))
            .gap_y(px(10.))
            .py(px(10.))
            .px(px(16.))
            .rounded(px(10.))
            .bg(theme::glass())
            .border_1()
            .border_color(theme::hairline())
            .child(div().font_weight(FontWeight::SEMIBOLD).child(self.current_file_name.clone()))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .font_family(theme::MONO_FONT)
                    .text_size(px(12.))
                    .text_color(theme::text_dim())
                    .child(self.current_relative_path.clone()),
            )
            .when(!review_position.is_empty(), |el| {
                el.child(
                    div()
                        .text_size(px(14.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme::lavender())
                        .child(review_position),
                )
            })
            .child(
                div()
                    .text_size(px(14.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme::violet())
                    .child(self.queue_summary()),
            );

        let stage = div()
            .relative()
            .flex_1()
            .min_w_0()
            .h_full()
            .p(px(8.))
            .rounded(px(14.))
            .bg(theme::glass())
            .border_1()
            .border_color(theme::hairline())
            .child(self.render_canvas(cx))
            .children(self.render_toolbars(cx));

        ui::page("annotator", false)
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            .child(ui::page_header(DISPLAY_NAME, DESCRIPTION, None, actions))
            .child(info)
            .child(div().flex().flex_row().flex_1().min_h_0().gap(px(16.)).child(stage).child(self.render_rail(cx)))
            .child(hint())
    }
}

fn hint() -> impl IntoElement {
    enum Part {
        Text(&'static str),
        Key(&'static str),
    }
    use Part::{Key, Text};
    let parts = [
        Text("Click: place a corner ·"),
        Text("Drag a marker: adjust ·"),
        Text("Right-drag: pan ·"),
        Text("Scroll: zoom ·"),
        Key("Enter"),
        Text("save & next ·"),
        Key("N"),
        Text("no card ·"),
        Key("S"),
        Text("skip ·"),
        Key("←"),
        Key("→"),
        Text("browse ·"),
        Key("Ctrl+Z"),
        Text("undo ·"),
        Key("R"),
        Text("rotate ·"),
        Key("Del"),
        Text("clear ·"),
        Key("E"),
        Text("snap ·"),
        Key("+"),
        Key("−"),
        Key("0"),
        Text("zoom"),
    ];
    h_flex().flex_none().flex_wrap().gap(px(4.)).text_size(px(12.)).text_color(theme::text_dim()).children(
        parts.into_iter().map(|part| match part {
            Text(text) => div().child(text),
            Key(key) => div()
                .min_w(px(20.))
                .px(px(5.))
                .mx(px(2.))
                .rounded(px(6.))
                .border_1()
                .border_color(theme::color_alpha(0xFFFFFF24))
                .bg(theme::color_alpha(0xFFFFFF0D))
                .font_family(theme::MONO_FONT)
                .text_size(px(11.))
                .line_height(px(18.))
                .text_center()
                .text_color(theme::text_muted())
                .child(key),
        }),
    )
}

/// A condition tag that ticks on and off (Mantine's outline Chip).
fn chip(id: impl Into<ElementId>, label: String, checked: bool) -> Stateful<Div> {
    h_flex()
        .id(id)
        .gap(px(4.))
        .h(px(24.))
        .px(px(10.))
        .rounded_full()
        .border_1()
        .text_size(px(12.))
        .cursor_pointer()
        .map(|el| {
            if checked {
                el.border_color(theme::violet()).bg(theme::tint()).text_color(theme::text())
            } else {
                el.border_color(theme::color_alpha(0xFFFFFF24))
                    .text_color(theme::text_muted())
                    .hover(|el| el.bg(theme::color_alpha(0xFFFFFF0A)))
            }
        })
        .when(checked, |el| el.child(ui::icon(IconName::Check).small().text_color(theme::violet())))
        .child(label)
}

fn condition_tags(value: &str) -> Vec<String> {
    value.split(',').map(str::trim).filter(|tag| !tag.is_empty()).map(str::to_string).collect()
}

/// The standard tags, then any other the photo carries.
fn shown_tags(value: &str) -> Vec<String> {
    let mut tags: Vec<String> = CONDITION_TAGS.iter().map(|tag| tag.to_string()).collect();
    tags.extend(condition_tags(value).into_iter().filter(|tag| !CONDITION_TAGS.contains(&tag.as_str())));
    tags
}

/// Loads a photo off the UI thread (PreparePhoto).
fn prepare(
    services: &Arc<Services>,
    photo: CameraPhoto,
    reviewing: bool,
) -> impl Future<Output = Result<Prepared>> + use<> {
    let store = services.camera_annotation_store.clone();
    rt::spawn(async move {
        tokio::task::spawn_blocking(move || -> Result<Prepared> {
            let bitmap = image::ImageReader::open(&photo.image_path)?.with_guessed_format()?.decode()?.into_rgba8();
            let saved = if reviewing { store.try_load(&photo.annotation_path) } else { None };
            let shown = images::from_rgba(bitmap.clone());
            Ok(Prepared { photo, bitmap: Arc::new(bitmap), shown, saved })
        })
        .await?
    })
}

/// Photo paths compare case-insensitively, as on Windows.
fn key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

fn same(a: &CameraPhoto, b: &CameraPhoto) -> bool {
    key(&a.image_path) == key(&b.image_path)
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
}

fn clamp(point: NormalizedPoint) -> NormalizedPoint {
    NormalizedPoint::new(point.x.clamp(0., 1.), point.y.clamp(0., 1.))
}

fn short_version(version: &str) -> String {
    if version.chars().count() <= 28 {
        version.to_string()
    } else {
        version.chars().take(28).collect::<String>() + "…"
    }
}

fn friendly_reason(reason: Option<&str>) -> String {
    match reason {
        Some("presence_below_threshold") => "below the serving confidence threshold".into(),
        Some("ambiguous_card_geometry") => "ambiguous corner candidates".into(),
        Some("invalid_quadrilateral") => "invalid predicted geometry".into(),
        None | Some("") => "production checks did not accept it".into(),
        Some(reason) => reason.replace('_', " "),
    }
}

/// C#'s "P1".
fn percent(value: f64) -> String {
    format!("{:.1}%", value * 100.)
}
