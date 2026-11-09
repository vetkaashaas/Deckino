//! CameraImageImportService.cs: copies camera photos into a new import batch, upright and at most 1024x2048, with
//! any annotation sidecar beside them carried along.

use std::collections::HashSet;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Result, bail};
use chrono::{Local, Utc};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};

use crate::bulk_data_sync::BulkDataSyncService;
use crate::camera_annotation::{
    CameraImportDescriptor, CameraImportResult, CameraImportSource, CardAnnotation, NormalizedPoint,
};
use crate::camera_annotation_store::{
    CameraAnnotationStore, file_name, full_path, has_image_extension, move_file, with_suffix, write_atomic,
};
use crate::camera_dataset_sync_service::CameraDatasetSyncService;

pub const MAXIMUM_IMPORTED_SHORT_SIDE: u32 = 1024;
pub const MAXIMUM_IMPORTED_LONG_SIDE: u32 = 2048;
const IMPORTED_JPEG_QUALITY: u8 = 92;

struct NormalizedImage {
    width: u32,
    height: u32,
    source_orientation: u16,
}

pub struct CameraImageImportService {
    store: Arc<CameraAnnotationStore>,
    change_tracker: Option<Arc<CameraDatasetSyncService>>,
}

impl CameraImageImportService {
    pub fn new(store: Arc<CameraAnnotationStore>, change_tracker: Option<Arc<CameraDatasetSyncService>>) -> Self {
        Self { store, change_tracker }
    }

    /// Folders import their whole tree; loose files (photos dropped on the Photo Library) import grouped by their
    /// folder. Blocking: run it off the UI thread.
    pub fn import(&self, source_paths: &[PathBuf], capture_condition: Option<&str>) -> Result<CameraImportResult> {
        let imports_root = self.store.imports_root();
        std::fs::create_dir_all(imports_root)?;
        let batch_id = create_batch_id(imports_root);
        let batch_root = imports_root.join(&batch_id);
        std::fs::create_dir_all(&batch_root)?;

        let mut result = CameraImportResult {
            batch_root: batch_root.clone(),
            imported: 0,
            skipped: 0,
            failed: 0,
            errors: Vec::new(),
        };
        let mut sources = Vec::new();
        let mut used_root_names: HashSet<String> = HashSet::new();

        let mut seen = HashSet::new();
        let full_paths: Vec<PathBuf> = source_paths
            .iter()
            .map(|path| full_path(path))
            .filter(|path| seen.insert(path.to_string_lossy().to_uppercase()))
            .collect();
        let mut roots: Vec<(PathBuf, Option<Vec<PathBuf>>)> =
            full_paths.iter().filter(|path| !path.is_file()).map(|folder| (folder.clone(), None)).collect();
        let mut groups: Vec<(PathBuf, Vec<PathBuf>)> = Vec::new();
        for file in full_paths.iter().filter(|path| path.is_file()) {
            let folder = file.parent().unwrap_or(Path::new("")).to_path_buf();
            let key = folder.to_string_lossy().to_uppercase();
            match groups.iter_mut().find(|(existing, _)| existing.to_string_lossy().to_uppercase() == key) {
                Some((_, files)) => files.push(file.clone()),
                None => groups.push((folder, vec![file.clone()])),
            }
        }
        roots.extend(groups.into_iter().map(|(folder, files)| (folder, Some(files))));

        for (source_folder, loose_files) in roots {
            if !source_folder.is_dir() {
                result.failed += 1;
                result.errors.push(format!("Folder not found: {}", source_folder.display()));
                continue;
            }

            let trimmed = source_folder.to_string_lossy().trim_end_matches(std::path::MAIN_SEPARATOR).to_string();
            let imported_folder = unique_name(&sanitize(&file_name(Path::new(&trimmed))), &used_root_names);
            used_root_names.insert(imported_folder.to_uppercase());
            let source_group = format!("{batch_id}/{imported_folder}");
            sources.push(CameraImportSource {
                source_folder: source_folder.to_string_lossy().into_owned(),
                imported_folder: imported_folder.clone(),
                source_group: source_group.clone(),
            });

            let mut files = match loose_files {
                Some(files) => files,
                None => match walkdir::WalkDir::new(&source_folder)
                    .into_iter()
                    .filter(|entry| entry.as_ref().map_or(true, |entry| entry.file_type().is_file()))
                    .map(|entry| entry.map(walkdir::DirEntry::into_path))
                    .collect::<Result<Vec<_>, _>>()
                {
                    Ok(files) => files,
                    Err(error) => {
                        result.failed += 1;
                        result.errors.push(format!("Could not scan {}: {error}", source_folder.display()));
                        continue;
                    }
                },
            };
            files.sort_by_cached_key(|path| path.to_string_lossy().to_uppercase());

            for source_path in files {
                if !has_image_extension(&source_path) {
                    result.skipped += 1;
                    continue;
                }

                let mut destination_path = None;
                let imported = (|| -> Result<()> {
                    let relative = source_path.strip_prefix(&source_folder).unwrap_or(&source_path);
                    let destination_directory =
                        batch_root.join(&imported_folder).join(relative.parent().unwrap_or(Path::new("")));
                    std::fs::create_dir_all(&destination_directory)?;
                    let destination = resolve_image_collision(&destination_directory, &file_name(&source_path))?;
                    destination_path = Some(destination.clone());
                    let normalized = normalize_image(&source_path, &destination)?;
                    if let Err(error) = self.import_annotation(
                        &source_path,
                        &destination,
                        &normalized,
                        &source_group,
                        capture_condition,
                    ) {
                        result.failed += 1;
                        result.errors.push(format!("Annotation for {}: {error}", source_path.display()));
                    }
                    result.imported += 1;
                    Ok(())
                })();
                // Wider than the C# catch (IOException, UnauthorizedAccess, NotSupported) on purpose: the `image` crate's
                // decode errors are not I/O errors, and one corrupt photo should count as one failure, not end the import.
                if let Err(error) = imported {
                    // Best effort: a leftover that won't delete (locked) must not end the import before its descriptor
                    // is written and the photos already imported are queued for upload.
                    if let Some(destination) = destination_path {
                        let _ = std::fs::remove_file(CameraAnnotationStore::annotation_path_for(&destination));
                        let _ = std::fs::remove_file(&destination);
                    }
                    result.failed += 1;
                    result.errors.push(format!("{}: {error}", source_path.display()));
                }
            }
        }

        let descriptor = CameraImportDescriptor {
            schema_version: 1,
            batch_id,
            created_utc: Utc::now(),
            capture_condition: capture_condition
                .filter(|condition| !condition.trim().is_empty())
                .map(|condition| condition.trim().to_string()),
            sources,
            video: None,
        };
        write_atomic(&batch_root.join(".deckino-import.json"), &descriptor, false)?;
        if let Some(tracker) = &self.change_tracker {
            tracker.track_tree(&batch_root);
        }
        Ok(result)
    }

