//! The pieces every page is built from (the React UI's components.tsx): headers, glass sections, stat tiles, status
//! pills, run/cancel buttons, stage lists, the activity log, empty states, image wells and photo tiles.

use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::progress::Progress;
use gpui_kit::component::{Disableable, Icon, Sizable, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

pub use gpui_kit::assets::IconName;

use crate::theme;

/// A status pill's or dot's colour (the C# StatusTone).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Tone {
    #[default]
    Neutral,
    Pending,
    Accent,
    Success,
    Warning,
    Danger,
}

pub fn tone_color(tone: Tone) -> Hsla {
    match tone {
        Tone::Neutral => theme::text_muted(),
        Tone::Pending => theme::text_dim(),
        Tone::Accent => theme::violet(),
        Tone::Success => theme::success(),
        Tone::Warning => theme::warning(),
        Tone::Danger => theme::danger(),
    }
}

/// A stage's or step's status (ProductionStageStatus, StatusKind, RequirementState) as a tone.
pub fn status_tone(status: &str) -> Tone {
    match status {
        "Running" | "Working" => Tone::Accent,
        "Passed" | "Done" => Tone::Success,
        "Warning" => Tone::Warning,
        "Failed" | "Missing" => Tone::Danger,
        "Cancelled" => Tone::Neutral,
        _ => Tone::Pending,
    }
}

pub fn icon(name: IconName) -> Icon {
    Icon::new(name)
}

pub fn heading(text: impl Into<SharedString>, size: f32) -> Div {
    div().font_family(theme::HEADING_FONT).font_weight(FontWeight::EXTRA_BOLD).text_size(px(size)).child(text.into())
}

pub fn muted(text: impl Into<SharedString>) -> Div {
    div().text_size(px(13.)).text_color(theme::text_muted()).child(text.into())
}

pub fn dim(text: impl Into<SharedString>) -> Div {
    div().text_size(px(12.)).text_color(theme::text_dim()).child(text.into())
}

/// A dot in the tone's colour; `pulse` breathes while something runs.
pub fn dot(id: impl Into<ElementId>, tone: Tone, pulse: bool) -> AnyElement {
    let dot = div().flex_none().size(px(10.)).rounded_full().bg(tone_color(tone));
    if pulse {
        dot.with_animation(id, Animation::new(Duration::from_millis(1400)).repeat(), |dot, delta| {
            dot.opacity(1. - 0.65 * (delta * std::f32::consts::PI).sin())
        })
        .into_any_element()
    } else {
        dot.into_any_element()
    }
}

/// The page itself: fills the main area; `scroll` pages scroll as a whole, the others lay out to fit.
pub fn page(id: impl Into<ElementId>, scroll: bool) -> Stateful<Div> {
    let page = v_flex().id(id).size_full().gap(px(18.)).pt(px(28.)).px(px(32.)).pb(px(24.));
    if scroll { page.overflow_y_scroll() } else { page.overflow_hidden() }
}

pub fn page_header(
    title: impl Into<SharedString>,
    subtitle: impl Into<SharedString>,
    status: Option<AnyElement>,
    actions: Vec<AnyElement>,
) -> Div {
    let subtitle: SharedString = subtitle.into();
    h_flex()
        .flex_none()
        .justify_between()
        .items_start()
        .gap(px(20.))
        .child(
            v_flex()
                .gap(px(4.))
                .min_w_0()
                .child(h_flex().gap(px(12.)).child(heading(title, 28.)).children(status))
                .when(!subtitle.is_empty(), |el| el.child(muted(subtitle).max_w(px(720.)))),
        )
        .child(h_flex().gap(px(8.)).flex_wrap().justify_end().children(actions))
}

