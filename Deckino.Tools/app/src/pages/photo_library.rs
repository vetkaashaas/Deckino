//! Photo Library (PhotoLibraryViewModel + PhotoLibrary.tsx): every imported camera photo, filtered, searched and
//! paged, ticked for deletion, viewed full size, and photos or folders dropped from Explorer imported.

use deckino_core::n0;
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use deckino_core::camera_annotation::{CameraDeleteResult, CameraImportResult, CameraPhoto};
use deckino_core::camera_annotation_store::DEFAULT_THUMBNAIL_SIZE;
use deckino_core::services::Services;
use futures::StreamExt;
use futures::channel::oneshot;
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::pagination::Pagination;
use gpui_kit::component::{Disableable, Sizable, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use tokio_util::sync::CancellationToken;

use crate::shell::PageEntry;
use crate::ui::{self, IconName};
use crate::{events, images, rt, theme};

const DESCRIPTION: &str = "Review every imported camera photo, annotation status, and owned working file.";
const PAGE_SIZE: usize = 60;
const FILTERS: [&str; 3] = ["All", "Annotated", "Unannotated"];
/// Thumbnails kept in memory; past this only the current page's stay.
const THUMBNAIL_CACHE: usize = 240;
/// Thumbnails decoded at once (a photo decodes at up to 2048 px).
const THUMBNAIL_LOADS: usize = 4;
const TILE_WIDTH: f32 = 210.;
const TILE_GAP: f32 = 12.;

pub fn entry(services: Arc<Services>, window: &mut Window, cx: &mut App) -> PageEntry {
    let view = cx.new(|cx| PhotoLibraryPage::new(services, window, cx));
    let opened = view.clone();
    PageEntry {
        key: "photoLibrary",
        name: "Photo Library".into(),
        icon: IconName::Image,
        view: view.into(),
        opened: Some(Rc::new(move |_, cx| opened.update(cx, |page, cx| page.refresh(cx)))),
        left: None,
    }
}

struct PhotoLibraryPage {
    services: Arc<Services>,
    all_photos: Vec<CameraPhoto>,
    /// Keys (`selection_key`) of the ticked photos, across pages and filters.
    selected: HashSet<String>,
    page_items: Vec<CameraPhoto>,
    active_filter: &'static str,
    search: Entity<InputState>,
    // File search: several names or paths separated by spaces, commas or new lines match any of them.
    search_text: String,
    search_commit: Task<()>,
    current_page: usize,
    total_pages: usize,
    matching_count: usize,
    status: String,
    busy: bool,
    /// None: the thumbnail could not be made.
    thumbnails: HashMap<PathBuf, Option<Arc<RenderImage>>>,
    loading: HashSet<PathBuf>,
    thumbnail_gate: Arc<tokio::sync::Semaphore>,
    warm_next: Option<CancellationToken>,
    grid_width: Pixels,
    scroll: UniformListScrollHandle,
    viewing: Option<CameraPhoto>,
    viewer_focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

/// Paths compare ignoring case, as Windows does.
fn selection_key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

/// The library's scan, off the UI thread: every photo and how many image files could not be read.
async fn scan(services: Arc<Services>) -> anyhow::Result<(Vec<CameraPhoto>, usize)> {
    rt::spawn(async move { tokio::task::spawn_blocking(move || services.camera_annotation_store.scan_photos()).await? })
        .await
}

impl PhotoLibraryPage {
    fn new(services: Arc<Services>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search =
            cx.new(|cx| InputState::new(window, cx).placeholder("Search file names (several: space or comma)"));
        // Typing commits after a pause; leaving the field or Enter commits at once.
        let subscriptions = vec![cx.subscribe_in(&search, window, |page, state, event: &InputEvent, _, cx| {
            let value = state.read(cx).value().to_string();
            match event {
                InputEvent::Change => {
                    page.search_commit = cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(Duration::from_millis(300)).await;
                        let _ = this.update(cx, |page, cx| page.set_search(value, cx));
                    });
                }
                InputEvent::Blur | InputEvent::PressEnter { .. } => {
                    page.search_commit = Task::ready(());
                    page.set_search(value, cx);
                }
                _ => {}
            }
        })];
        Self {
            services,
            all_photos: Vec::new(),
            selected: HashSet::new(),
            page_items: Vec::new(),
            active_filter: "All",
            search,
            search_text: String::new(),
            search_commit: Task::ready(()),
            current_page: 1,
            total_pages: 1,
            matching_count: 0,
            status: "Open the library to scan imported photos.".into(),
            busy: false,
            thumbnails: HashMap::new(),
            loading: HashSet::new(),
            thumbnail_gate: Arc::new(tokio::sync::Semaphore::new(THUMBNAIL_LOADS)),
            warm_next: None,
            grid_width: px(0.),
            scroll: UniformListScrollHandle::new(),
            viewing: None,
            viewer_focus: cx.focus_handle(),
            _subscriptions: subscriptions,
        }
    }

    fn has_matches(&self) -> bool {
        self.matching_count > 0 && !self.busy
    }

    fn has_selection(&self) -> bool {
        !self.selected.is_empty() && !self.busy
    }

    fn open_photos_folder(&self) {
        events::open_folder(self.services.camera_annotation_store.imports_root());
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        cx.notify();
        let services = self.services.clone();
        cx.spawn(async move |this, cx| {
            let scanned = scan(services).await;
            let _ = this.update(cx, |page, cx| {
                match scanned {
                    Ok((photos, skipped)) => {
                        let paths: HashSet<String> =
                            photos.iter().map(|photo| selection_key(&photo.image_path)).collect();
                        page.selected.retain(|path| paths.contains(path));
                        let count = photos.len();
                        page.show_photos(photos, cx);
                        page.status = if skipped == 0 {
                            format!("Loaded {} camera photos.", n0(count))
                        } else {
                            format!(
                                "Loaded {} camera photos; skipped {} unreadable image files.",
                                n0(count),
                                n0(skipped)
                            )
                        };
                    }
                    Err(error) => page.status = format!("Could not load the photo library: {error:#}"),
                }
                page.busy = false;
                cx.notify();
            });
        })
        .detach();
    }

    /// RefreshAsyncCore after the scan: the page stays where it was as far as it still exists.
    fn show_photos(&mut self, photos: Vec<CameraPhoto>, cx: &mut Context<Self>) {
        // A photo replaced in place (a sync download, Keep remote) gets a new thumbnail: the C# URL carried its
        // write time and size for the same reason. A photo gone from the library drops its thumbnail too, or a later
        // file at the same path would show it.
        let before: HashMap<&PathBuf, _> =
            self.all_photos.iter().map(|photo| (&photo.image_path, (photo.modified_utc, photo.file_length))).collect();
        let current: HashMap<&PathBuf, _> =
            photos.iter().map(|photo| (&photo.image_path, (photo.modified_utc, photo.file_length))).collect();
        let stale: Vec<_> = self
            .thumbnails
            .extract_if(|path, _| {
                current.get(path).is_none_or(|stamp| before.get(path).is_some_and(|old| old != stamp))
            })
            .filter_map(|(_, thumbnail)| thumbnail)
            .collect();
        images::release(stale, cx);
        self.all_photos = photos;
        // A photo that failed may be readable now.
        self.thumbnails.retain(|_, thumbnail| thumbnail.is_some());
        self.rebuild_page(cx);
    }

    // Photos or folders dropped from Explorer: the same import as Corner Annotator's, without a capture condition.
    fn import_dropped(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        if self.busy || paths.is_empty() {
            return;
        }
        self.busy = true;
        self.status = "Importing and normalizing dropped photos…".into();
        cx.notify();
        let services = self.services.clone();
        cx.spawn(async move |this, cx| {
            let importer = services.clone();
            let imported = rt::spawn(async move {
                let _operation = importer.coordinator.acquire("import camera photos")?;
                tokio::task::spawn_blocking(move || importer.camera_image_import.import(&paths, None)).await?
            })
            .await;
            let outcome: anyhow::Result<(CameraImportResult, Vec<CameraPhoto>)> = match imported {
                Ok(result) => scan(services).await.map(|(photos, _)| (result, photos)),
                Err(error) => Err(error),
            };
            let message = this
                .update(cx, |page, cx| match outcome {
                    Ok((result, photos)) => {
                        page.show_photos(photos, cx);
                        page.status = format!(
                            "Imported {}; skipped {}; failed {}.",
                            n0(result.imported),
                            n0(result.skipped),
                            n0(result.failed)
                        );
                        cx.notify();
                        (!result.errors.is_empty()).then(|| {
                            events::message(cx, "Photo import completed with errors", first_errors(&result.errors))
                        })
                    }
                    Err(error) => {
                        page.status = format!("Photo import failed: {error:#}");
                        None
                    }
                })
                .ok()
                .flatten();
            if let Some(answer) = message {
                let _ = answer.await;
            }
            let _ = this.update(cx, |page, cx| {
                page.busy = false;
                cx.notify();
            });
        })
        .detach();
    }

    fn set_filter(&mut self, filter: &'static str, cx: &mut Context<Self>) {
        self.active_filter = filter;
        self.current_page = 1;
        self.rebuild_page(cx);
        self.scroll.scroll_to_item(0, ScrollStrategy::Top);
    }

    fn set_search(&mut self, value: String, cx: &mut Context<Self>) {
        if value == self.search_text {
            return;
        }
        self.search_text = value;
        self.current_page = 1;
        self.rebuild_page(cx);
        self.scroll.scroll_to_item(0, ScrollStrategy::Top);
    }

    fn go_to_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.current_page = page.clamp(1, self.total_pages);
        self.rebuild_page(cx);
        self.scroll.scroll_to_item(0, ScrollStrategy::Top);
    }

    fn toggle_selected(&mut self, path: &Path, cx: &mut Context<Self>) {
        let key = selection_key(path);
        if !self.selected.remove(&key) {
            self.selected.insert(key);
        }
        cx.notify();
    }

    fn select_all_matching(&mut self, cx: &mut Context<Self>) {
        if !self.has_matches() {
            return;
        }
        for index in self.filtered_photos() {
            self.selected.insert(selection_key(&self.all_photos[index].image_path));
        }
        cx.notify();
    }

    fn clear_selection(&mut self, cx: &mut Context<Self>) {
        if !self.has_selection() {
            return;
        }
        self.selected.clear();
        cx.notify();
    }

    fn delete_annotations(&mut self, cx: &mut Context<Self>) {
        if !self.has_selection() {
            return;
        }
        let annotations = self.selected_photos().iter().filter(|photo| photo.annotation_path.exists()).count();
        if annotations == 0 {
            self.status = "None of the selected photos has an annotation file.".into();
            cx.notify();
            return;
        }
        let answer = events::ask(
            cx,
            "Delete annotations",
            format!(
                "Permanently delete {} annotation files?\n\nThe photos will be kept and returned to the annotation queue.",
                n0(annotations)
            ),
            "Delete annotations",
            Some("Cancel"),
        );
        Self::delete_when_confirmed(answer, false, false, cx);
    }

    fn delete_annotations_and_identities(&mut self, cx: &mut Context<Self>) {
        if !self.has_selection() {
            return;
        }
        let selected = self.selected_photos();
        let annotations = selected.iter().filter(|photo| photo.annotation_path.exists()).count();
        let identities = selected.iter().filter(|photo| photo.identity_path().exists()).count();
        if annotations + identities == 0 {
            self.status = "None of the selected photos has an annotation or identity file.".into();
            cx.notify();
            return;
        }
        let answer = events::ask(
            cx,
            "Delete annotations and identities",
            format!(
                "Permanently delete {} annotation files and {} card identities?\n\n\
                 The photos will be kept and returned to the Corner Annotator and Identify Card queues. \
                 Phone scans keep the phone's guesses; only their review is cleared.",
                n0(annotations),
                n0(identities)
            ),
            "Delete annotations + identities",
            Some("Cancel"),
        );
        Self::delete_when_confirmed(answer, false, true, cx);
    }

    fn delete_photos(&mut self, cx: &mut Context<Self>) {
        if !self.has_selection() {
            return;
        }
        let selected = self.selected_photos();
        let annotations = selected.iter().filter(|photo| photo.annotation_path.exists()).count();
        let answer = events::ask(
            cx,
            "Delete photos and annotations",
            format!(
                "Permanently delete {} photos and {} matching annotation files?\n\nThis cannot be undone.",
                n0(selected.len()),
                n0(annotations)
            ),
            "Delete permanently",
            Some("Cancel"),
        );
        Self::delete_when_confirmed(answer, true, true, cx);
    }

    fn delete_when_confirmed(
        answer: oneshot::Receiver<bool>,
        delete_photos: bool,
        delete_identities: bool,
        cx: &mut Context<Self>,
    ) {
        cx.spawn(async move |this, cx| {
            if answer.await.unwrap_or(false) {
                let _ = this.update(cx, |page, cx| page.delete_selected(delete_photos, delete_identities, cx));
            }
        })
        .detach();
    }

    fn delete_selected(&mut self, delete_photos: bool, delete_identities: bool, cx: &mut Context<Self>) {
        // The confirmation was awaited: another command may have started (or the selection emptied) meanwhile.
        if self.busy || !self.has_selection() {
            return;
        }
        let selected = self.selected_photos();
        self.busy = true;
        cx.notify();
        let operation = if delete_photos {
            "delete camera photos"
        } else if delete_identities {
            "delete camera annotations and identities"
        } else {
            "delete camera annotations"
        };
        let services = self.services.clone();
        cx.spawn(async move |this, cx| {
            let deleter = services.clone();
            let deleted = rt::spawn(async move {
                let _operation = deleter.coordinator.acquire(operation)?;
                tokio::task::spawn_blocking(move || {
                    deleter.camera_annotation_store.delete_files(&selected, delete_photos, delete_identities)
                })
                .await?
            })
            .await;
            let outcome: anyhow::Result<(CameraDeleteResult, Vec<CameraPhoto>)> = match deleted {
                Ok(result) => {
                    let _ = this.update(cx, |page, _| page.selected.clear());
                    scan(services).await.map(|(photos, _)| (result, photos))
                }
                Err(error) => Err(error),
            };
            let message = this
                .update(cx, |page, cx| match outcome {
                    Ok((result, photos)) => {
                        page.show_photos(photos, cx);
                        let failed = n0(result.errors.len());
                        page.status = if delete_photos {
                            format!(
                                "Deleted {} photos and {} annotations; {failed} failed.",
                                n0(result.deleted_photos),
                                n0(result.deleted_annotations)
                            )
                        } else if delete_identities {
                            format!(
                                "Deleted {} annotations and cleared {} card identities; {failed} failed.",
                                n0(result.deleted_annotations),
                                n0(result.deleted_identities)
                            )
                        } else {
                            format!("Deleted {} annotations; {failed} failed.", n0(result.deleted_annotations))
                        };
                        cx.notify();
                        (!result.errors.is_empty()).then(|| {
                            events::message(cx, "Some files could not be deleted", first_errors(&result.errors))
                        })
                    }
                    Err(error) => {
                        page.status = format!("Delete operation failed: {error:#}");
                        None
                    }
                })
                .ok()
                .flatten();
            if let Some(answer) = message {
                let _ = answer.await;
            }
            let _ = this.update(cx, |page, cx| {
                page.busy = false;
                cx.notify();
            });
        })
        .detach();
    }

    /// Indices into `all_photos` that pass the filter and the search.
    fn filtered_photos(&self) -> Vec<usize> {
        let terms: Vec<String> = self
            .search_text
            .split_whitespace()
            .flat_map(|term| term.split([',', ';']))
            .filter(|term| !term.is_empty())
            .map(str::to_lowercase)
            .collect();
        self.all_photos
            .iter()
            .enumerate()
            .filter(|(_, photo)| match self.active_filter {
                "Annotated" => photo.is_annotated,
                "Unannotated" => !photo.is_annotated,
                _ => true,
            })
            // The relative path ends in the file name, so a pasted name or path (as shown on a tile) both match.
            .filter(|(_, photo)| {
                terms.is_empty() || {
                    let path = photo.relative_path.to_lowercase();
                    terms.iter().any(|term| path.contains(term.as_str()))
                }
            })
            .map(|(index, _)| index)
            .collect()
    }

    fn selected_photos(&self) -> Vec<CameraPhoto> {
        self.all_photos
            .iter()
            .filter(|photo| self.selected.contains(&selection_key(&photo.image_path)))
            .cloned()
            .collect()
    }

    fn rebuild_page(&mut self, cx: &mut Context<Self>) {
        let filtered = self.filtered_photos();
        self.matching_count = filtered.len();
        self.total_pages = filtered.len().div_ceil(PAGE_SIZE).max(1);
        self.current_page = self.current_page.clamp(1, self.total_pages);
        let start = (self.current_page - 1) * PAGE_SIZE;
        self.page_items =
            filtered[start..].iter().take(PAGE_SIZE).map(|&index| self.all_photos[index].clone()).collect();
        let next_page: Vec<PathBuf> = filtered
            .iter()
            .skip(self.current_page * PAGE_SIZE)
            .take(PAGE_SIZE)
            .map(|&index| self.all_photos[index].image_path.clone())
            .collect();
        self.warm_next_page(next_page);
        self.trim_thumbnails(cx);
        cx.notify();
    }

    // The page's tiles load their thumbnails as they come into view; this warms the disk cache for the next page so
    // the next page finds its thumbnails ready. Moving to another page cancels the rest.
    fn warm_next_page(&mut self, next_page: Vec<PathBuf>) {
        if let Some(previous) = self.warm_next.take() {
            previous.cancel();
        }
        let cancel = CancellationToken::new();
        self.warm_next = Some(cancel.clone());
        let store = self.services.camera_annotation_store.clone();
        rt::runtime().spawn(futures::stream::iter(next_page).for_each_concurrent(2, move |path| {
            let (store, cancel) = (store.clone(), cancel.clone());
            async move {
                if !cancel.is_cancelled() {
                    // Best effort: the tile makes it again when it is shown.
                    let _ =
                        tokio::task::spawn_blocking(move || store.warm_thumbnail(&path, DEFAULT_THUMBNAIL_SIZE)).await;
                }
            }
        }));
    }

    fn trim_thumbnails(&mut self, cx: &mut App) {
        if self.thumbnails.len() > THUMBNAIL_CACHE {
            let shown: HashSet<&PathBuf> = self.page_items.iter().map(|photo| &photo.image_path).collect();
            let evicted: Vec<_> =
                self.thumbnails.extract_if(|path, _| !shown.contains(path)).filter_map(|(_, image)| image).collect();
            images::release(evicted, cx);
        }
    }

    /// The thumbnail if loaded; otherwise starts loading it (a small JPEG the store makes and caches on disk).
    fn thumbnail(&mut self, path: &Path, cx: &mut Context<Self>) -> Option<ImageSource> {
        if let Some(thumbnail) = self.thumbnails.get(path) {
            return thumbnail.clone().map(Into::into);
        }
        if !self.loading.insert(path.to_path_buf()) {
            return None;
        }
        let store = self.services.camera_annotation_store.clone();
        let gate = self.thumbnail_gate.clone();
        let path = path.to_path_buf();
        let target = path.clone();
        cx.spawn(async move |this, cx| {
            let bytes = rt::spawn(async move {
                let _slot = gate.acquire_owned().await?;
                tokio::task::spawn_blocking(move || {
                    images::from_jpeg(&store.load_thumbnail(&target, DEFAULT_THUMBNAIL_SIZE)?)
                })
                .await?
            })
            .await;
            let _ = this.update(cx, |page, cx| {
                page.loading.remove(&path);
                page.thumbnails.insert(path, bytes.ok());
                page.trim_thumbnails(cx);
                cx.notify();
            });
        })
        .detach();
        None
    }

    fn view(&mut self, photo: CameraPhoto, window: &mut Window, cx: &mut Context<Self>) {
        self.viewing = Some(photo);
        self.viewer_focus.focus(window, cx);
        cx.notify();
    }

    fn close_viewer(&mut self, cx: &mut Context<Self>) {
        self.viewing = None;
        cx.notify();
    }

    fn columns(&self) -> usize {
        (((self.grid_width.as_f32() + TILE_GAP) / (TILE_WIDTH + TILE_GAP)).floor() as usize).max(1)
    }

    fn render_rows(&mut self, rows: Range<usize>, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let columns = self.columns();
        rows.map(|row| {
            let tiles = (row * columns..(row + 1) * columns).map(|index| {
                match self.page_items.get(index).cloned() {
                    Some(photo) => self.render_tile(index, photo, cx),
                    // Keeps the last row's tiles as wide as the others.
                    None => div().flex_1().flex_basis(px(TILE_WIDTH)).min_w(px(TILE_WIDTH)).into_any_element(),
                }
            });
            h_flex()
                .w_full()
                .items_start()
                .gap(px(TILE_GAP))
                .pb(px(TILE_GAP))
                .children(tiles.collect::<Vec<_>>())
                .into_any_element()
        })
        .collect()
    }

    fn render_tile(&mut self, index: usize, photo: CameraPhoto, cx: &mut Context<Self>) -> AnyElement {
        let thumbnail = self.thumbnail(&photo.image_path, cx);
        let checked = self.selected.contains(&selection_key(&photo.image_path));
        let file_name = photo.image_path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        let (annotation_status, status_color) = if photo.has_invalid_annotation {
            ("Invalid annotation", theme::warning())
        } else if photo.is_annotated {
            ("Annotated", theme::success())
        } else {
            ("Unannotated", theme::lavender())
        };
        let condition = photo
            .capture_condition
            .clone()
            .filter(|condition| !condition.trim().is_empty())
            .unwrap_or_else(|| "No condition".into());
        let caption =
            v_flex()
                .gap(px(3.))
                .child(
                    div()
                        .font_family(theme::MONO_FONT)
                        .text_size(px(12.))
                        .text_color(theme::text_dim())
                        .truncate()
                        .child(photo.relative_path.clone()),
                )
                .child(
                    h_flex()
                        .justify_between()
                        .gap(px(6.))
                        .text_size(px(12.))
                        .child(
                            h_flex()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .child(div().flex_none().text_color(status_color).child(annotation_status))
                                .child(div().flex_none().text_color(theme::text_dim()).child("\u{a0}·\u{a0}"))
                                .child(div().min_w_0().text_color(theme::text_muted()).truncate().child(condition)),
                        )
                        .child(div().flex_none().font_family(theme::MONO_FONT).text_color(theme::text_dim()).child(
                            format!("{} × {}", n0(photo.image_width as usize), n0(photo.image_height as usize)),
                        )),
                )
                .into_any_element();
        let toggle_path = photo.image_path.clone();
        ui::photo_tile(
            ("photo", index),
            thumbnail,
            file_name,
            checked,
            false,
            Some(caption),
            cx.listener(move |page, _, _, cx| page.toggle_selected(&toggle_path, cx)),
        )
        .relative()
        .group("photo-tile")
        .child(
            div()
                .absolute()
                .top(px(8.))
                .right(px(8.))
                .rounded_full()
                .bg(theme::color_alpha(0x0B0610CC))
                .opacity(0.)
                .group_hover("photo-tile", |style| style.opacity(1.))
                .child(ui::icon_button(("view", index), IconName::Maximize2, "View full size").on_click(cx.listener(
                    move |page, _, window, cx| {
                        // Viewing ticks nothing.
                        cx.stop_propagation();
                        page.view(photo.clone(), window, cx);
                    },
                ))),
        )
        .into_any_element()
    }

    fn render_viewer(&self, photo: &CameraPhoto, cx: &mut Context<Self>) -> AnyElement {
        v_flex()
            .id("photo-viewer")
            .absolute()
            .inset_0()
            .bg(theme::background())
            .occlude()
            .track_focus(&self.viewer_focus)
            .on_key_down(cx.listener(|page, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    page.close_viewer(cx);
                    cx.stop_propagation();
                }
            }))
            .child(
                h_flex()
                    .flex_none()
                    .justify_between()
                    .gap(px(12.))
                    .px(px(20.))
                    .py(px(12.))
                    .border_b_1()
                    .border_color(theme::hairline())
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .font_family(theme::MONO_FONT)
                            .text_size(px(13.))
                            .child(photo.relative_path.clone()),
                    )
                    .child(
                        ui::icon_button("close-viewer", IconName::X, "Close")
                            .on_click(cx.listener(|page, _, _, cx| page.close_viewer(cx))),
                    ),
            )
            .child(
                div()
                    .id("photo-viewer-image")
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .m(px(16.))
                    .cursor_pointer()
                    .on_click(cx.listener(|page, _, _, cx| page.close_viewer(cx)))
                    // The photo itself, not its thumbnail.
                    .child(
                        img(photo.image_path.clone()).absolute().inset_0().size_full().object_fit(ObjectFit::Contain),
                    ),
            )
            .into_any_element()
    }

    fn render_filters(&self, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .flex_none()
            .p(px(2.))
            .rounded_full()
            .bg(theme::color_alpha(0x0000004D))
            .border_1()
            .border_color(theme::hairline())
            .children(FILTERS.iter().map(|&filter| {
                let active = filter == self.active_filter;
                div()
                    .id(filter)
                    .flex()
                    .items_center()
                    .h(px(24.))
                    .px(px(12.))
                    .rounded_full()
                    .text_size(px(12.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .cursor_pointer()
                    .map(|el| {
                        if active {
                            el.bg(theme::brand_gradient()).text_color(theme::text())
                        } else {
                            el.text_color(theme::text_muted()).hover(|el| el.text_color(theme::text()))
                        }
                    })
                    .on_click(cx.listener(move |page, _, _, cx| page.set_filter(filter, cx)))
                    .child(filter)
            }))
    }
}

impl Render for PhotoLibraryPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let header_actions = vec![
            ui::icon_button("open-photos-folder", IconName::FolderOpen, "Open photos folder")
                .on_click(cx.listener(|page, _, _, _| page.open_photos_folder()))
                .into_any_element(),
            ui::run_button(
                "refresh-library",
                false,
                IconName::RefreshCw,
                "Refresh library",
                self.busy,
                true,
                cx.listener(|page, _, _, cx| page.refresh(cx)),
                |_, _, _| {},
            ),
        ];

        let info = h_flex()
            .flex_none()
            .gap(px(18.))
            .px(px(16.))
            .py(px(10.))
            .rounded(px(10.))
            .bg(theme::glass())
            .border_1()
            .border_color(theme::hairline())
            .child(self.render_filters(cx))
            .child(
                div()
                    .flex_1()
                    .min_w(px(160.))
                    .child(Input::new(&self.search).small().prefix(ui::icon(IconName::Search).small())),
            )
            .child(
                div()
                    .min_w_0()
                    .max_w(px(340.))
                    .truncate()
                    .text_size(px(12.))
                    .text_color(theme::text_muted())
                    .child(self.status.clone()),
            )
            .child(
                div()
                    .flex_none()
                    .whitespace_nowrap()
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme::lavender())
                    .child(format!("{} matching", n0(self.matching_count))),
            )
            .child(
                Button::new("select-all")
                    .ghost()
                    .small()
                    .label("Select all")
                    .disabled(!self.has_matches())
                    .on_click(cx.listener(|page, _, _, cx| page.select_all_matching(cx))),
            )
            .child(
                Button::new("deselect-all")
                    .ghost()
                    .small()
                    .label("Deselect all")
                    .disabled(!self.has_selection())
                    .on_click(cx.listener(|page, _, _, cx| page.clear_selection(cx))),
            );

        let body = if self.page_items.is_empty() {
            ui::empty_state(
                IconName::Image,
                "No photos match this filter",
                Some("Drop photos or folders here to import them."),
            )
        } else {
            let rows = self.page_items.len().div_ceil(self.columns());
            uniform_list("photo-rows", rows, cx.processor(|page, rows: Range<usize>, _, cx| page.render_rows(rows, cx)))
                .track_scroll(&self.scroll)
                .size_full()
                .into_any_element()
        };
        let page_entity = cx.weak_entity();
        let grid = div()
            .id("photo-grid")
            .group("photo-drop")
            .relative()
            .flex_1()
            .min_h_0()
            // The rows are as wide as this area; it is measured as it is laid out.
            .child(
                canvas(
                    move |bounds, _, cx| {
                        let _ = page_entity.update(cx, |page, cx| {
                            if page.grid_width != bounds.size.width {
                                page.grid_width = bounds.size.width;
                                cx.notify();
                            }
                        });
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .child(body)
            // An empty style still makes the area repaint as a drag enters and leaves it, which shows the hint.
            .drag_over::<ExternalPaths>(|style, _, _, _| style)
            .on_drop(cx.listener(|page, paths: &ExternalPaths, _, cx| page.import_dropped(paths.paths().to_vec(), cx)))
            .when(!self.busy, |el| {
                el.child(
                    v_flex()
                        .absolute()
                        .inset_0()
                        .items_center()
                        .justify_center()
                        .gap(px(10.))
                        .rounded(px(14.))
                        .border_2()
                        .border_dashed()
                        .border_color(theme::violet())
                        .bg(theme::color_alpha(0x0B0610D1))
                        .text_color(theme::lavender())
                        .opacity(0.)
                        .group_drag_over::<ExternalPaths>("photo-drop", |style| style.opacity(1.))
                        .child(ui::icon(IconName::Upload).size(px(32.)))
                        .child(
                            div()
                                .font_weight(FontWeight::BOLD)
                                .text_size(px(18.))
                                .child("Drop photos or folders to import them"),
                        ),
                )
            });

        let selected_count = self.selected.len();
        let has_selection = self.has_selection();
        let delete_button = |id: &'static str, label: &'static str| {
            Button::new(id)
                .danger()
                .small()
                .rounded(px(999.))
                .icon(ui::icon(IconName::Trash))
                .label(label)
                .disabled(!has_selection)
        };
        let footer = h_flex()
            .flex_none()
            .justify_between()
            .gap(px(12.))
            .child(
                h_flex()
                    .gap(px(8.))
                    .when(selected_count == 0, |el| el.invisible())
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme::violet())
                            .child(format!("{} selected", n0(selected_count))),
                    )
                    .child(
                        Button::new("clear-selection")
                            .ghost()
                            .small()
                            .label("Clear")
                            .disabled(!has_selection)
                            .on_click(cx.listener(|page, _, _, cx| page.clear_selection(cx))),
                    )
                    .child(
                        delete_button("delete-annotations", "Delete annotations")
                            .on_click(cx.listener(|page, _, _, cx| page.delete_annotations(cx))),
                    )
                    .child(
                        delete_button("delete-annotations-identities", "Delete annotations + identities")
                            .on_click(cx.listener(|page, _, _, cx| page.delete_annotations_and_identities(cx))),
                    )
                    .child(
                        delete_button("delete-photos", "Delete photos + annotations")
                            .on_click(cx.listener(|page, _, _, cx| page.delete_photos(cx))),
                    ),
            )
            .child(
                Pagination::new("photo-pages")
                    .small()
                    .current_page(self.current_page)
                    .total_pages(self.total_pages)
                    .disabled(self.busy)
                    .on_click(cx.listener(|page, target: &usize, _, cx| page.go_to_page(*target, cx))),
            );

        let viewer = self.viewing.clone().map(|photo| self.render_viewer(&photo, cx));
        ui::page("photo-library", false)
            .relative()
            .child(ui::page_header("Photo Library", DESCRIPTION, None, header_actions))
            .child(info)
            .child(grid)
            .child(footer)
            .children(viewer)
    }
}

/// The first 20 errors, one per line, for a message.
fn first_errors(errors: &[String]) -> String {
    errors.iter().take(20).cloned().collect::<Vec<_>>().join("\n")
}
