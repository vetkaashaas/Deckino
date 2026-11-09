//! One module per page: the old view model and its React page together. Each exposes
//! `pub fn entry(services, window, cx) -> PageEntry`.

use std::sync::Arc;

use deckino_core::services::Services;
use gpui_kit::*;

use crate::shell::PageEntry;

mod annotator;
mod card_identification;
mod dataset_sync;
mod extraction_training;
mod model_sync;
mod photo_library;
mod runner;
mod sync;

/// The sidebar's order (grouped in shell.rs).
pub fn build(services: Arc<Services>, window: &mut Window, cx: &mut App) -> Vec<PageEntry> {
    vec![
        sync::entry(services.clone(), window, cx),
        dataset_sync::entry(services.clone(), window, cx),
        model_sync::entry(services.clone(), window, cx),
        annotator::entry(services.clone(), window, cx),
        card_identification::entry(services.clone(), window, cx),
        photo_library::entry(services.clone(), window, cx),
        extraction_training::entry(services.clone(), window, cx),
        runner::entry(services, window, cx),
    ]
}