/// A glass card with an optional title, subtitle and actions on the right. Add the content with `.child`.
pub fn section(title: Option<&str>, subtitle: Option<&str>, actions: Vec<AnyElement>) -> Div {
    let card =
        v_flex().flex_none().p(px(20.)).rounded(px(22.)).bg(theme::glass()).border_1().border_color(theme::hairline());
    if title.is_none() && actions.is_empty() {
        return card;
    }
    card.child(
        h_flex()
            .justify_between()
            .items_start()
            .gap(px(12.))
            .mb(px(16.))
            .child(
                v_flex()
                    .gap(px(2.))
                    .min_w_0()
                    .children(title.map(|title| heading(title.to_string(), 16.)))
                    .children(subtitle.filter(|s| !s.is_empty()).map(|s| muted(s.to_string()))),
            )
            .child(h_flex().gap(px(8.)).children(actions)),
    )
}

/// Tiles that wrap, each at least 150px wide.
/// pages.module.css `.split`: a fixed-width column of cards, scrolling on its own, beside one that takes the rest.
pub fn split(left: impl IntoElement, right: impl IntoElement, window: &Window) -> Div {
    let column = if window.viewport_size().width <= px(1400.) { 360. } else { 440. };
    h_flex()
        .flex_1()
        .min_h_0()
        .w_full()
        .items_stretch()
        .gap(px(16.))
        .child(
            v_flex()
                .id("split-column")
                .flex_none()
                .w(px(column))
                .min_h_0()
                .gap(px(16.))
                .overflow_y_scroll()
                .child(left),
        )
        .child(v_flex().flex_1().min_w_0().min_h_0().child(right))
}

pub fn stats(tiles: Vec<AnyElement>) -> Div {
    h_flex().flex_wrap().gap(px(12.)).children(tiles)
}

pub fn stat_tile(label: impl Into<SharedString>, value: impl Into<SharedString>, caption: Option<&str>) -> AnyElement {
    v_flex()
        .flex_1()
        .flex_basis(px(150.))
        .min_w(px(150.))
        .py(px(12.))
        .px(px(14.))
        .rounded(px(14.))
        .bg(theme::tint())
        .border_1()
        .border_color(theme::color_alpha(0x7911CB40))
        .child(
            div()
                .text_size(px(12.))
                .text_color(theme::text_muted())
                .font_weight(FontWeight::MEDIUM)
                .child(label.into()),
        )
        .child(heading(value, 24.).line_height(relative(1.2)))
        .children(caption.map(|caption| dim(caption.to_string()).truncate()))
        .into_any_element()
}

