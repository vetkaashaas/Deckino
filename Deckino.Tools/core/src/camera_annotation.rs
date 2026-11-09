//! CameraAnnotationModels.cs: the sidecars beside each camera photo and the import descriptor. PascalCase on disk,
//! nulls written: the C# Toolbox reads and writes the same files.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::camera_annotation_store::CameraAnnotationStore;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct NormalizedPoint {
    pub x: f64,
    pub y: f64,
}

impl NormalizedPoint {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

/// <photo>._annotations.json: the card's four corners, normalized to the photo.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct CardAnnotation {
    #[serde(default = "schema_version_one")]
    pub schema_version: i32,
    #[serde(default = "corners_v1")]
    pub dataset_version: String,
    pub image_file: String,
    #[serde(default = "card_present_default")]
    pub card_present: bool,
    #[serde(default = "corner_order_default")]
    pub corner_order: Vec<String>,
    pub top_left: Option<NormalizedPoint>,
    pub top_right: Option<NormalizedPoint>,
    pub bottom_right: Option<NormalizedPoint>,
    pub bottom_left: Option<NormalizedPoint>,
    #[serde(default)]
    pub image_width: i32,
    #[serde(default)]
    pub image_height: i32,
    #[serde(default)]
    pub source_group: String,
    pub capture_condition: Option<String>,
    pub split: Option<String>,
    /// Which corner definition the annotator followed; None for positives saved before it was recorded.
    pub corner_convention: Option<String>,
}

fn schema_version_one() -> i32 {
    1
}
fn corners_v1() -> String {
    "corners-v1".into()
}
fn card_present_default() -> bool {
    true
}
fn corner_order_default() -> Vec<String> {
    CameraAnnotationStore::CORNER_ORDER.iter().map(|corner| corner.to_string()).collect()
}

impl CardAnnotation {
    /// The C# defaults: `new CardAnnotation { ImageFile = ... }`. Set the rest with struct update syntax.
    pub fn new(image_file: impl Into<String>) -> Self {
        Self {
            schema_version: 1,
            dataset_version: corners_v1(),
            image_file: image_file.into(),
            card_present: true,
            corner_order: corner_order_default(),
            top_left: None,
            top_right: None,
            bottom_right: None,
            bottom_left: None,
            image_width: 0,
            image_height: 0,
            source_group: String::new(),
            capture_condition: None,
            split: None,
            corner_convention: None,
        }
    }

    pub fn points(&self) -> [Option<NormalizedPoint>; 4] {
        [self.top_left, self.top_right, self.bottom_right, self.bottom_left]
    }
}

/// The card shown in a camera photo, next to it as <photo>._identity.json. Phone uploads (Source "phone", or
/// "shared" for a photo shared into the app) carry the app's corners and recognizer candidates, kept as-is to
/// study the phone's misses; "Suggest cards" guesses saved with a review go in ToolboxModelVersion/ToolboxCandidates.
/// Only Status confirmed/corrected with OracleId set is a label (with PrintingId, the exact printing, when picked);
/// the Predicted*/Candidates fields are model guesses and must never be trained on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct CardIdentity {
    #[serde(default = "schema_version_one")]
    pub schema_version: i32,
    pub image_file: String,
    #[serde(default = "source_toolbox")]
    pub source: String,
    pub captured_utc: Option<DateTime<Utc>>,
    /// The Deckino account that sent a phone scan (the API records it); kept through review.
    pub user_id: Option<String>,
    pub kind: Option<String>,
    pub model_version: Option<String>,
    pub extractor_version: Option<String>,
    pub predicted_corners: Option<Vec<NormalizedPoint>>,
    #[serde(default)]
    pub candidates: Vec<IdentityCandidate>,
    pub predicted_oracle_id: Option<String>,
    /// How the phone found the card: "embeddings" (the artwork model), "ocr-top5" or "ocr-all" (the printed name).
    /// None on toolbox photos, which no phone recognized.
    pub recognition_method: Option<String>,
    /// What the phone read in the card's title, when the artwork model was unsure.
    pub title_text: Option<String>,
    pub toolbox_model_version: Option<String>,
    pub toolbox_candidates: Option<Vec<IdentityCandidate>>,
    #[serde(default = "status_unreviewed")]
    pub status: String,
    pub oracle_id: Option<String>,
    pub printing_id: Option<String>,
    pub reviewed_utc: Option<DateTime<Utc>>,
}

