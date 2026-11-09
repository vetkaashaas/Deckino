//! AnnotationCanvas.tsx: the photo with its corner points. Points are normalized to the photo (0..1); markers keep
//! their size at any zoom. The page owns the interaction state (view, drag, pan); this draws it and maps between
//! canvas pixels and photo points.

use std::sync::Arc;

use deckino_core::camera_annotation::NormalizedPoint;
use gpui_kit::*;

use crate::theme;

pub const MIN_ZOOM: f32 = 1.;
pub const MAX_ZOOM: f32 = 8.;
pub const WHEEL_STEP: f32 = 1.15;
pub const BUTTON_STEP: f32 = 1.2;
pub const HIT_RADIUS: f32 = 18.;
pub const DRAG_THRESHOLD: f32 = 3.;
// Edges are drawn past each corner, so the lines can be laid along the card's straight edges.
const GUIDE_EXTENSION: f32 = 0.12;
pub const RADIUS: f32 = 10.;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct View {
    pub zoom: f32,
    pub x: f32,
    pub y: f32,
}

impl View {
    pub const FIT: View = View { zoom: 1., x: 0., y: 0. };
}

/// The photo fitted into the canvas at zoom 1, and the view on it. Coordinates are canvas pixels from its top left.
#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    width: f32,
    height: f32,
    pub fit_x: f32,
    pub fit_y: f32,
    pub fit_w: f32,
    pub fit_h: f32,
    pub view: View,
}

impl Geometry {
    pub fn new(canvas: Size<Pixels>, image_width: u32, image_height: u32, view: View) -> Self {
        let (width, height) = (f32::from(canvas.width), f32::from(canvas.height));
        let (image_width, image_height) = (image_width as f32, image_height as f32);
        let scale =
            if image_width > 0. && image_height > 0. { (width / image_width).min(height / image_height) } else { 0. };
        let (fit_w, fit_h) = (image_width * scale, image_height * scale);
        Self { width, height, fit_x: (width - fit_w) / 2., fit_y: (height - fit_h) / 2., fit_w, fit_h, view }
    }

    pub fn center(&self) -> (f32, f32) {
        (self.width / 2., self.height / 2.)
    }

    pub fn clamp(&self, next: View) -> View {
        let zoom = next.zoom.clamp(MIN_ZOOM, MAX_ZOOM);
        let max_x = ((self.fit_w * zoom - self.width) / 2.).max(0.);
        let max_y = ((self.fit_h * zoom - self.height) / 2.).max(0.);
        View { zoom, x: next.x.clamp(-max_x, max_x), y: next.y.clamp(-max_y, max_y) }
    }