pub fn status_pill(tone: Tone, text: impl Into<SharedString>) -> AnyElement {
    h_flex()
        .flex_none()
        .gap(px(8.))
        .h(px(30.))
        .px(px(12.))
        .rounded_full()
        .bg(theme::glass())
        .border_1()
        .border_color(theme::color_alpha(0xFFFFFF1F))
        .text_size(px(13.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(tone_color(tone))
        .child(dot("status-pill-dot", tone, tone == Tone::Accent))
        .child(text.into())
        .into_any_element()
}

/// The main action of a page: rounded, in the brand gradient.
pub fn primary_button(id: impl Into<ElementId>, label: impl Into<SharedString>, icon_name: Option<IconName>) -> Button {
    let button = Button::new(id).primary().rounded(px(999.)).label(label);
    match icon_name {
        Some(name) => button.icon(icon(name)),
        None => button,
    }
}

/// A quieter action beside it.
pub fn secondary_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    icon_name: Option<IconName>,
) -> Button {
    let button = Button::new(id).rounded(px(999.)).label(label);
    match icon_name {
        Some(name) => button.icon(icon(name)),
        None => button,
    }
}

/// A round icon-only button with a tooltip.
pub fn icon_button(id: impl Into<ElementId>, name: IconName, tooltip: impl Into<SharedString>) -> Button {
    Button::new(id).ghost().rounded(px(999.)).icon(icon(name)).tooltip(tooltip)
}

/// A job's start button, which becomes its Cancel button while the job runs. A job that can't be cancelled passes no
/// `on_cancel` and stays `busy = false`.
pub fn run_button(
    id: impl Into<ElementId>,
    busy: bool,
    icon_name: IconName,
    label: impl Into<SharedString>,
    run_disabled: bool,
    cancel_disabled: bool,
    on_run: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    on_cancel: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    if busy {
        Button::new(id)
            .danger()
            .rounded(px(999.))
            .icon(icon(IconName::CircleStop))
            .label("Cancel")
            .min_w(px(120.))
            .disabled(cancel_disabled)
            .on_click(on_cancel)
            .into_any_element()
    } else {
        primary_button(id, label, Some(icon_name))
            .min_w(px(120.))
            .disabled(run_disabled)
            .on_click(on_run)
            .into_any_element()
    }
}

/// An alert with the full error text, kept until dismissed, with its details one click away.
pub fn error_alert(
    message: impl Into<SharedString>,
    on_copy: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    on_dismiss: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    h_flex()
        .flex_none()
        .gap(px(12.))
        .justify_between()
        .py(px(10.))
        .px(px(14.))
        .rounded(px(14.))
        .bg(theme::color_alpha(0xFF5A7A1F))
        .border_1()
        .border_color(theme::color_alpha(0xFF5A7A59))
        .child(
            h_flex().gap(px(10.)).min_w_0().child(icon(IconName::TriangleAlert).text_color(theme::danger())).child(
                div()
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme::danger())
                    .child(message.into()),
            ),
        )
        .child(
            h_flex()
                .gap(px(4.))
                .flex_none()
                .child(Button::new("copy-error").ghost().small().label("Copy details").on_click(on_copy))
                .child(Button::new("dismiss-error").ghost().small().label("Dismiss").on_click(on_dismiss)),
        )
        .into_any_element()
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stage {
    pub id: Option<SharedString>,
    pub name: SharedString,
    pub status: SharedString,
    pub detail: SharedString,
    pub duration: Option<SharedString>,
    pub progress_percent: Option<f32>,
    pub shows_progress: bool,
}

/// The stages of a job: a dot, the name, the detail and, while it runs, a bar.
pub fn stage_list(id: &str, stages: &[Stage]) -> Div {
    v_flex().children(stages.iter().enumerate().map(|(index, stage)| {
        let tone = status_tone(&stage.status);
        v_flex()
            .py(px(9.))
            .when(index > 0, |el| el.border_t_1().border_color(theme::color_alpha(0xFFFFFF0F)))
            .child(
                h_flex()
                    .gap(px(12.))
                    .justify_between()
                    .child(
                        h_flex()
                            .gap(px(12.))
                            .min_w_0()
                            .child(dot(SharedString::from(format!("{id}-dot-{index}")), tone, tone == Tone::Accent))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .truncate()
                                    .child(stage.name.clone()),
                            ),
                    )
                    .children(stage.duration.clone().map(|duration| {
                        div()
                            .font_family(theme::MONO_FONT)
                            .text_size(px(12.))
                            .text_color(theme::text_muted())
                            .child(duration)
                    })),
            )
            .child(div().pl(px(22.)).child(muted(stage.detail.clone())))
            .when(stage.shows_progress, |el| {
                el.child(
                    div().pl(px(22.)).mt(px(6.)).child(
                        Progress::new(SharedString::from(format!("{id}-progress-{index}")))
                            .value(stage.progress_percent.unwrap_or(0.)),
                    ),
                )
            })
    }))
}

