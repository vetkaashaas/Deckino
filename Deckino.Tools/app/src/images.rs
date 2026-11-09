//! Images the pages draw that aren't plain files: thumbnails and crops made in memory. Each is an `Arc<RenderImage>`
//! the page owns (`img(image.clone())` draws it), and `release` frees its GPU texture when the page drops it:
//! GPUI keeps a texture until told, so a page that replaces or evicts images must release the old ones.

use std::sync::Arc;

use gpui_kit::*;

/// An RGBA image made in memory (a perspective preview, a crop) as something `img()` draws.
pub fn from_rgba(mut image: image::RgbaImage) -> Arc<RenderImage> {
    // GPUI's frames are BGRA.
    for pixel in image.pixels_mut() {
        pixel.0.swap(0, 2);
    }
    Arc::new(RenderImage::new(vec![image::Frame::new(image)]))
}

pub fn from_rgb(image: image::RgbImage) -> Arc<RenderImage> {
    from_rgba(image::DynamicImage::ImageRgb8(image).into_rgba8())
}

/// A thumbnail's JPEG bytes, decoded here (off the UI thread) rather than through GPUI's asset cache, which would
/// keep every thumbnail ever shown.
pub fn from_jpeg(bytes: &[u8]) -> anyhow::Result<Arc<RenderImage>> {
    Ok(from_rgba(image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg)?.into_rgba8()))
}

/// Frees images no longer shown from the GPU atlas, once no window is being drawn.
pub fn release(images: impl IntoIterator<Item = Arc<RenderImage>>, cx: &mut App) {
    for image in images {
        cx.defer(move |cx| cx.drop_image(image, None));
    }
}
