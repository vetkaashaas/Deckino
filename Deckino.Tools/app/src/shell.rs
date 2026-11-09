//! The window's content: the sidebar of pages, the open page, and the dialogs the pages raise.

use std::rc::Rc;

use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::notification::Notification;
use gpui_kit::component::{Disableable, WindowExt, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::events::AppEvents;
use crate::theme;
use crate::ui::{self, IconName, Tone};

pub struct PageEntry {
    pub key: &'static str,
    pub name: SharedString,
    pub icon: IconName,
    pub view: AnyView,
    /// Runs when the page is opened (a refresh).
    pub opened: Option<Rc<dyn Fn(&mut Window, &mut App)>>,
    /// Runs when another page is opened instead (Identify Card unloads its model).
    pub left: Option<Rc<dyn Fn(&mut App)>>,
}

const GROUPS: &[(&str, &[&str])] = &[
    ("Data", &["sync", "datasetSync", "modelSync"]),
    ("Capture", &["annotator", "cardIdentification", "photoLibrary"]),
    ("Models", &["extractionTraining", "runner"]),
];

/// The sidebar's footer: the version, or what the update button waits for (set by the update check in main.rs).
#[derive(Default)]
pub struct UpdateStatus {
    pub version_status: SharedString,
    /// The update button's label; None hides it.
    pub button_text: Option<SharedString>,
    pub button_enabled: bool,
    pub on_click: Option<Rc<dyn Fn(&mut Window, &mut App)>>,
}

pub struct Shell {
    pages: Vec<PageEntry>,
    current: usize,
    pub update: Entity<UpdateStatus>,
    events: Entity<AppEvents>,
    dialog_focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl Shell {
    pub fn new(
        pages: Vec<PageEntry>,
        update: Entity<UpdateStatus>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let events = AppEvents::global(cx);
        let subscriptions = vec![
            // Toasts go to the component library's notification list; dialogs are drawn here.
            cx.observe_in(&events, window, |_, events, window, cx| {
                let toasts = events.update(cx, |events, _| std::mem::take(&mut events.toasts));
                for (message, tone) in toasts {
                    let note = match tone {
                        Tone::Danger => Notification::error(message),
                        Tone::Success => Notification::success(message),
                        Tone::Warning => Notification::warning(message),
                        _ => Notification::info(message),
                    };
                    window.push_notification(note, cx);
                }
                cx.notify();
            }),
            cx.observe(&update, |_, _, cx| cx.notify()),
        ];
        let shell =
            Self { pages, current: 0, update, events, dialog_focus: cx.focus_handle(), _subscriptions: subscriptions };
        if let Some(opened) = shell.pages.first().and_then(|page| page.opened.clone()) {
            opened(window, cx);
        }
        shell
    }

    fn open(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if index == self.current {
            return;
        }
        if let Some(left) = self.pages[self.current].left.clone() {
            left(cx);
        }
        self.current = index;
        if let Some(opened) = self.pages[index].opened.clone() {
            opened(window, cx);
        }
        cx.notify();
    }

    fn render_sidebar(&self, compact: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let brand = if compact {
            div()
                .flex()
                .justify_center()
                .pb(px(22.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(40.))
                        .rounded(px(12.))
                        .bg(theme::brand_gradient())
                        .child(img("deckino/icon-white.svg").w(px(22.)).h(px(22.))),
                )
                .into_any_element()
        } else {
            h_flex()
                .items_end()
                .gap(px(8.))
                .pt(px(2.))
                .px(px(8.))
                .pb(px(22.))
                .child(img("deckino/logo-original.svg").h(px(26.)).w(px(118.)))
                .child(
                    div()
                        .text_size(px(12.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme::text_muted())
                        .child("TOOLBOX"),
                )
                .into_any_element()
        };

        let groups = GROUPS.iter().map(|(label, keys)| {
            v_flex()
                .gap(px(2.))
                .when(!compact, |el| {
                    el.child(
                        div()
                            .px(px(12.))
                            .pb(px(6.))
                            .text_size(px(11.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme::text_dim())
                            .child(label.to_uppercase()),
                    )
                })
                .children(keys.iter().filter_map(|key| {
                    let index = self.pages.iter().position(|page| page.key == *key)?;
                    let page = &self.pages[index];
                    let active = index == self.current;
                    let item = h_flex()
                        .id(page.key)
                        .gap(px(12.))
                        .h(px(40.))
                        .px(px(12.))
                        .rounded_full()
                        .text_size(px(14.))
                        .font_weight(FontWeight::MEDIUM)
                        .cursor_pointer()
                        .when(compact, |el| el.justify_center().px_0())
                        .map(|el| {
                            if active {
                                el.bg(theme::brand_gradient()).text_color(theme::text())
                            } else {
                                el.text_color(theme::text_muted())
                                    .hover(|el| el.bg(theme::color_alpha(0xFFFFFF0D)).text_color(theme::text()))
                            }
                        })
                        .child(ui::icon(page.icon))
                        .when(!compact, |el| el.child(page.name.clone()))
                        .on_click(cx.listener(move |this, _, window, cx| this.open(index, window, cx)));
                    let name = page.name.clone();
                    Some(if compact {
                        item.tooltip(move |window, cx| {
                            gpui_kit::component::tooltip::Tooltip::new(name.clone()).build(window, cx)
                        })
                        .into_any_element()
                    } else {
                        item.into_any_element()
                    })
                }))
        });

        let update = self.update.read(cx);
        let footer = v_flex()
            .gap(px(8.))
            .pt(px(12.))
            .children(update.button_text.clone().map(|text| {
                let on_click = update.on_click.clone();
                let button = Button::new("update")
                    .primary()
                    .rounded(px(999.))
                    .icon(ui::icon(IconName::Download))
                    .disabled(!update.button_enabled)
                    .on_click(move |_, window, cx| {
                        if let Some(on_click) = &on_click {
                            on_click(window, cx);
                        }
                    });
                if compact { button.tooltip(text) } else { button.label(text) }
            }))
            .when(!compact && !update.version_status.is_empty(), |el| {
                el.child(ui::dim(update.version_status.clone()).text_center())
            });

        v_flex()
            .flex_none()
            .w(px(if compact { 76. } else { 244. }))
            .h_full()
            .pt(px(20.))
            .px(px(14.))
            .pb(px(16.))
            .border_r_1()
            .border_color(theme::hairline())
            .bg(theme::color_alpha(0x0B06108C))
            .child(brand)
            .child(v_flex().id("groups").flex_1().min_h_0().overflow_y_scroll().gap(px(18.)).children(groups))
            .child(footer)
    }

    fn render_dialog(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let dialog = self.events.read(cx).dialogs.first()?;
        let (id, destructive, has_cancel) = (dialog.id, dialog.destructive(), dialog.cancel.is_some());
        let (title, message, accept_label, cancel_label) =
            (dialog.title.clone(), dialog.message.clone(), dialog.accept.clone(), dialog.cancel.clone());
        if !self.dialog_focus.contains_focused(window, cx) {
            self.dialog_focus.focus(window, cx);
        }
        let answer = |accepted: bool| {
            cx.listener(move |this: &mut Self, _: &ClickEvent, _, cx| {
                this.events.update(cx, |events, cx| events.answer(id, accepted, cx));
            })
        };
        let accept = Button::new(("dialog-accept", id))
            .rounded(px(999.))
            .label(accept_label)
            .map(|button| if destructive { button.danger() } else { button.primary() })
            .on_click(answer(true));
        let cancel = cancel_label
            .map(|cancel| Button::new(("dialog-cancel", id)).rounded(px(999.)).label(cancel).on_click(answer(false)));
        Some(
            div()
                .id("dialog-overlay")
                // Modal: clicks must not reach the page or sidebar under the dimmed layer.
                .occlude()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .bg(theme::color_alpha(0x0B0610B3))
                .track_focus(&self.dialog_focus)
                // Enter accepts (never a deletion, which waits for a click); Escape cancels. A held key answers once.
                .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                    if event.is_held {
                        return;
                    }
                    let accepted = match event.keystroke.key.as_str() {
                        "enter" if !destructive || !has_cancel => true,
                        "escape" => false,
                        _ => return,
                    };
                    this.events.update(cx, |events, cx| events.answer(id, accepted, cx));
                    cx.stop_propagation();
                }))
                .child(
                    v_flex()
                        .id("dialog")
                        .w(px(620.))
                        .max_w(relative(0.9))
                        .gap(px(20.))
                        .p(px(24.))
                        .rounded(px(22.))
                        .bg(theme::surface())
                        .border_1()
                        .border_color(theme::hairline())
                        .shadow_lg()
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(div().font_weight(FontWeight::BOLD).text_size(px(16.)).child(title))
                        .child(ui::muted(message))
                        .child(h_flex().justify_end().gap(px(8.)).children(cancel).child(accept)),
                )
                .into_any_element(),
        )
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let compact = window.viewport_size().width < px(1180.);
        let dialog = self.render_dialog(window, cx);
        div()
            .relative()
            .size_full()
            .bg(theme::background())
            .text_color(theme::text())
            .font_family(theme::BODY_FONT)
            .child(h_flex().size_full().items_start().child(self.render_sidebar(compact, cx)).child(
                div().flex_1().min_w_0().h_full().overflow_hidden().child(self.pages[self.current].view.clone()),
            ))
            .children(dialog)
    }
}
