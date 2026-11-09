#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod events;
mod images;
mod pages;
mod rt;
mod shell;
mod theme;
mod ui;
mod updates;

use std::borrow::Cow;
use std::sync::Arc;
use std::time::Duration;

use deckino_core::services::Services;
use gpui_kit::*;

use crate::events::AppEvents;
use crate::shell::{Shell, UpdateStatus};

/// The logos, then every Lucide icon (a desktop tool can spare the megabyte).
struct AppAssets;

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(Some(Cow::Borrowed(match path {
            "deckino/logo-original.svg" => include_bytes!("../assets/logo-original.svg"),
            "deckino/icon-white.svg" => include_bytes!("../assets/icon-white.svg"),
            _ => return gpui_kit::assets::AllAssets.load(path),
        })))
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        gpui_kit::assets::AllAssets.list(path)
    }
}

/// Velopack first (it may install an update and exit), then either a headless command or the window.
fn main() {
    velopack::VelopackApp::build().run();
    let args: Vec<String> = std::env::args().skip(1).collect();
    // The services start inside tokio: the dataset sync keeps a handle to it for its background work.
    let _tokio = rt::runtime().enter();
    let services = match Services::new() {
        Ok(services) => Arc::new(services),
        Err(error) => {
            rfd::MessageDialog::new()
                .set_title("Deckino Toolbox")
                .set_description(format!("The Toolbox could not open its data: {error:#}"))
                .set_level(rfd::MessageLevel::Error)
                .show();
            std::process::exit(1);
        }
    };
    log_crashes(&services);
    if deckino_core::headless::is_headless(&args) {
        let code = rt::runtime().block_on(async {
            let code = deckino_core::headless::run(&services, &args).await;
            services.shutdown().await;
            code
        });
        std::process::exit(code);
    }
    services.camera_dataset_sync.start();
    services.log.information(
        "startup",
        &format!(
            "Deckino Toolbox starting. PID={}; base={}",
            std::process::id(),
            deckino_core::paths::base_directory().display()
        ),
    );

    gpui_kit::application().with_assets(AppAssets).run(move |cx| {
        gpui_kit::init(cx);
        cx.text_system()
            // Static weights: GPUI draws a variable font at its default weight only.
            .add_fonts(vec![
                Cow::Borrowed(include_bytes!("../assets/fonts/Lexend-400.ttf")),
                Cow::Borrowed(include_bytes!("../assets/fonts/Lexend-500.ttf")),
                Cow::Borrowed(include_bytes!("../assets/fonts/Lexend-600.ttf")),
                Cow::Borrowed(include_bytes!("../assets/fonts/Lexend-700.ttf")),
                Cow::Borrowed(include_bytes!("../assets/fonts/BricolageGrotesque-800.ttf")),
            ])
            .expect("fonts");
        theme::apply(cx);
        AppEvents::init(cx);

        let bounds = Bounds::centered(None, size(px(1600.), px(940.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(900.), px(640.))),
            // "(Rust)" tells it apart from the C# Toolbox it replaced, which looks the same.
            titlebar: Some(TitlebarOptions { title: Some("Deckino Toolbox (Rust)".into()), ..Default::default() }),
            ..Default::default()
        };
        let update = cx.new(|_| UpdateStatus::default());
        let page_services = services.clone();
        let page_update = update.clone();
        let (window, _) = gpui_kit::open_window(options, cx, move |window, cx| {
            let pages = pages::build(page_services, window, cx);
            cx.new(|cx| Shell::new(pages, page_update, window, cx))
        })
        .expect("window");
        updates::Updates::start(services.clone(), update, cx);
        let _ = window.update(cx, |_, window, cx| guard_close(services.clone(), window, cx));
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.activate(true);
    });
}

/// The question closing asks while dataset uploads wait (or a sync runs): this PC is not safe to switch from yet.
/// None when it may close at once. The window's close button and the update's restart both ask it.
pub(crate) fn ask_before_closing(
    services: &Services,
    cx: &mut App,
) -> Option<futures::channel::oneshot::Receiver<bool>> {
    let snapshot = services.camera_dataset_sync.get_snapshot().ok()?;
    if !snapshot.is_configured || snapshot.safe_to_switch() {
        return None;
    }
    let (title, message) = if snapshot.is_running {
        (
            "Dataset sync is still running",
            "Deckino is currently reading or comparing the dataset. Closing now cancels this sync pass. \
             Local files are preserved, and synchronization can be run again next launch. Close anyway?"
                .to_string(),
        )
    } else {
        (
            "Dataset uploads are not finished",
            format!(
                "Deckino still has {} pending, {} failed, and {} conflicting dataset operations.\n\n\
                 The queue will resume next launch, but this computer is not safe to switch from. Close anyway?",
                deckino_core::n0(snapshot.pending_uploads),
                deckino_core::n0(snapshot.failed_operations),
                deckino_core::n0(snapshot.conflict_count)
            ),
        )
    };
    Some(events::ask(cx, title, message, "Close anyway", Some("Cancel")))
}

/// Closing asks first while this PC is not safe to switch from (`ask_before_closing`). Once it may close, the Python
/// helpers and the dataset sync stop before the window goes.
fn guard_close(services: Arc<Services>, window: &mut Window, cx: &mut App) {
    let confirmed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    // The question is not modal to the title bar: a second close click while it is open must not queue another.
    let asking = Arc::new(std::sync::atomic::AtomicBool::new(false));
    window.on_window_should_close(cx, move |window, cx| {
        let confirmed_now = confirmed.load(std::sync::atomic::Ordering::SeqCst);
        if !confirmed_now {
            if asking.load(std::sync::atomic::Ordering::SeqCst) {
                return false;
            }
            if let Some(answer) = ask_before_closing(&services, cx) {
                asking.store(true, std::sync::atomic::Ordering::SeqCst);
                let (confirmed, asking) = (confirmed.clone(), asking.clone());
                let services = services.clone();
                let handle = window.window_handle();
                cx.spawn(async move |cx| {
                    let accepted = answer.await.unwrap_or(false);
                    asking.store(false, std::sync::atomic::Ordering::SeqCst);
                    if accepted {
                        confirmed.store(true, std::sync::atomic::Ordering::SeqCst);
                        // remove_window skips this handler, so the services stop here.
                        let _ = handle.update(cx, |_, window, _| {
                            stop_services(&services);
                            window.remove_window()
                        });
                    }
                })
                .detach();
                return false;
            }
        }
        stop_services(&services);
        true
    });
}

/// The services stop while the window still exists: the Python helpers must not outlive it (an update waits for them
/// to let go of the install folder). `window.remove_window()` doesn't run the close handler, so whoever removes the
/// window calls this first.
pub(crate) fn stop_services(services: &Services) {
    let stopped = rt::runtime().block_on(tokio::time::timeout(Duration::from_secs(15), services.shutdown()));
    if stopped.is_err() {
        services.log.error("lifecycle", "Stopping the Toolbox's services timed out.", None);
    }
    services.log.information("lifecycle", "Deckino Toolbox window closed.");
}

/// A panic anywhere is logged, and one on the UI thread is shown rather than lost.
fn log_crashes(services: &Arc<Services>) {
    let log = services.log.clone();
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log.error("panic", &format!("{info}\r\n{}", std::backtrace::Backtrace::force_capture()), None);
        default(info);
    }));
}