/// The steps of a job as a numbered timeline: one line of detail for the step running and those with a warning or
/// failure only (what a step that went well did is in the log).
pub fn step_list(id: &str, stages: &[Stage]) -> Div {
    let count = stages.len();
    v_flex().children(stages.iter().enumerate().map(|(index, stage)| {
        let tone = status_tone(&stage.status);
        let (badge_fg, badge_bg, badge_border) = match tone {
            Tone::Accent => (theme::text(), theme::purple(), theme::violet()),
            Tone::Success => (theme::success(), theme::color_alpha(0x5BE3A124), theme::color_alpha(0x5BE3A173)),
            Tone::Warning => (theme::warning(), theme::color_alpha(0xF2D27A24), theme::color_alpha(0xF2D27A73)),
            Tone::Danger => (theme::danger(), theme::color_alpha(0xFF5A7A24), theme::color_alpha(0xFF5A7A73)),
            _ => (theme::text_dim(), theme::color_alpha(0x0000004D), theme::color_alpha(0xFFFFFF1F)),
        };
        let badge: AnyElement = match tone {
            Tone::Success => icon(IconName::Check).small().into_any_element(),
            Tone::Danger => icon(IconName::X).small().into_any_element(),
            Tone::Warning => div().child("!").into_any_element(),
            _ => div().child((index + 1).to_string()).into_any_element(),
        };
        let line_done = matches!(tone, Tone::Success | Tone::Warning);
        h_flex()
            .relative()
            .items_start()
            .gap(px(12.))
            .py(px(7.))
            // The line down to the next step fills in violet as the steps finish.
            .when(index + 1 < count, |el| {
                el.child(
                    div()
                        .absolute()
                        .left(px(12.))
                        .top(px(33.))
                        .bottom(px(-5.))
                        .w(px(2.))
                        .rounded(px(1.))
                        .bg(if line_done { theme::color_alpha(0xB059FF99) } else { theme::color_alpha(0xFFFFFF14) }),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .size(px(26.))
                    .rounded_full()
                    .text_size(px(11.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(badge_fg)
                    .bg(badge_bg)
                    .border_1()
                    .border_color(badge_border)
                    .child(badge),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .pt(px(3.))
                    .child(
                        h_flex()
                            .gap(px(12.))
                            .justify_between()
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .truncate()
                                    .when(matches!(tone, Tone::Pending | Tone::Neutral), |el| {
                                        el.text_color(theme::text_muted())
                                    })
                                    .child(stage.name.clone()),
                            )
                            .children(stage.duration.clone().map(|duration| {
                                div()
                                    .font_family(theme::MONO_FONT)
                                    .text_size(px(12.))
                                    .text_color(theme::text_muted())
                                    .child(duration)
                            })),
                    )
                    .when(matches!(tone, Tone::Accent | Tone::Warning | Tone::Danger), |el| {
                        el.child(dim(stage.detail.clone()).truncate())
                    })
                    .when(stage.shows_progress, |el| {
                        el.child(
                            div().mt(px(6.)).child(
                                Progress::new(SharedString::from(format!("{id}-step-progress-{index}")))
                                    .value(stage.progress_percent.unwrap_or(0.)),
                            ),
                        )
                    }),
            )
    }))
}

/// The activity log: follows the newest line unless scrolled up; a click selects a line to copy. A page owns one
/// (`cx.new(|_| LogView::new(...))`) and adds lines with `push`.
pub struct LogView {
    /// Empty shows "Activity log"; the training pages put the job's status here.
    pub title: SharedString,
    folder: Option<PathBuf>,
    pub lines: Vec<SharedString>,
    pub selected: Option<usize>,
    scroll: UniformListScrollHandle,
    max_lines: Option<usize>,
    /// Replaces the plain clear (the training pages confirm it and empty the log file too).
    on_clear: Option<Rc<dyn Fn(&mut Window, &mut App)>>,
}

impl LogView {
    pub fn new(title: impl Into<SharedString>, folder: Option<PathBuf>) -> Self {
        Self {
            title: title.into(),
            folder,
            lines: Vec::new(),
            selected: None,
            scroll: UniformListScrollHandle::new(),
            max_lines: None,
            on_clear: None,
        }
    }

    /// Keeps only the newest `max_lines`.
    pub fn bounded(mut self, max_lines: usize) -> Self {
        self.max_lines = Some(max_lines);
        self
    }

    /// Clears through `on_clear` instead of plainly.
    pub fn on_clear(mut self, on_clear: Rc<dyn Fn(&mut Window, &mut App)>) -> Self {
        self.on_clear = Some(on_clear);
        self
    }

    pub fn push(&mut self, line: impl Into<SharedString>, cx: &mut Context<Self>) {
        let following = self.is_following();
        self.lines.push(line.into());
        if let Some(max) = self.max_lines.filter(|max| self.lines.len() > *max) {
            let removed = self.lines.len() - max;
            self.lines.drain(..removed);
            self.selected = self.selected.and_then(|index| index.checked_sub(removed));
        }
        if following {
            self.scroll.scroll_to_item(self.lines.len() - 1, ScrollStrategy::Bottom);
        }
        cx.notify();
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.lines.clear();
        self.selected = None;
        cx.notify();
    }

    fn is_following(&self) -> bool {
        let state = self.scroll.0.borrow();
        let handle = &state.base_handle;
        let (offset, max) = (handle.offset().y, handle.max_offset().y);
        // Offsets are negative going down; within 24px of the end counts as following.
        max <= px(0.) || -offset >= max - px(24.)
    }
}

impl Render for LogView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let has_lines = !self.lines.is_empty();
        let mut actions = vec![
            icon_button("log-copy-selected", IconName::Copy, "Copy selected line")
                .disabled(self.selected.is_none())
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some(line) = this.selected.and_then(|index| this.lines.get(index)) {
                        crate::events::copy_text(cx, line.to_string());
                    }
                }))
                .into_any_element(),
            icon_button("log-copy-all", IconName::ClipboardCopy, "Copy the whole log")
                .disabled(!has_lines)
                .on_click(cx.listener(|this, _, _, cx| {
                    let text = this.lines.iter().map(|line| line.as_ref()).collect::<Vec<_>>().join("\r\n");
                    crate::events::copy_text(cx, text);
                }))
                .into_any_element(),
        ];
        if let Some(folder) = self.folder.clone() {
            actions.push(
                icon_button("log-open-folder", IconName::FolderOpen, "Open the log folder")
                    .on_click(move |_, _, _| crate::events::open_folder(&folder))
                    .into_any_element(),
            );
        }
        actions.push(
            icon_button("log-clear", IconName::ListX, "Clear this view (the log file keeps everything)")
                .disabled(!has_lines)
                .on_click(cx.listener(|this, _, window, cx| match this.on_clear.clone() {
                    Some(on_clear) => on_clear(window, cx),
                    None => this.clear(cx),
                }))
                .into_any_element(),
        );

        let body: AnyElement = if has_lines {
            uniform_list(
                "log-lines",
                self.lines.len(),
                cx.processor(|this, range: std::ops::Range<usize>, _, cx| {
                    range
                        .map(|index| {
                            let selected = this.selected == Some(index);
                            div()
                                .id(index)
                                .px(px(10.))
                                .py(px(2.))
                                .font_family(theme::MONO_FONT)
                                .text_size(px(12.))
                                .line_height(px(19.))
                                .whitespace_nowrap()
                                .overflow_hidden()
                                .text_ellipsis()
                                .text_color(if selected { theme::text() } else { theme::text_muted() })
                                .when(selected, |el| el.bg(theme::tint_strong()))
                                .hover(|el| el.bg(theme::color_alpha(0xFFFFFF0A)))
                                .child(this.lines[index].clone())
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.selected = Some(index);
                                    cx.notify();
                                }))
                        })
                        .collect()
                }),
            )
            .track_scroll(&self.scroll)
            .size_full()
            .into_any_element()
        } else {
            div()
                .p(px(10.))
                .text_size(px(13.))
                .text_color(theme::text_dim())
                .child("Nothing logged yet.")
                .into_any_element()
        };

        let title = if self.title.is_empty() { SharedString::from("Activity log") } else { self.title.clone() };
        section(Some(&title), None, actions).size_full().min_h_0().child(
            div()
                .flex_1()
                .min_h(px(120.))
                .rounded(px(10.))
                .bg(theme::color_alpha(0x00000047))
                .border_1()
                .border_color(theme::color_alpha(0xFFFFFF0F))
                .overflow_hidden()
                .child(body),
        )
    }
}

