//! Dataset Sync (DatasetSyncViewModel + DatasetSync.tsx): the private Railway bucket's connection, a manual sync,
//! and the conflicts it found.

use deckino_core::n0;
use std::rc::Rc;
use std::sync::Arc;

use deckino_core::camera_dataset_sync::{DatasetSyncConflict, DatasetSyncSnapshot};
use deckino_core::credentials::DatasetSyncCredentials;
use deckino_core::services::Services;
use gpui_kit::component::button::Button;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable, Sizable, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use tokio_util::sync::CancellationToken;

use crate::shell::PageEntry;
use crate::ui::{self, IconName, Tone};
use crate::{events, rt, theme};

const DESCRIPTION: &str =
    "Keep camera photos and corner annotations local while replicating them to a private Railway bucket.";

pub fn entry(services: Arc<Services>, window: &mut Window, cx: &mut App) -> PageEntry {
    let view = cx.new(|cx| DatasetSyncPage::new(services, window, cx));
    let opened = view.clone();
    PageEntry {
        key: "datasetSync",
        name: "Dataset Sync".into(),
        icon: IconName::RefreshCw,
        view: view.into(),
        opened: Some(Rc::new(move |_, cx| opened.update(cx, |page, cx| page.apply_snapshot(cx)))),
        left: None,
    }
}

struct DatasetSyncPage {
    services: Arc<Services>,
    endpoint: Entity<InputState>,
    bucket: Entity<InputState>,
    region: Entity<InputState>,
    access_key_id: Entity<InputState>,
    /// The field; what was typed in it last stays in `unsaved_secret` until verified and stored.
    secret_access_key: Entity<InputState>,
    // Write-only: never filled from the stored credentials. Cleared once verified and stored.
    unsaved_secret: String,
    force_path_style: bool,
    conflicts: Vec<DatasetSyncConflict>,
    selected_conflict: Option<String>,
    status: String,
    last_sync_label: String,
    local_files: usize,
    remote_files: usize,
    pending_uploads: usize,
    failed_operations: usize,
    is_configured: bool,
    busy: bool,
    is_sync_running: bool,
    safe_to_switch: bool,
    // Snapshots load off the UI thread; one that finishes after a newer one is dropped.
    snapshot_requests: u64,
    snapshot_shown: u64,
    _follow: Task<()>,
    _subscriptions: Vec<Subscription>,
}

fn text_input(value: &str, window: &mut Window, cx: &mut Context<DatasetSyncPage>) -> Entity<InputState> {
    let value = value.to_string();
    cx.new(|cx| InputState::new(window, cx).default_value(value))
}

impl DatasetSyncPage {
    fn new(services: Arc<Services>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let stored = services.camera_dataset_sync.load_credentials();
        let stored_or = |value: fn(&DatasetSyncCredentials) -> &str, default: &'static str| {
            stored.as_ref().map(value).unwrap_or(default).to_string()
        };
        let endpoint = text_input(&stored_or(|c| &c.endpoint, "https://storage.railway.app"), window, cx);
        let bucket = text_input(&stored_or(|c| &c.bucket, ""), window, cx);
        let region = text_input(&stored_or(|c| &c.region, "auto"), window, cx);
        let access_key_id = text_input(&stored_or(|c| &c.access_key_id, ""), window, cx);
        let secret_access_key = cx.new(|cx| InputState::new(window, cx).masked(true));
        let subscriptions = vec![cx.subscribe_in(&access_key_id, window, |page, _, event: &InputEvent, window, cx| {
            if matches!(event, InputEvent::Change) {
                page.update_secret_placeholder(window, cx);
            }
        })];

        // StateChanged: the service bumps the channel; the page reloads its snapshot.
        let mut changes = services.camera_dataset_sync.subscribe();
        let follow = cx.spawn(async move |this, cx| {
            while changes.changed().await.is_ok() {
                if this.update(cx, |page, cx| page.apply_snapshot(cx)).is_err() {
                    break;
                }
            }
        });