    /// Where a normalized point lands once the photo is turned upright by its EXIF orientation.
    pub fn transform_point(point: NormalizedPoint, orientation: u16) -> NormalizedPoint {
        let NormalizedPoint { x, y } = point;
        match orientation {
            2 => NormalizedPoint::new(1.0 - x, y),
            3 => NormalizedPoint::new(1.0 - x, 1.0 - y),
            4 => NormalizedPoint::new(x, 1.0 - y),
            5 => NormalizedPoint::new(y, x),
            6 => NormalizedPoint::new(1.0 - y, x),
            7 => NormalizedPoint::new(1.0 - y, 1.0 - x),
            8 => NormalizedPoint::new(y, 1.0 - x),
            _ => point,
        }
    }

    pub fn calculate_imported_dimensions(width: u32, height: u32) -> Result<(u32, u32)> {
        if width == 0 || height == 0 {
            bail!("Specified argument was out of the range of valid values. (Parameter 'width')");
        }
        let (short_side, long_side) = (width.min(height), width.max(height));
        let scale = (MAXIMUM_IMPORTED_SHORT_SIDE as f64 / short_side as f64)
            .min(MAXIMUM_IMPORTED_LONG_SIDE as f64 / long_side as f64)
            .min(1.0);
        Ok((
            ((width as f64 * scale).round_ties_even() as u32).max(1),
            ((height as f64 * scale).round_ties_even() as u32).max(1),
        ))
    }

    fn import_annotation(
        &self,
        source_image: &Path,
        destination_image: &Path,
        normalized: &NormalizedImage,
        source_group: &str,
        capture_condition: Option<&str>,
    ) -> Result<()> {
        let source_annotation_path = CameraAnnotationStore::annotation_path_for(source_image);
        if !source_annotation_path.exists() {
            return Ok(());
        }
        let Some(source) = self.store.try_load(&source_annotation_path) else {
            bail!("The matching annotation is not valid JSON.");
        };
        if file_name(source_image).to_uppercase() != source.image_file.to_uppercase() {
            return Ok(());
        }

        let transform = |point: Option<NormalizedPoint>| {
            point.map(|point| Self::transform_point(point, normalized.source_orientation))
        };
        let imported = CardAnnotation {
            dataset_version: source.dataset_version.clone(),
            card_present: source.card_present,
            top_left: transform(source.top_left),
            top_right: transform(source.top_right),
            bottom_right: transform(source.bottom_right),
            bottom_left: transform(source.bottom_left),
            image_width: normalized.width as i32,
            image_height: normalized.height as i32,
            source_group: if source.source_group.trim().is_empty() {
                source_group.to_string()
            } else {
                source.source_group.clone()
            },
            capture_condition: match &source.capture_condition {
                Some(condition) if !condition.trim().is_empty() => Some(condition.clone()),
                _ => capture_condition.map(str::to_string),
            },
            split: source.split.clone(),
            ..CardAnnotation::new(file_name(destination_image))
        };
        if !CameraAnnotationStore::is_valid(&imported) {
            bail!("The matching annotation has invalid fields.");
        }
        self.store.write_imported(destination_image, &imported)
    }
}