    /// Keeps the photo point under `focus` (canvas pixels) where it is.
    pub fn zoom_at(&self, factor: f32, focus: (f32, f32)) -> View {
        let (center_x, center_y) = self.center();
        let current = self.view;
        let zoom = (current.zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
        let base_x = (focus.0 - current.x - center_x) / current.zoom;
        let base_y = (focus.1 - current.y - center_y) / current.zoom;
        self.clamp(View { zoom, x: focus.0 - center_x - base_x * zoom, y: focus.1 - center_y - base_y * zoom })
    }

    pub fn to_canvas(&self, point: NormalizedPoint) -> (f32, f32) {
        let (center_x, center_y) = self.center();
        let view = self.view;
        (
            (self.fit_x + point.x as f32 * self.fit_w - center_x) * view.zoom + center_x + view.x,
            (self.fit_y + point.y as f32 * self.fit_h - center_y) * view.zoom + center_y + view.y,
        )
    }

    pub fn to_photo(&self, x: f32, y: f32) -> NormalizedPoint {
        let (center_x, center_y) = self.center();
        let view = self.view;
        NormalizedPoint::new(
            (((x - view.x - center_x) / view.zoom + center_x - self.fit_x) / self.fit_w) as f64,
            (((y - view.y - center_y) / view.zoom + center_y - self.fit_y) / self.fit_h) as f64,
        )
    }
}

/// What one frame draws: the photo, the points as shown (a dragged marker where the pointer has it), which is
/// selected.
pub struct Scene {
    pub image: Option<Arc<RenderImage>>,
    pub image_width: u32,
    pub image_height: u32,
    pub view: View,
    pub points: Vec<NormalizedPoint>,
    pub selected: Option<usize>,
}

pub fn paint(scene: &Scene, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut App) {
    let Some(image) = scene.image.clone() else {
        return;
    };
    let geometry = Geometry::new(bounds.size, scene.image_width, scene.image_height, scene.view);
    if geometry.fit_w <= 0. || geometry.fit_h <= 0. {
        return;
    }
    let at = |(x, y): (f32, f32)| point(bounds.origin.x + px(x), bounds.origin.y + px(y));

    let zoom = scene.view.zoom;
    let image_bounds = Bounds::new(
        at(geometry.to_canvas(NormalizedPoint::new(0., 0.))),
        size(px(geometry.fit_w * zoom), px(geometry.fit_h * zoom)),
    );
    let _ = window.paint_image(bounds, image_bounds, Corners::all(px(RADIUS)), image, 0, false);

    let shown: Vec<Point<Pixels>> = scene.points.iter().map(|point| at(geometry.to_canvas(*point))).collect();

    if shown.len() == 4 {
        for index in 0..4 {
            let (start, end) = (shown[index], shown[(index + 1) % 4]);
            let delta = point((end.x - start.x) * GUIDE_EXTENSION, (end.y - start.y) * GUIDE_EXTENSION);
            let guide = theme::warning().opacity(0.7);
            stroke(window, &[start - delta, start], false, 1.2, guide, true);
            stroke(window, &[end, end + delta], false, 1.2, guide, true);
        }
    }

    if shown.len() > 1 {
        let closed = shown.len() == 4;
        if closed {
            let mut fill = PathBuilder::fill();
            fill.add_polygon(&shown, true);
            if let Ok(path) = fill.build() {
                window.paint_path(path, theme::color_alpha(0xB059FF14));
            }
        }
        stroke(window, &shown, closed, 5., theme::color_alpha(0x0B0610CC), false);
        stroke(window, &shown, closed, 2.5, theme::violet(), false);
    }

    for (index, center) in shown.iter().enumerate() {
        let selected = scene.selected == Some(index);
        let shadow = if selected { 11. } else { 10. };
        circle(window, *center, shadow, theme::color_alpha(0x0B0610D9), None);
        // The SVG stroke straddles the edge; a quad's border sits inside it.
        let fill = if selected { theme::warning() } else { theme::violet() };
        circle(window, *center, if selected { 8.75 } else { 7.75 }, fill, Some((1.5, theme::text())));
        label(window, cx, (index + 1).to_string(), point(center.x + px(12.), center.y - px(21.)));
    }
}

fn stroke(window: &mut Window, points: &[Point<Pixels>], closed: bool, width: f32, color: Hsla, dashed: bool) {
    let mut builder = PathBuilder::stroke(px(width));
    if dashed {
        builder = builder.dash_array(&[px(6.), px(4.)]);
    }
    builder.add_polygon(points, closed);
    if let Ok(path) = builder.build() {
        window.paint_path(path, color);
    }
}

fn circle(window: &mut Window, center: Point<Pixels>, radius: f32, color: Hsla, border: Option<(f32, Hsla)>) {
    let (border_width, border_color) = border.unwrap_or((0., transparent_black()));
    let bounds = Bounds::new(center - point(px(radius), px(radius)), size(px(radius * 2.), px(radius * 2.)));
    window.paint_quad(quad(bounds, px(radius), color, px(border_width), border_color, BorderStyle::Solid));
}

/// The marker's number in white with a dark outline (SVG's paint-order stroke), drawn as dark copies around it.
fn label(window: &mut Window, cx: &mut App, text: String, origin: Point<Pixels>) {
    let text = SharedString::from(text);
    let run =
        |color: Hsla| TextRun { len: text.len(), font: font(theme::BODY_FONT).bold(), color, ..Default::default() };
    let line_height = px(14.);
    let outline = window.text_system().shape_line(text.clone(), px(11.), &[run(theme::color_alpha(0x0B0610E6))], None);
    for (dx, dy) in [(-1.5, 0.), (1.5, 0.), (0., -1.5), (0., 1.5), (-1., -1.), (1., -1.), (-1., 1.), (1., 1.)] {
        let _ = outline.paint(origin + point(px(dx), px(dy)), line_height, TextAlign::Left, None, window, cx);
    }
    let fill = window.text_system().shape_line(text.clone(), px(11.), &[run(theme::text())], None);
    let _ = fill.paint(origin, line_height, TextAlign::Left, None, window, cx);
}