        let mut page = Self {
            services,
            endpoint,
            bucket,
            region,
            access_key_id,
            secret_access_key,
            unsaved_secret: String::new(),
            force_path_style: stored.as_ref().is_some_and(|c| c.force_path_style),
            conflicts: Vec::new(),
            selected_conflict: None,
            status: "Dataset sync is not configured.".into(),
            last_sync_label: "Never".into(),
            local_files: 0,
            remote_files: 0,
            pending_uploads: 0,
            failed_operations: 0,
            is_configured: false,
            busy: false,
            is_sync_running: false,
            safe_to_switch: false,
            snapshot_requests: 0,
            snapshot_shown: 0,
            _follow: follow,
            _subscriptions: subscriptions,
        };
        page.update_secret_placeholder(window, cx);
        page.apply_snapshot(cx);
        page
    }

    fn update_secret_placeholder(&self, window: &mut Window, cx: &mut Context<Self>) {
        let placeholder = if !self.unsaved_secret.is_empty() {
            "Typed, not saved yet · type to replace"
        } else if !self.access_key_id.read(cx).value().is_empty() {
            "Saved · type to replace"
        } else {
            ""
        };
        self.secret_access_key.update(cx, |input, cx| input.set_placeholder(placeholder, window, cx));
    }

    fn apply_snapshot(&mut self, cx: &mut Context<Self>) {
        self.snapshot_requests += 1;
        let request = self.snapshot_requests;
        // Whether a command was running when this was asked for decides if its status line stays.
        let busy = self.busy;
        let services = self.services.clone();
        cx.spawn(async move |this, cx| {
            let loaded = rt::spawn(async move {
                let sync = &services.camera_dataset_sync;
                anyhow::Ok((sync.get_snapshot()?, sync.get_conflicts()?))
            })
            .await;
            let _ = this.update(cx, |page, cx| {
                if request > page.snapshot_shown {
                    page.snapshot_shown = request;
                    page.show_snapshot(loaded, busy, cx);
                }
            });
        })
        .detach();
    }

    fn show_snapshot(
        &mut self,
        loaded: anyhow::Result<(DatasetSyncSnapshot, Vec<DatasetSyncConflict>)>,
        busy: bool,
        cx: &mut Context<Self>,
    ) {
        let (snapshot, conflicts) = match loaded {
            Ok(loaded) => loaded,
            Err(error) => {
                events::report_error(cx, &self.services.log, "datasetSync.refresh", &error);
                return;
            }
        };
        self.is_configured = snapshot.is_configured;
        self.is_sync_running = snapshot.is_running;
        if !busy || snapshot.is_running {
            self.status = snapshot.status.clone();
        }
        self.local_files = snapshot.local_files;
        self.remote_files = snapshot.remote_files;
        self.pending_uploads = snapshot.pending_uploads;
        self.failed_operations = snapshot.failed_operations;
        self.safe_to_switch = snapshot.safe_to_switch();
        self.last_sync_label = snapshot
            .last_successful_sync_utc
            .map(|utc| local_time_label(utc.timestamp()))
            .unwrap_or_else(|| "Never".into());
        self.conflicts = conflicts;
        let selected_exists = self
            .selected_conflict
            .as_ref()
            .is_some_and(|key| self.conflicts.iter().any(|conflict| &conflict.object_key == key));
        if !selected_exists {
            self.selected_conflict = self.conflicts.first().map(|conflict| conflict.object_key.clone());
        }
        cx.notify();
    }

    fn build_credentials(&self, cx: &App) -> anyhow::Result<DatasetSyncCredentials> {
        let stored = self.services.camera_dataset_sync.load_credentials();
        let secret = if self.unsaved_secret.is_empty() {
            stored.map(|credentials| credentials.secret_access_key).unwrap_or_default()
        } else {
            self.unsaved_secret.clone()
        };
        let value = |input: &Entity<InputState>| input.read(cx).value().trim().to_string();
        let credentials = DatasetSyncCredentials {
            endpoint: value(&self.endpoint),
            bucket: value(&self.bucket),
            region: value(&self.region),
            force_path_style: self.force_path_style,
            access_key_id: value(&self.access_key_id),
            secret_access_key: secret,
        };
        if !credentials.is_complete() {
            anyhow::bail!("Endpoint, bucket, region, access key, and secret key are required.");
        }
        Ok(credentials)
    }

    /// An error's message without the bucket's keys: the stored ones, and any typed but not saved yet.
    fn safe_message(&self, error: &anyhow::Error, cx: &App) -> String {
        let mut message = format!("{error:#}");
        message = replace_ignore_case(&message, "SecretAccessKey", "credential");
        message = replace_ignore_case(&message, "AccessKey", "credential");
        let stored = self.services.camera_dataset_sync.load_credentials();
        let typed_access_key = self.access_key_id.read(cx).value().to_string();
        let secrets = [
            Some(self.unsaved_secret.clone()),
            Some(typed_access_key),
            stored.as_ref().map(|c| c.secret_access_key.clone()),
            stored.as_ref().map(|c| c.access_key_id.clone()),
        ];
        for secret in secrets.into_iter().flatten().filter(|secret| !secret.is_empty()) {
            message = message.replace(&secret, "[redacted]");
        }
        message
    }

    fn can_sync(&self) -> bool {
        !self.busy && self.is_configured
    }

    fn can_resolve_conflict(&self) -> bool {
        !self.busy && self.selected_conflict.is_some()
    }

    fn save_connection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let typed = self.secret_access_key.read(cx).value().to_string();
        if !typed.is_empty() {
            self.unsaved_secret = typed;
        }
        self.busy = true;
        self.status = "Testing the private Railway bucket connection…".into();
        self.update_secret_placeholder(window, cx);
        cx.notify();
        let credentials = self.build_credentials(cx);
        let services = self.services.clone();
        cx.spawn_in(window, async move |this, cx| {
            let result = match credentials {
                Ok(credentials) => {
                    rt::spawn(async move {
                        let sync = &services.camera_dataset_sync;
                        sync.test_connection(&credentials, &CancellationToken::new()).await?;
                        sync.save_credentials(credentials)
                    })
                    .await
                }
                Err(error) => Err(error),
            };
            let _ = this.update_in(cx, |page, window, cx| {
                match result {
                    Ok(()) => {
                        page.unsaved_secret.clear();
                        page.secret_access_key.update(cx, |input, cx| input.set_value("", window, cx));
                        page.status = "Connection verified and stored securely for this Windows user.".into();
                        page.apply_snapshot(cx);
                    }
                    Err(error) => page.status = format!("Connection failed: {}", page.safe_message(&error, cx)),
                }
                page.busy = false;
                page.update_secret_placeholder(window, cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn sync_now(&mut self, cx: &mut Context<Self>) {
        if !self.can_sync() {
            return;
        }
        self.busy = true;
        cx.notify();
        let services = self.services.clone();
        cx.spawn(async move |this, cx| {
            let result = rt::spawn(async move {
                let _operation = services.coordinator.acquire("synchronize the camera dataset")?;
                services.camera_dataset_sync.sync_now(&CancellationToken::new()).await
            })
            .await;
            let _ = this.update(cx, |page, cx| {
                page.status = match result {
                    Ok(result) if !result.errors.is_empty() => {
                        format!("Sync finished with {} errors.", n0(result.errors.len()))
                    }
                    Ok(result) => format!(
                        "Sync complete: {} uploaded, {} downloaded, {} deleted, {} conflicts.",
                        n0(result.uploaded),
                        n0(result.downloaded),
                        n0(result.deleted),
                        n0(result.conflicts)
                    ),
                    Err(error) => format!("Sync failed: {}", page.safe_message(&error, cx)),
                };
                page.busy = false;
                page.apply_snapshot(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn resolve_conflict(&mut self, keep_local: bool, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Some(object_key) = self.selected_conflict.clone() else {
            return;
        };
        self.busy = true;
        cx.notify();
        let services = self.services.clone();
        cx.spawn(async move |this, cx| {
            let result = rt::spawn(async move {
                let _operation = services.coordinator.acquire("resolve a dataset conflict")?;
                let sync = &services.camera_dataset_sync;
                let cancel = CancellationToken::new();
                if keep_local {
                    sync.keep_local(&object_key, &cancel).await
                } else {
                    sync.keep_remote(&object_key, &cancel).await
                }
            })
            .await;
            let _ = this.update(cx, |page, cx| {
                page.status = match result {
                    Ok(()) => "Conflict resolved.".into(),
                    Err(error) => format!("Could not resolve the conflict: {}", page.safe_message(&error, cx)),
                };
                page.busy = false;
                page.apply_snapshot(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn render_connection(&self, cx: &mut Context<Self>) -> Div {
        ui::section(
            Some("Railway bucket connection"),
            Some("Credentials stay encrypted for the current Windows user. Downloads run only on demand."),
            vec![],
        )
        .child(
            v_flex()
                .gap(px(12.))
                .child(
                    h_flex()
                        .gap(px(12.))
                        .child(field("Endpoint", Input::new(&self.endpoint)))
                        .child(field("Bucket", Input::new(&self.bucket))),
                )
                .child(
                    h_flex().gap(px(12.)).items_end().child(field("Region", Input::new(&self.region))).child(
                        div().flex_1().min_w_0().mb(px(8.)).child(
                            Switch::new("force-path-style")
                                .label("Use path-style URLs")
                                .checked(self.force_path_style)
                                .on_click(cx.listener(|page, checked: &bool, _, cx| {
                                    page.force_path_style = *checked;
                                    cx.notify();
                                })),
                        ),
                    ),
                )
                .child(
                    h_flex()
                        .gap(px(12.))
                        .child(field("Access key ID", Input::new(&self.access_key_id)))
                        .child(field("Secret access key", Input::new(&self.secret_access_key).mask_toggle())),
                ),
        )
        .child(
            h_flex().mt(px(16.)).child(
                ui::secondary_button("save-connection", "Verify and save connection", Some(IconName::PlugZap))
                    .disabled(self.busy)
                    .on_click(cx.listener(|page, _, window, cx| page.save_connection(window, cx))),
            ),
        )
    }

    fn render_conflicts(&self, cx: &mut Context<Self>) -> Div {
        let can_resolve = self.can_resolve_conflict();
        let actions = vec![
            Button::new("keep-remote")
                .small()
                .rounded(px(999.))
                .label("Keep remote")
                .disabled(!can_resolve)
                .on_click(cx.listener(|page, _, _, cx| page.resolve_conflict(false, cx)))
                .into_any_element(),
            Button::new("keep-local")
                .small()
                .rounded(px(999.))
                .label("Keep local")
                .disabled(!can_resolve)
                .on_click(cx.listener(|page, _, _, cx| page.resolve_conflict(true, cx)))
                .into_any_element(),
        ];
        let section = ui::section(
            Some("Conflicts"),
            Some("Different local and remote content is never overwritten silently."),
            actions,
        );
        if self.conflicts.is_empty() {
            return section.child(ui::empty_state(
                IconName::Image,
                "No conflicts",
                Some("Local and remote copies agree."),
            ));
        }
        section.child(v_flex().id("conflicts").max_h(px(320.)).overflow_y_scroll().gap(px(4.)).children(
            self.conflicts.iter().enumerate().map(|(index, conflict)| {
                let selected = self.selected_conflict.as_deref() == Some(conflict.object_key.as_str());
                let key = conflict.object_key.clone();
                v_flex()
                    .id(("conflict", index))
                    .py(px(10.))
                    .px(px(12.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(if selected { theme::violet() } else { theme::color_alpha(0x00000000) })
                    .cursor_pointer()
                    .when(selected, |el| el.bg(theme::tint_strong()))
                    .when(!selected, |el| el.hover(|el| el.bg(theme::color_alpha(0xFFFFFF0A))))
                    .on_click(cx.listener(move |page, _, _, cx| {
                        page.selected_conflict = Some(key.clone());
                        cx.notify();
                    }))
                    .child(
                        h_flex()
                            .justify_between()
                            .gap(px(12.))
                            .child(
                                div()
                                    .min_w_0()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .truncate()
                                    .child(conflict.relative_path.clone()),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .font_family(theme::MONO_FONT)
                                    .text_size(px(12.))
                                    .text_color(theme::text_muted())
                                    .child(conflict.created_utc.format("%Y-%m-%d %H:%M").to_string()),
                            ),
                    )
                    .child(
                        div()
                            .font_family(theme::MONO_FONT)
                            .text_size(px(12.))
                            .text_color(theme::text_dim())
                            .truncate()
                            .child(conflict.object_key.clone()),
                    )
            }),
        ))
    }
}

impl Render for DatasetSyncPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (tone, safety_label) = if self.is_sync_running {
            (Tone::Accent, "SYNC IN PROGRESS")
        } else if self.safe_to_switch {
            (Tone::Success, "SAFE TO SWITCH COMPUTERS")
        } else {
            (Tone::Warning, "WAIT BEFORE SWITCHING")
        };
        let sync_button = ui::run_button(
            "sync-now",
            false,
            IconName::RefreshCw,
            "Sync now",
            !self.can_sync(),
            true,
            cx.listener(|page, _, _, cx| page.sync_now(cx)),
            |_, _, _| {},
        );
        ui::page("dataset-sync", true)
            .child(ui::page_header(
                "Dataset Sync",
                DESCRIPTION,
                Some(ui::status_pill(tone, safety_label)),
                vec![sync_button],
            ))
            .child(
                ui::section(None, None, vec![])
                    .child(ui::stats(vec![
                        ui::stat_tile("Local files", n0(self.local_files), None),
                        ui::stat_tile("Remote files", n0(self.remote_files), None),
                        ui::stat_tile("Pending uploads", n0(self.pending_uploads), None),
                        ui::stat_tile("Failed operations", n0(self.failed_operations), None),
                    ]))
                    .child(
                        h_flex()
                            .mt(px(12.))
                            .gap(px(8.))
                            .flex_wrap()
                            .justify_between()
                            .child(ui::muted(self.status.clone()))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .text_color(theme::text_dim())
                                    .child(format!("Last successful sync {}", self.last_sync_label)),
                            ),
                    ),
            )
            .child(
                h_flex()
                    .flex_wrap()
                    .items_start()
                    .gap(px(16.))
                    .child(self.render_connection(cx).flex_1().min_w(px(440.)))
                    .child(self.render_conflicts(cx).flex_1().min_w(px(440.))),
            )
    }
}

/// A labelled text field (the React BoundTextInput's label).
fn field(label: &'static str, input: Input) -> Div {
    v_flex()
        .flex_1()
        .min_w_0()
        .gap(px(4.))
        .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).child(label))
        .child(input)
}

/// String.Replace with OrdinalIgnoreCase for an ASCII `from`.
pub(super) fn replace_ignore_case(text: &str, from: &str, to: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let needle = from.to_ascii_lowercase();
    let mut result = String::with_capacity(text.len());
    let mut last = 0;
    for (index, _) in lower.match_indices(&needle) {
        result.push_str(&text[last..index]);
        result.push_str(to);
        last = index + needle.len();
    }
    result.push_str(&text[last..]);
    result
}

/// `ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss")`.
fn local_time_label(unix_seconds: i64) -> String {
    chrono::DateTime::from_timestamp(unix_seconds, 0)
        .map(|time| time.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_default()
}