pub fn empty_state(icon_name: IconName, title: impl Into<SharedString>, message: Option<&str>) -> AnyElement {
    v_flex()
        .items_center()
        .justify_center()
        .gap(px(6.))
        .py(px(32.))
        .text_color(theme::text_muted())
        .child(
            div()
                .flex()
                .items_center()
                .justify_center()
                .size(px(44.))
                .mb(px(4.))
                .rounded_full()
                .bg(theme::tint())
                .text_color(theme::lavender())
                .child(icon(icon_name)),
        )
        .child(div().font_weight(FontWeight::SEMIBOLD).text_color(theme::text()).child(title.into()))
        .children(message.map(|message| muted(message.to_string()).text_center().max_w(px(360.))))
        .into_any_element()
}

/// An image in a dark well, fitted inside it, or a quiet placeholder while there is none.
pub fn image_well(source: Option<ImageSource>, placeholder: &str) -> Div {
    let well = div()
        .relative()
        .flex()
        .items_center()
        .justify_center()
        .min_h_0()
        .overflow_hidden()
        .rounded(px(14.))
        .bg(theme::color_alpha(0x00000059))
        .border_1()
        .border_color(theme::color_alpha(0xFFFFFF0F));
    match source {
        Some(source) => well.child(img(source).absolute().inset_0().size_full().object_fit(ObjectFit::Contain)),
        None => well.child(
            div()
                .px(px(16.))
                .text_size(px(13.))
                .text_color(theme::text_dim())
                .text_center()
                .child(placeholder.to_string()),
        ),
    }
}

