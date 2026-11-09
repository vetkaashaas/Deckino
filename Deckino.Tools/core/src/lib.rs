//! The Toolbox's services, ported from the C# Toolbox's Services. No UI: the app crate shows them.

// Foundation
pub mod coordinator;
pub mod credentials;
pub mod db;
pub mod error;
pub mod log;
pub mod object_store;
pub mod paths;
pub mod python;
pub mod recognition_crop;

// Services (one module per C# file; see ../../AGENTS.md)
pub mod bulk_data_sync;
pub mod camera_annotation;
pub mod camera_annotation_store;
pub mod camera_dataset_sync;
pub mod camera_dataset_sync_catalog;
pub mod camera_dataset_sync_service;
pub mod camera_image_import;
pub mod card_catalogue_lookup;
pub mod card_geometry;
pub mod card_identity_suggestions;
pub mod card_images;
pub mod extraction_corner_suggestions;
pub mod extraction_production_workflow;
pub mod headless;
pub mod identity_label_check;
pub mod identity_production_workflow;
pub mod model_publish;
pub mod scryfall;
pub mod services;
pub mod sync_options;
pub mod toolbox_update;
pub mod training_environment;
pub mod training_result_exporter;
pub mod training_run_sync;
pub mod training_stage_availability;

/// C#'s N0: 12345 → "12,345".
pub fn n0(value: impl std::fmt::Display) -> String {
    let text = value.to_string();
    let (sign, digits) = text.strip_prefix('-').map_or(("", text.as_str()), |digits| ("-", digits));
    let mut grouped = String::from(sign);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}