fn normalize_image(source_path: &Path, destination_path: &Path) -> Result<NormalizedImage> {
    let mut decoder = ImageReader::open(source_path)?.with_guessed_format()?.into_decoder()?;
    let orientation = decoder.orientation()?;
    let exif_orientation = orientation.to_exif() as u16;
    // Decoding the whole photo also validates it before anything is copied.
    let mut source = DynamicImage::from_decoder(decoder)?;
    let (source_width, source_height) = (source.width(), source.height());
    let swaps_dimensions = (5..=8).contains(&exif_orientation);
    let (oriented_width, oriented_height) =
        if swaps_dimensions { (source_height, source_width) } else { (source_width, source_height) };
    let (target_width, target_height) =
        CameraImageImportService::calculate_imported_dimensions(oriented_width, oriented_height)?;
    if exif_orientation == 1 && target_width == source_width && target_height == source_height {
        copy_atomic(source_path, destination_path)?;
        return Ok(NormalizedImage { width: source_width, height: source_height, source_orientation: 1 });
    }

    // Re-encoding drops the EXIF orientation, so the stored pixels are upright.
    source.apply_orientation(orientation);
    let output = if (source.width(), source.height()) == (target_width, target_height) {
        source
    } else {
        source.resize_exact(target_width, target_height, FilterType::CatmullRom)
    };
    write_image_atomic(destination_path, &output)?;
    Ok(NormalizedImage { width: target_width, height: target_height, source_orientation: exif_orientation })
}

fn resolve_image_collision(directory: &Path, file_name: &str) -> Result<PathBuf> {
    let path = Path::new(file_name);
    let stem = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
    let extension = path
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    let existing_stems: HashSet<String> = std::fs::read_dir(directory)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| entry.path().file_stem().map(|stem| stem.to_string_lossy().to_uppercase()))
        .collect();
    for suffix in 1.. {
        let candidate_stem = if suffix == 1 { stem.clone() } else { format!("{stem}_{suffix}") };
        if !existing_stems.contains(&candidate_stem.to_uppercase()) {
            return Ok(directory.join(candidate_stem + &extension));
        }
    }
    unreachable!()
}

fn create_batch_id(imports_root: &Path) -> String {
    loop {
        let candidate: String =
            format!("{}-{}", Local::now().format("%Y-%m-%d_%H-%M-%S"), uuid::Uuid::new_v4().simple())
                .chars()
                .take(28)
                .collect();
        if !imports_root.join(&candidate).exists() {
            return candidate;
        }
    }
}

fn sanitize(value: &str) -> String {
    let clean = BulkDataSyncService::sanitize_file_name(value);
    let clean = clean.trim();
    if clean.is_empty() { "camera-photos".into() } else { clean.into() }
}

/// `used` holds upper-case names: two source folders differing only by case would share one imported folder.
fn unique_name(base_name: &str, used: &HashSet<String>) -> String {
    (1..)
        .map(|suffix| if suffix == 1 { base_name.to_string() } else { format!("{base_name}_{suffix}") })
        .find(|candidate| !used.contains(&candidate.to_uppercase()))
        .expect("an unused name")
}

fn copy_atomic(source: &Path, destination: &Path) -> Result<()> {
    let temporary = with_suffix(destination, &format!(".tmp-{}", uuid::Uuid::new_v4().simple()));
    let copied = std::fs::copy(source, &temporary).and_then(|_| move_file(&temporary, destination, false));
    if temporary.exists() {
        let _ = std::fs::remove_file(&temporary);
    }
    Ok(copied?)
}

fn write_image_atomic(destination: &Path, image: &DynamicImage) -> Result<()> {
    let temporary = with_suffix(destination, &format!(".tmp-{}", uuid::Uuid::new_v4().simple()));
    let written = (|| -> Result<()> {
        let is_png = destination.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("png"));
        if is_png {
            image.save_with_format(&temporary, ImageFormat::Png)?;
        } else {
            let mut file = BufWriter::new(std::fs::File::create(&temporary)?);
            JpegEncoder::new_with_quality(&mut file, IMPORTED_JPEG_QUALITY).encode_image(&image.to_rgb8())?;
            // Dropping a BufWriter swallows its last write's error (a full disk): a cut-off JPEG must not land.
            file.flush()?;
        }
        move_file(&temporary, destination, false)?;
        Ok(())
    })();
    if temporary.exists() {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}
