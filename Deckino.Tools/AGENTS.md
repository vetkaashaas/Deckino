# Deckino.Tools

The Toolbox, in Rust with GPUI (via `gpui-kit`). It replaced the C# Toolbox (`Deckino.Toolbox`: WinForms + WebView2 +
React, removed from the repo; see git history) and keeps its data formats, bucket layout and update feed, so the C#
installs updated into it.

- `core/` (`deckino_core`): the services, no UI. One module per C# file in `Deckino.Toolbox/Services`.
- `app/` (`deckino-tools` exe): the window, pages and their state (the old view models), drawn with GPUI.
- `training/`: the Python training package. A repository build reads it there, a published build ships it beside
  the exe (`TrainingPaths::bundled_project_root`).
- Dropped on purpose: the Video Import page and everything ffmpeg. Photos it imported earlier are still ordinary
  camera photos on disk and must keep loading.

Build: `cargo build` here (Rust stable ≥ 1.99). `cargo check -p deckino-core` checks the services without GPUI.

## Porting conventions

- **Names.** Types keep their C# names (`CameraAnnotationStore`). Methods and fields are snake_case without the
  `Async` suffix (`LoadThumbnail` → `load_thumbnail`, `SyncNowAsync` → `sync_now`). Constants SCREAMING_CASE.
  Following this mechanically is what lets modules ported in parallel find each other.
- **Interfaces with one implementation are gone**: use the concrete type. `ICameraDatasetSyncService` /
  `ICameraDatasetChangeTracker` → `CameraDatasetSyncService`; `ISyncCredentialStore` → `DpapiSyncCredentialStore`;
  `IRemoteObjectStore(Factory)` → `RailwayS3ObjectStore::new(&credentials)`; `IExtractionCornerSuggestionService`
  → `ExtractionCornerSuggestionService`.
- **Sharing.** Services are `Send + Sync`, held as `Arc<Service>`, built by `new(...)` taking their dependencies in the
  C# constructor's order. Mutable state behind `std::sync::Mutex` (never held across `.await`) or a tokio lock.
- **Async.** tokio. C# `Task` methods become `async fn`; CPU or blocking file work inside them may stay plain
  (or `tokio::task::spawn_blocking` when it is long). `CancellationToken` → `tokio_util::sync::CancellationToken`,
  passed as `cancel: &CancellationToken`. `OperationCanceledException` → `deckino_core::error::Cancelled`
  (`check(cancel)?`, `is_cancelled(&err)`).
- **Errors.** `anyhow::Result`. Keep the C# messages word for word: people read them. A C# `catch (X) when` that
  swallows specific failures stays a targeted match; don't widen it to everything without reason.
- **Callbacks.** `Action<T>` / `IProgress<T>` → `&(dyn Fn(T) + Send + Sync)` (or `Arc<dyn Fn…>` when stored).
  `event EventHandler StateChanged` → a `tokio::sync::watch::Sender<u64>` bumped on change, exposed as
  `pub fn subscribe(&self) -> watch::Receiver<u64>`.
- **Files on disk are a contract.** JSON, JSONL, sidecars and the SQLite schema must round-trip with the C# Toolbox.
  System.Text.Json writes **PascalCase** property names unless the C# sets a naming policy or `[JsonPropertyName]`;
  enums are **numbers** unless a `JsonStringEnumConverter` is used; nulls are written unless ignored. Read every
  `JsonSerializerOptions` in the file you port and mirror it with serde attributes. `DateTimeOffset` →
  `chrono::DateTime<Utc>` (RFC 3339 reads C#'s `+00:00`). Hex hashes: match the C# case (`Convert.ToHexString` is
  UPPERCASE; `.ToLowerInvariant()` after it is lowercase).
- **SQL** always takes parameters (repo rule, `../AGENTS.md`).
- **Images.** The `image` crate. Like System.Drawing it ignores EXIF orientation: photos are used as stored. Keep the
  C# JPEG qualities and resize filters as close as the crate allows.
- **Paths.** `PathBuf`/`&Path`. `TrainingPaths` (`core/src/paths.rs`) mirrors the C# one field for field.
- Keep the C# comments that explain *why*; drop the ones that only restate code. No new abstractions, no tests
  unless asked (repo rule: E2E over unit tests).

## App conventions (GPUI pages)

The C# view model and its React page become one module, `app/src/pages/<page>.rs`, exposing
`pub fn entry(services: Arc<Services>, window: &mut Window, cx: &mut App) -> PageEntry` (see `shell.rs`). The page
is a GPUI entity (`struct XPage` + `impl Render`) holding the view model's state as plain fields; commands are
methods; `cx.notify()` after a change replaces `[ObservableProperty]`. What CanExecute decided becomes `.disabled(…)`.

- **Building blocks** (use them, keep the React layout): `ui.rs` (page, page_header, section, stats/stat_tile,
  status_pill, run_button, primary/secondary/icon buttons, error_alert, stage_list/step_list + `Stage`, `LogView`,
  empty_state, image_well, photo_tile, Tone/status_tone), `theme.rs` (tokens), `images.rs` (in-memory images),
  `events.rs` (dialogs, toasts, clipboard, folders, pickers, `report_error`). gpui-component widgets are under
  `gpui_kit::component::*` (button, checkbox, switch, progress, input, select, tooltip, …); its sources are in
  `~/.cargo/registry/src/index.crates.io-*/gpui-component-0.9.0` and `gpui-base-0.9.0`, GPUI in `gpui-pre-0.3.11`.
  Icons: `ui::IconName::<Lucide name>` (every Lucide icon is bundled). Add `use gpui_kit::prelude::FluentBuilder as _;`
  for `.when`/`.map`.
- **Service work runs on tokio, the page on GPUI.** Start it with `rt::spawn(async move { … })` and await that from
  `cx.spawn(async move |this, cx| { … this.update(cx, |page, cx| { …; cx.notify() }) })`. Progress: `rt::channel()`;
  the service callback sends, the GPUI task drains the receiver, then awaits the result. `updates.rs` is the
  worked example. Never block the UI thread on a service; blocking service calls go inside `rt::spawn` (or
  `tokio::task::spawn_blocking` within it).
- **Cancel** = a `CancellationToken` field the Cancel button cancels.
- **Failures**: a command's error goes to `events::report_error(cx, &services.log, "page.command", &err)` (logged +
  toast, silent when cancelled) unless the C# view model handled it itself (an error banner, a status line): then
  port that handling as it was.
- **Dialogs**: `events::ask/message(cx, …)` return a oneshot receiver; await it inside `cx.spawn`
  (`answer.await.unwrap_or(false)`). Pickers: `events::pick_file/pick_folder(...).await` inside `cx.spawn`.
- **Text fields**: `cx.new(|cx| InputState::new(window, cx).default_value(..))` +
  `cx.subscribe_in(&state, window, |page, state, event: &InputEvent, window, cx| …)`, drawn with
  `gpui_kit::component::input::Input::new(&state)`.
- **Images**: `img(path)` for a photo shown full size; `images::from_rgba/from_rgb` for crops/previews the services
  return; `images::from_jpeg(store.load_thumbnail(..))` for thumbnails, loaded off the UI thread and kept in the
  page (bounded), since a grid of full-size photos would decode megapixels per tile. Lists of many items use
  `uniform_list` (see `LogView`).
- **Opened / left**: `PageEntry.opened` runs when the page is shown (the C# `IRefreshableWorkspace.RefreshAsync`),
  `left` when another page is opened.
- **Text** shown to people keeps the C# wording. Numbers: C#'s `N0` has comma thousands separators.