fn source_toolbox() -> String {
    "toolbox".into()
}
fn status_unreviewed() -> String {
    CardIdentityStatus::UNREVIEWED.into()
}

impl CardIdentity {
    /// The C# defaults: `new CardIdentity { ImageFile = ... }`. Set the rest with struct update syntax.
    pub fn new(image_file: impl Into<String>) -> Self {
        Self {
            schema_version: 1,
            image_file: image_file.into(),
            source: source_toolbox(),
            captured_utc: None,
            user_id: None,
            kind: None,
            model_version: None,
            extractor_version: None,
            predicted_corners: None,
            candidates: Vec::new(),
            predicted_oracle_id: None,
            recognition_method: None,
            title_text: None,
            toolbox_model_version: None,
            toolbox_candidates: None,
            status: status_unreviewed(),
            oracle_id: None,
            printing_id: None,
            reviewed_utc: None,
        }
    }

    /// The sidecar as the phone sent it: the review and any "Suggest cards" guesses saved with it are dropped.
    pub fn without_review(self) -> Self {
        Self {
            toolbox_model_version: None,
            toolbox_candidates: None,
            status: status_unreviewed(),
            oracle_id: None,
            printing_id: None,
            reviewed_utc: None,
            ..self
        }
    }
}

/// Also the card identity worker's reply format (PascalCase there too).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct IdentityCandidate {
    pub oracle_id: String,
    pub score: f64,
    pub prototype: i32,
}

pub struct CardIdentityStatus;

impl CardIdentityStatus {
    pub const UNREVIEWED: &'static str = "unreviewed";
    pub const CONFIRMED: &'static str = "confirmed";
    pub const CORRECTED: &'static str = "corrected";
    pub const NOT_A_CARD: &'static str = "not_a_card";
    pub const UNREADABLE: &'static str = "unreadable";
    pub const ALL: [&'static str; 5] =
        [Self::UNREVIEWED, Self::CONFIRMED, Self::CORRECTED, Self::NOT_A_CARD, Self::UNREADABLE];
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
pub struct CameraImportSource {
    pub source_folder: String,
    pub imported_folder: String,
    pub source_group: String,
}

/// <batch>/.deckino-import.json.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
pub struct CameraImportDescriptor {
    pub schema_version: i32,
    pub batch_id: String,
    pub created_utc: DateTime<Utc>,
    pub capture_condition: Option<String>,
    pub sources: Vec<CameraImportSource>,
    /// Batches from the (dropped) Video Import page; kept so their descriptors still read and write back intact.
    pub video: Option<VideoImportMetadata>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
pub struct VideoImportMetadata {
    pub source_path: String,
    pub duration_seconds: f64,
    pub source_frames_per_second: f64,
    pub requested_frames_per_second: f64,
    pub effective_frames_per_second: f64,
    pub extracted_frames: i32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CameraPhoto {
    pub image_path: PathBuf,
    /// Below the imports root, with the platform's separators (display and queue order only).
    pub relative_path: String,
    pub annotation_path: PathBuf,
    pub source_group: String,
    pub capture_condition: Option<String>,
    pub image_width: u32,
    pub image_height: u32,
    pub is_annotated: bool,
    pub has_invalid_annotation: bool,
    pub modified_utc: DateTime<Utc>,
    pub file_length: u64,
}

impl CameraPhoto {
    pub fn identity_path(&self) -> PathBuf {
        CameraAnnotationStore::identity_path_for(&self.image_path)
    }
}

#[derive(Clone, Debug)]
pub struct CameraImportResult {
    pub batch_root: PathBuf,
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct CameraDeleteResult {
    pub deleted_photos: usize,
    pub deleted_annotations: usize,
    pub errors: Vec<String>,
    pub deleted_identities: usize,
}
