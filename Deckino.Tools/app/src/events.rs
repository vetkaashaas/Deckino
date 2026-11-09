//! Confirmations, messages and toasts the pages raise (the C# AppEvents and DesktopService), plus the desktop helpers:
//! pickers, clipboard, folders. The shell shows the dialogs and toasts.

use std::path::{Path, PathBuf};

use futures::channel::oneshot;
use gpui_kit::*;

use crate::ui::Tone;

pub struct Dialog {
    pub id: u64,
    pub title: SharedString,
    pub message: SharedString,
    pub accept: SharedString,
    pub cancel: Option<SharedString>,
    answer: Option<oneshot::Sender<bool>>,
}

impl Dialog {
    /// A stray Enter never confirms a deletion: those open with Cancel focused and the accept button red.
    pub fn destructive(&self) -> bool {
        let accept = self.accept.to_lowercase();
        ["delete", "clear", "close anyway", "overwrite", "discard"].iter().any(|word| accept.contains(word))
    }
}

#[derive(Default)]
pub struct AppEvents {
    pub dialogs: Vec<Dialog>,
    /// Toasts not shown yet; the shell takes them.
    pub toasts: Vec<(SharedString, Tone)>,
    next_id: u64,
}

struct GlobalAppEvents(Entity<AppEvents>);
impl Global for GlobalAppEvents {}

impl AppEvents {
    pub fn init(cx: &mut App) -> Entity<AppEvents> {
        let events = cx.new(|_| AppEvents::default());
        cx.set_global(GlobalAppEvents(events.clone()));
        events
    }

    pub fn global(cx: &App) -> Entity<AppEvents> {
        cx.global::<GlobalAppEvents>().0.clone()
    }

    pub fn answer(&mut self, id: u64, accepted: bool, cx: &mut Context<Self>) {
        if let Some(index) = self.dialogs.iter().position(|dialog| dialog.id == id) {
            let mut dialog = self.dialogs.remove(index);
            if let Some(answer) = dialog.answer.take() {
                let _ = answer.send(accepted);
            }
            cx.notify();
        }
    }
}

/// Asks a question; the answer is false when cancelled. `cancel`: None for a message with only a close button.
pub fn ask(
    cx: &mut App,
    title: impl Into<SharedString>,
    message: impl Into<SharedString>,
    accept: impl Into<SharedString>,
    cancel: Option<&str>,
) -> oneshot::Receiver<bool> {
    let (sender, receiver) = oneshot::channel();
    let (title, message, accept) = (title.into(), message.into(), accept.into());
    let cancel = cancel.map(|text| SharedString::from(text.to_string()));
    AppEvents::global(cx).update(cx, |events, cx| {
        events.next_id += 1;
        let id = events.next_id;
        events.dialogs.push(Dialog { id, title, message, accept, cancel, answer: Some(sender) });
        cx.notify();
    });
    receiver
}

/// ShowMessageAsync.
pub fn message(
    cx: &mut App,
    title: impl Into<SharedString>,
    message: impl Into<SharedString>,
) -> oneshot::Receiver<bool> {
    ask(cx, title, message, "Close", None)
}

pub fn toast(cx: &mut App, message: impl Into<SharedString>, tone: Tone) {
    let message = message.into();
    AppEvents::global(cx).update(cx, |events, cx| {
        events.toasts.push((message, tone));
        cx.notify();
    });
}

/// A command that failed: logged, and shown as the C# bridge did ("Something went wrong: …"). Cancellation is quiet.
pub fn report_error(
    cx: &mut App,
    log: &deckino_core::log::ApplicationLogService,
    command: &str,
    error: &anyhow::Error,
) {
    if deckino_core::error::is_cancelled(error) {
        return;
    }
    log.error("ui", &format!("{command} failed."), Some(error));
    toast(cx, format!("Something went wrong: {error:#}"), Tone::Danger);
}

pub fn copy_text(cx: &mut App, text: impl Into<String>) {
    cx.write_to_clipboard(ClipboardItem::new_string(text.into()));
    toast(cx, "Copied to clipboard", Tone::Neutral);
}

/// Opens a folder in Explorer, creating it first.
pub fn open_folder(path: &Path) {
    let _ = std::fs::create_dir_all(path);
    let _ = std::process::Command::new("explorer").arg(path).spawn();
}

/// Windows' own file dialog. `extensions` like ".zip".
pub async fn pick_file(title: &str, extensions: &[&str]) -> Option<PathBuf> {
    let patterns: Vec<&str> = extensions.iter().map(|extension| extension.trim_start_matches('.')).collect();
    rfd::AsyncFileDialog::new()
        .set_title(title)
        .add_filter(extensions.join(", "), &patterns)
        .add_filter("All files", &["*"])
        .pick_file()
        .await
        .map(|file| file.path().to_path_buf())
}

pub async fn pick_folder(title: &str) -> Option<PathBuf> {
    let mut dialog = rfd::AsyncFileDialog::new().set_title(title);
    if let Some(pictures) = std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join("Pictures")) {
        dialog = dialog.set_directory(pictures);
    }
    dialog.pick_folder().await.map(|folder| folder.path().to_path_buf())
}
