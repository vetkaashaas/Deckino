//! The app's tokens (STYLEGUIDE.md, Deckino.App/src/theme.ts): one deep purple, violet for what must stand out on the
//! dark background, lavender for calm accents.

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::*;

pub fn color(hex: u32) -> Hsla {
    rgb(hex).into()
}

/// `0xRRGGBBAA`.
pub fn color_alpha(hex: u32) -> Hsla {
    rgba(hex).into()
}

pub fn purple() -> Hsla {
    color(0x7911CB)
}
pub fn purple_deep() -> Hsla {
    color(0x440780)
}
pub fn violet() -> Hsla {
    color(0xB059FF)
}
pub fn lavender() -> Hsla {
    color(0xC79BF2)
}
pub fn background() -> Hsla {
    color(0x0B0610)
}
pub fn surface() -> Hsla {
    color(0x160D1F)
}
/// rgba(20, 11, 28, 0.78)
pub fn glass() -> Hsla {
    color_alpha(0x140B1CC7)
}
/// rgba(255, 255, 255, 0.10)
pub fn hairline() -> Hsla {
    color_alpha(0xFFFFFF1A)
}
/// rgba(121, 17, 203, 0.18)
pub fn tint() -> Hsla {
    color_alpha(0x7911CB2E)
}
/// rgba(121, 17, 203, 0.32)
pub fn tint_strong() -> Hsla {
    color_alpha(0x7911CB52)
}
pub fn text() -> Hsla {
    color(0xFFFFFF)
}
pub fn text_muted() -> Hsla {
    color(0xB9AFC4)
}
pub fn text_dim() -> Hsla {
    color(0x7D7287)
}
pub fn success() -> Hsla {
    color(0x5BE3A1)
}
pub fn danger() -> Hsla {
    color(0xFF5A7A)
}
pub fn warning() -> Hsla {
    color(0xF2D27A)
}

/// The brand gradient, left to right.
pub fn brand_gradient() -> Background {
    linear_gradient(90., linear_color_stop(purple(), 0.), linear_color_stop(purple_deep(), 1.))
}

pub const BODY_FONT: &str = "Lexend";
pub const HEADING_FONT: &str = "Bricolage Grotesque";
pub const MONO_FONT: &str = "Cascadia Mono";

/// The component library in Deckino's colours: dark only.
pub fn apply(cx: &mut App) {
    Theme::change(ThemeMode::Dark, None, cx);
    // Through update: it carries the colours into the theme tokens the widgets paint with, and refreshes the Base layer.
    Theme::update(cx, |theme| {
        theme.font_family = BODY_FONT.into();
        theme.font_size = px(14.);
        theme.mono_font_family = MONO_FONT.into();
        theme.radius = px(10.);
        theme.radius_lg = px(14.);
        let c = &mut theme.colors;
        c.background = background();
        c.foreground = text();
        c.border = hairline();
        c.input = color_alpha(0xFFFFFF24);
        c.ring = violet();
        c.caret = violet();
        c.selection = color_alpha(0x7911CB8C);
        c.muted = surface();
        c.muted_foreground = text_muted();
        c.popover = surface();
        c.popover_foreground = text();
        c.accent = tint();
        c.accent_foreground = text();
        c.primary = purple();
        c.primary_hover = color(0x8A1FDE);
        c.primary_active = purple_deep();
        c.primary_foreground = text();
        c.secondary = color_alpha(0xFFFFFF0F);
        c.secondary_hover = color_alpha(0xFFFFFF1A);
        c.secondary_active = color_alpha(0xFFFFFF24);
        c.secondary_foreground = text();
        c.danger = danger();
        c.danger_hover = color(0xFF1A3C);
        c.danger_active = color(0xA8001C);
        c.danger_foreground = text();
        c.success = success();
        c.success_foreground = background();
        c.warning = warning();
        c.warning_foreground = background();
        c.info = violet();
        c.info_foreground = text();
        c.button = color_alpha(0xFFFFFF0F);
        c.button_hover = color_alpha(0xFFFFFF1A);
        c.button_active = color_alpha(0xFFFFFF24);
        c.button_foreground = text();
        c.button_primary = purple();
        c.button_primary_hover = color(0x8A1FDE);
        c.button_primary_active = purple_deep();
        c.button_primary_foreground = text();
        c.button_danger = color(0xD8173A);
        c.button_danger_hover = color(0xFF1A3C);
        c.button_danger_active = color(0xA8001C);
        c.button_danger_foreground = text();
        c.list = background();
        c.list_hover = color_alpha(0xFFFFFF0A);
        c.list_active = tint_strong();
        c.list_active_border = violet();
        c.progress_bar = purple();
        c.switch = color_alpha(0xFFFFFF24);
        c.slider_bar = purple();
        c.slider_thumb = text();
        c.scrollbar = color_alpha(0x00000000);
        c.scrollbar_thumb = color_alpha(0xFFFFFF24);
        c.scrollbar_thumb_hover = color_alpha(0xFFFFFF40);
        c.overlay = color_alpha(0x0B0610B3);
        c.window_border = hairline();
        c.link = violet();
        c.link_hover = lavender();
        c.link_active = lavender();
        c.drop_target = tint_strong();
        c.drag_border = violet();
        c.skeleton = surface();
        c.title_bar = background();
        c.title_bar_border = hairline();
        c.table = background();
        c.table_head = surface();
        c.table_hover = color_alpha(0xFFFFFF0A);
        c.table_active = tint_strong();
        c.table_active_border = violet();
        c.table_row_border = hairline();
    });
}