/// A photo that ticks on and off with a click. Its name and tick sit under it, then any further caption. A tick
/// highlights it, or with `dim_unticked` (a list kept unless left out) an untick dims it.
pub fn photo_tile(
    id: impl Into<ElementId>,
    image: Option<ImageSource>,
    name: impl Into<SharedString>,
    checked: bool,
    dim_unticked: bool,
    caption: Option<AnyElement>,
    on_toggle: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let highlighted = checked && !dim_unticked;
    let dimmed = dim_unticked && !checked;
    let name: SharedString = name.into();
    div()
        .id(id)
        .flex_1()
        .flex_basis(px(210.))
        .min_w(px(210.))
        .overflow_hidden()
        .rounded(px(14.))
        .bg(theme::glass())
        .border_1()
        .border_color(if highlighted { theme::violet() } else { theme::hairline() })
        .cursor_pointer()
        .hover(|el| el.border_color(theme::color_alpha(0xB059FF80)))
        .on_click(on_toggle)
        .child(
            div()
                .relative()
                .w_full()
                .h(px(158.))
                .bg(theme::color_alpha(0x00000073))
                .when(dimmed, |el| el.opacity(0.35))
                .children(image.map(|image| img(image).absolute().inset_0().size_full().object_fit(ObjectFit::Contain)))
                .when(highlighted, |el| el.child(div().absolute().inset_0().bg(theme::tint_strong()))),
        )
        .child(
            v_flex()
                .gap(px(3.))
                .pt(px(8.))
                .px(px(10.))
                .pb(px(10.))
                .child(
                    h_flex()
                        .justify_between()
                        .gap(px(8.))
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .truncate()
                                .when(dimmed, |el| el.text_color(theme::text_dim()))
                                .child(name.clone()),
                        )
                        .child(Checkbox::new(SharedString::from(format!("tick-{name}"))).checked(checked).small()),
                )
                .children(caption),
        )
}
