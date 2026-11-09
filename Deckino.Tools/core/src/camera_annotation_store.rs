//! CameraAnnotationStore.cs: the camera photo library on disk, its annotation and identity sidecars, and the
//! thumbnail cache.

use std::collections::{HashMap, HashSet};
use std::io::{self, BufReader, Cursor};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use image::ImageReader;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use serde::Serialize;
use serde::de::DeserializeOwned;
use sha1::{Digest, Sha1};

use crate::camera_annotation::{
    CameraDeleteResult, CameraImportDescriptor, CameraPhoto, CardAnnotation, CardIdentity, CardIdentityStatus,
};
use crate::camera_dataset_sync_service::CameraDatasetSyncService;
use crate::paths::TrainingPaths;

pub const DEFAULT_THUMBNAIL_SIZE: u32 = 320;
// System.Drawing's default JPEG quality.
const THUMBNAIL_JPEG_QUALITY: u8 = 75;
const IMAGE_EXTENSIONS: [&str; 3] = ["jpg", "jpeg", "png"];
// DateTime ticks (100 ns since 0001-01-01) at the Unix epoch.
const UNIX_EPOCH_TICKS: i64 = 621_355_968_000_000_000;

/// (Valid, SourceGroup, CaptureCondition) of an annotation sidecar.
type AnnotationSummary = (bool, Option<String>, Option<String>);

pub struct CameraAnnotationStore {
    paths: TrainingPaths,
    change_tracker: Option<Arc<CameraDatasetSyncService>>,
    // Dimensions and annotation summaries, keyed by path + size + write time so a rescan only reads changed files.
    // ponytail: entries for replaced or deleted files are never evicted; fine for tens of thousands of photos.
    dimensions: Mutex<HashMap<String, (u32, u32)>>,
    annotations: Mutex<HashMap<String, AnnotationSummary>>,
}

/// One file of the imports tree, with the size and write time the directory walk already read.
struct ScannedFile {
    path: PathBuf,
    length: u64,
    modified: SystemTime,
}

impl CameraAnnotationStore {
    pub const CORNER_ORDER: [&'static str; 4] = ["TopLeft", "TopRight", "BottomRight", "BottomLeft"];
    /// Each point is the intersection of the two straight card edges (rounded corners ignored).
    pub const CORNER_CONVENTION: &'static str = "edge-intersection-v1";

    pub fn new(paths: TrainingPaths, change_tracker: Option<Arc<CameraDatasetSyncService>>) -> Self {
        Self { paths, change_tracker, dimensions: Mutex::default(), annotations: Mutex::default() }
    }

    pub fn imports_root(&self) -> &Path {
        &self.paths.camera_imports_root
    }

    /// Outside the imports root so dataset sync never sees the cache.
    pub fn thumbnails_root(&self) -> PathBuf {
        self.paths.camera_root.join("thumbnails")
    }

    /// A small JPEG of the photo, cached on disk. The key includes size and write time, so a replaced photo
    /// gets a fresh thumbnail.
    // ponytail: thumbnails of deleted photos stay in the cache; prune thumbnails_root if it ever grows large.
    pub fn load_thumbnail(&self, image_path: &Path, max_size: u32) -> Result<Vec<u8>> {
        let cache_path = self.thumbnail_cache_path(image_path, max_size)?;
        if cache_path.is_file() {
            return Ok(std::fs::read(&cache_path)?);
        }

        // Rust opens files sharing delete, so the photo itself can be deleted or moved while its thumbnail is being
        // made (not its folder: Windows won't move a folder with a file open in it).
        let file = std::fs::File::open(image_path)?;
        let source = ImageReader::new(BufReader::new(file)).with_guessed_format()?.decode()?;
        let scale = (max_size as f64 / source.width().max(source.height()) as f64).min(1.0);
        let width = ((source.width() as f64 * scale).round_ties_even() as u32).max(1);
        let height = ((source.height() as f64 * scale).round_ties_even() as u32).max(1);
        let thumbnail = source.resize_exact(width, height, FilterType::Triangle).to_rgb8();
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(Cursor::new(&mut bytes), THUMBNAIL_JPEG_QUALITY).encode_image(&thumbnail)?;

        // The cache is best effort; the thumbnail is still shown.
        let _ = (|| -> io::Result<()> {
            std::fs::create_dir_all(cache_path.parent().expect("cache file has a folder"))?;
            let temporary = with_suffix(&cache_path, &format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
            std::fs::write(&temporary, &bytes)?;
            std::fs::rename(&temporary, &cache_path)?;
            // Moved or deleted meanwhile: nothing would show this entry.
            if !image_path.exists() {
                std::fs::remove_file(&cache_path)?;
            }
            Ok(())
        })();
        Ok(bytes)
    }

    /// Makes sure the thumbnail is in the disk cache without reading it back when it already is.
    pub fn warm_thumbnail(&self, image_path: &Path, max_size: u32) -> Result<()> {
        if !self.thumbnail_cache_path(image_path, max_size)?.is_file() {
            self.load_thumbnail(image_path, max_size)?;
        }
        Ok(())
    }

    fn thumbnail_cache_path(&self, image_path: &Path, max_size: u32) -> Result<PathBuf> {
        let metadata = std::fs::metadata(image_path)?;
        Ok(self.thumbnail_cache_path_of(&full_path(image_path), &metadata, max_size))
    }

    fn thumbnail_cache_path_of(&self, full_path: &Path, metadata: &std::fs::Metadata, max_size: u32) -> PathBuf {
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        let text =
            format!("{}|{}|{}|{max_size}", full_path.to_string_lossy().to_uppercase(), metadata.len(), ticks(modified));
        let key = hex::encode_upper(Sha1::digest(text.as_bytes()));
        self.thumbnails_root().join(&key[..2]).join(format!("{key}.jpg"))
    }

    pub fn annotation_path_for(image_path: &Path) -> PathBuf {
        sidecar_path(image_path, "._annotations.json")
    }

    pub fn identity_path_for(image_path: &Path) -> PathBuf {
        sidecar_path(image_path, "._identity.json")
    }

    /// Every photo below the imports root, by path, and how many image files could not be read (corrupt, locked, or
    /// removed mid-scan).
    pub fn scan_photos(&self) -> Result<(Vec<CameraPhoto>, usize)> {
        let imports_root = self.imports_root();
        if !imports_root.is_dir() {
            return Ok((Vec::new(), 0));
        }

        // One directory walk; its entries already carry size and write time, so no per-file stat calls follow.
        let mut all = Vec::new();
        for entry in walkdir::WalkDir::new(imports_root) {
            // A folder or file removed mid-walk must not hide the rest of the library either.
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_file() {
                continue;
            }
            let Ok(metadata) = entry.metadata() else { continue };
            all.push(ScannedFile {
                path: full_path(entry.path()),
                length: metadata.len(),
                modified: metadata.modified().unwrap_or(UNIX_EPOCH),
            });
        }
        // Only for finding each photo's annotation; first wins because a case-sensitive folder can hold names that
        // differ by case.
        let mut files: HashMap<String, &ScannedFile> = HashMap::new();
        for file in &all {
            files.entry(upper(&file.path)).or_insert(file);
        }
        let descriptors = load_descriptors(&all);
        let mut images: Vec<&ScannedFile> = all.iter().filter(|file| has_image_extension(&file.path)).collect();
        images.sort_by_cached_key(|file| upper(&file.path));

        let threads = std::thread::available_parallelism().map_or(4, |count| count.get());
        let chunk = images.len().div_ceil(threads).max(1);
        let scanned: Vec<Option<CameraPhoto>> = std::thread::scope(|scope| {
            let workers: Vec<_> = images
                .chunks(chunk)
                .map(|images| {
                    let (files, descriptors) = (&files, &descriptors);
                    scope.spawn(move || {
                        images.iter().map(|image| self.scan_photo(image, files, descriptors)).collect::<Vec<_>>()
                    })
                })
                .collect();
            workers.into_iter().flat_map(|worker| worker.join().expect("scan worker panicked")).collect()
        });
        let total = scanned.len();
        let photos: Vec<CameraPhoto> = scanned.into_iter().flatten().collect();
        let skipped = total - photos.len();
        Ok((photos, skipped))
    }

    // None: a corrupt or concurrently removed image must not hide the rest of the library.
    fn scan_photo(
        &self,
        image: &ScannedFile,
        files: &HashMap<String, &ScannedFile>,
        descriptors: &[(String, CameraImportDescriptor)],
    ) -> Option<CameraPhoto> {
        let image_path = &image.path;
        let annotation_path = Self::annotation_path_for(image_path);
        let annotation_file = files.get(&upper(&annotation_path));
        let (valid, source_group, capture_condition) =
            annotation_file.map(|file| self.summarize_annotation(file)).unwrap_or_default();
        let stamp = stamp_of(image);
        let cached = self.dimensions.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&stamp).copied();
        let (width, height) = match cached {
            Some(dimensions) => dimensions,
            None => {
                let dimensions = Self::read_dimensions(image_path).ok()?;
                self.dimensions.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(stamp, dimensions);
                dimensions
            }
        };
        let upper_image = upper(image_path);
        let descriptor = find_descriptor(&upper_image, descriptors);
        Some(CameraPhoto {
            image_path: image_path.clone(),
            relative_path: image_path
                .strip_prefix(full_path(self.imports_root()))
                .unwrap_or(image_path)
                .to_string_lossy()
                .into_owned(),
            annotation_path,
            source_group: match source_group {
                Some(group) if !group.trim().is_empty() => group,
                _ => resolve_source_group(&upper_image, descriptor),
            },
            capture_condition: capture_condition.or_else(|| descriptor.and_then(|d| d.capture_condition.clone())),
            image_width: width,
            image_height: height,
            is_annotated: valid,
            has_invalid_annotation: annotation_file.is_some() && !valid,
            modified_utc: DateTime::<Utc>::from(image.modified),
            file_length: image.length,
        })
    }

    fn summarize_annotation(&self, file: &ScannedFile) -> AnnotationSummary {
        let stamp = stamp_of(file);
        if let Some(cached) = self.annotations.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&stamp) {
            return cached.clone();
        }
        let Ok(loaded) = deserialize::<CardAnnotation>(&file.path) else {
            // Locked or just removed: report it as unreadable this time, but read it again on the next scan.
            return (false, None, None);
        };
        let summary = match loaded {
            Some(annotation) => {
                (Self::is_valid(&annotation), Some(annotation.source_group), annotation.capture_condition)
            }
            None => (false, None, None),
        };
        self.annotations.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(stamp, summary.clone());
        summary
    }

    pub fn try_load(&self, annotation_path: &Path) -> Option<CardAnnotation> {
        deserialize(annotation_path).ok().flatten()
    }

    pub fn save_new(&self, image_path: &Path, annotation: &CardAnnotation) -> Result<()> {
        let path = Self::annotation_path_for(image_path);
        if path.exists() {
            bail!("An annotation already exists for {}.", file_name(image_path));
        }
        write_atomic(&path, annotation, false)?;
        self.track_upload(&path);
        Ok(())
    }

    pub fn update_existing(&self, image_path: &Path, annotation: &CardAnnotation) -> Result<()> {
        let path = Self::annotation_path_for(image_path);
        if !path.exists() {
            bail!("The annotation for {} no longer exists.", file_name(image_path));
        }
        write_atomic(&path, annotation, true)?;
        self.track_upload(&path);
        Ok(())
    }

    pub fn try_load_identity(&self, image_path: &Path) -> Option<CardIdentity> {
        let path = Self::identity_path_for(image_path);
        if !path.exists() {
            return None;
        }
        deserialize::<CardIdentity>(&path).ok().flatten().filter(Self::is_valid_identity)
    }

    pub fn save_identity(&self, image_path: &Path, identity: &CardIdentity) -> Result<()> {
        if !Self::is_valid_identity(identity) {
            bail!("The card identity has invalid fields.");
        }
        let path = Self::identity_path_for(image_path);
        write_atomic(&path, identity, true)?;
        self.track_upload(&path);
        Ok(())
    }

    pub fn is_valid_identity(identity: &CardIdentity) -> bool {
        let is_guid = |value: Option<&String>| value.is_some_and(|value| uuid::Uuid::parse_str(value).is_ok());
        !identity.image_file.trim().is_empty()
            && CardIdentityStatus::ALL.contains(&identity.status.as_str())
            && (!matches!(identity.status.as_str(), CardIdentityStatus::CONFIRMED | CardIdentityStatus::CORRECTED)
                || is_guid(identity.oracle_id.as_ref()))
            && (identity.printing_id.is_none() || is_guid(identity.printing_id.as_ref()))
            && identity.predicted_corners.as_ref().is_none_or(|corners| {
                corners.len() == 4 && corners.iter().all(|p| (0.0..=1.0).contains(&p.x) && (0.0..=1.0).contains(&p.y))
            })
    }

    /// Not tracked here: the import tracks its whole batch once it is written (a recount per sidecar walks the library).
    pub fn write_imported(&self, image_path: &Path, annotation: &CardAnnotation) -> Result<()> {
        write_atomic(&Self::annotation_path_for(image_path), annotation, true)
    }

    /// Photos in a frozen artwork benchmark, as upper-case full paths. Deleting one would leave every later model
    /// unscorable on that benchmark.
    pub fn benchmark_photo_paths(&self) -> Result<HashSet<String>> {
        let mut protected_paths = HashSet::new();
        let benchmarks_root = self.paths.benchmarks_root();
        if !benchmarks_root.is_dir() {
            return Ok(protected_paths);
        }
        for entry in std::fs::read_dir(&benchmarks_root)? {
            let file = entry?.path();
            let name = file_name(&file).to_lowercase();
            if !(file.is_file() && name.starts_with("artwork-") && name.ends_with(".json")) {
                continue;
            }
            let document: serde_json::Value = serde_json::from_slice(strip_bom(&std::fs::read(&file)?))?;
            let photos = document
                .get("photos")
                .and_then(|photos| photos.as_array())
                .with_context(|| format!("{} has no photos.", file.display()))?;
            for photo in photos {
                let relative = photo
                    .get("photo")
                    .and_then(|photo| photo.as_str())
                    .with_context(|| format!("A photo in {} has no path.", file.display()))?;
                protected_paths.insert(upper(&full_path(&self.imports_root().join(relative))));
            }
        }
        Ok(protected_paths)
    }

    /// The identity sidecar (card label) goes with the photo, or on its own with `delete_identities` so the photo
    /// returns to Identify Card as well as the Corner Annotator.
    pub fn delete_files(
        &self,
        photos: &[CameraPhoto],
        delete_photos: bool,
        delete_identities: bool,
    ) -> Result<CameraDeleteResult> {
        let mut result =
            CameraDeleteResult { deleted_photos: 0, deleted_annotations: 0, errors: Vec::new(), deleted_identities: 0 };
        let delete_identities = delete_identities || delete_photos;
        // A benchmark scores its photos against their labels, so those stay too.
        let benchmarked = if delete_identities { self.benchmark_photo_paths()? } else { HashSet::new() };
        for photo in photos {
            if benchmarked.contains(&upper(&full_path(&photo.image_path))) {
                result.errors.push(format!("{}: kept, it is in a frozen model benchmark.", photo.relative_path));
                continue;
            }
            let deleted = (|| -> io::Result<()> {
                if photo.annotation_path.exists() {
                    std::fs::remove_file(&photo.annotation_path)?;
                    self.track_deletion(&photo.annotation_path);
                    result.deleted_annotations += 1;
                }
                let identity_path = photo.identity_path();
                if delete_identities && identity_path.exists() {
                    std::fs::remove_file(&identity_path)?;
                    self.track_deletion(&identity_path);
                    result.deleted_identities += 1;
                }
                if delete_photos && photo.image_path.exists() {
                    std::fs::remove_file(&photo.image_path)?;
                    self.track_deletion(&photo.image_path);
                    result.deleted_photos += 1;
                }
                Ok(())
            })();
            if let Err(error) = deleted {
                result.errors.push(format!("{}: {error}", photo.relative_path));
            }
        }
        Ok(result)
    }

    pub fn is_valid(annotation: &CardAnnotation) -> bool {
        if annotation.image_width <= 0 || annotation.image_height <= 0 || annotation.image_file.trim().is_empty() {
            return false;
        }
        if !annotation.card_present {
            return annotation.points().iter().all(Option::is_none);
        }
        annotation
            .points()
            .iter()
            .all(|point| point.is_some_and(|point| (0.0..=1.0).contains(&point.x) && (0.0..=1.0).contains(&point.y)))
    }

    /// Reads only the header instead of decoding the whole photo.
    pub fn read_dimensions(image_path: &Path) -> Result<(u32, u32)> {
        Ok(ImageReader::open(image_path)?.with_guessed_format()?.into_dimensions()?)
    }

    fn track_upload(&self, path: &Path) {
        if let Some(tracker) = &self.change_tracker {
            tracker.track_upload(path);
        }
    }

    fn track_deletion(&self, path: &Path) {
        if let Some(tracker) = &self.change_tracker {
            tracker.track_deletion(path);
        }
    }
}

/// CameraPhotoQueue.OrderByQueue: oldest (or newest) file time first, then by relative path.
// ponytail: "newest" is the local file time, so on a fresh clone it is the sync download order.
pub fn order_by_queue(photos: &mut [CameraPhoto], newest_first: bool) {
    order_by_queue_by(photos, |photo| photo, newest_first);
}

pub fn order_by_queue_by<T>(items: &mut [T], photo: impl Fn(&T) -> &CameraPhoto, newest_first: bool) {
    let path = |item: &T| photo(item).relative_path.to_uppercase();
    if newest_first {
        items.sort_by_cached_key(|item| (std::cmp::Reverse(photo(item).modified_utc), path(item)));
    } else {
        items.sort_by_cached_key(|item| (photo(item).modified_utc, path(item)));
    }
}

/// Pretty JSON through a temporary file, so a reader never sees half a sidecar. `overwrite: false` fails when the
/// file already exists.
pub fn write_atomic<T: Serialize + ?Sized>(path: &Path, value: &T, overwrite: bool) -> Result<()> {
    std::fs::create_dir_all(path.parent().context("The path has no folder.")?)?;
    let temporary = with_suffix(path, &format!(".tmp-{}", uuid::Uuid::new_v4().simple()));
    let written = std::fs::write(&temporary, serde_json::to_vec_pretty(value)?)
        .and_then(|()| move_file(&temporary, path, overwrite));
    if temporary.exists() {
        let _ = std::fs::remove_file(&temporary);
    }
    Ok(written?)
}

/// File.Move(from, to, overwrite). Windows' rename always replaces, so `overwrite: false` links the new name first:
/// that fails atomically when the file appeared meanwhile.
pub(crate) fn move_file(from: &Path, to: &Path, overwrite: bool) -> io::Result<()> {
    if overwrite {
        return std::fs::rename(from, to);
    }
    let exists =
        || io::Error::new(io::ErrorKind::AlreadyExists, format!("The file '{}' already exists.", to.display()));
    match std::fs::hard_link(from, to) {
        // Moved: a source that won't delete now is the callers' leftover temporary file, which they remove.
        Ok(()) => {
            let _ = std::fs::remove_file(from);
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(exists()),
        // ponytail: FAT/exFAT has no hard links; check-then-rename there (racy, as the coordinator serializes writers).
        Err(_) if !to.exists() => std::fs::rename(from, to),
        Err(_) => Err(exists()),
    }
}

/// `path` with `suffix` appended to its file name.
pub(crate) fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut text = path.as_os_str().to_owned();
    text.push(suffix);
    PathBuf::from(text)
}

/// Path.GetFullPath.
pub(crate) fn full_path(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

pub(crate) fn file_name(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
}

pub(crate) fn has_image_extension(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| IMAGE_EXTENSIONS.contains(&extension.to_string_lossy().to_lowercase().as_str()))
}

/// File.ReadAllText drops a UTF-8 byte order mark; serde_json does not.
pub(crate) fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)
}

/// Ok(None) for unreadable JSON; a read failure is an Err, since a locked file may read fine later.
fn deserialize<T: DeserializeOwned>(path: &Path) -> io::Result<Option<T>> {
    let bytes = std::fs::read(path)?;
    Ok(serde_json::from_slice(strip_bom(&bytes)).ok())
}

fn sidecar_path(image_path: &Path, suffix: &str) -> PathBuf {
    let stem = image_path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
    image_path.parent().unwrap_or(Path::new("")).join(stem + suffix)
}

/// Windows paths compare case-insensitively.
fn upper(path: &Path) -> String {
    path.to_string_lossy().to_uppercase()
}

/// DateTime.Ticks of a file time.
pub(crate) fn ticks(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(since) => UNIX_EPOCH_TICKS + (since.as_nanos() / 100) as i64,
        Err(before) => UNIX_EPOCH_TICKS - (before.duration().as_nanos() / 100) as i64,
    }
}

fn stamp_of(file: &ScannedFile) -> String {
    format!("{}|{}|{}", upper(&file.path), file.length, ticks(file.modified))
}

/// The import descriptors in the tree, deepest folder first, each with its folder as an upper-case full path ending
/// in a separator (the scanned paths are already full).
fn load_descriptors(files: &[ScannedFile]) -> Vec<(String, CameraImportDescriptor)> {
    let mut descriptors: Vec<(String, CameraImportDescriptor)> = files
        .iter()
        .filter(|file| file_name(&file.path).eq_ignore_ascii_case(".deckino-import.json"))
        .filter_map(|file| {
            let descriptor = deserialize::<CameraImportDescriptor>(&file.path).ok().flatten()?;
            Some((upper(file.path.parent()?) + std::path::MAIN_SEPARATOR_STR, descriptor))
        })
        .collect();
    descriptors.sort_by_key(|(root, _)| std::cmp::Reverse(root.len()));
    descriptors
}

/// `image`: the photo's upper-case full path.
fn find_descriptor<'a>(
    image: &str,
    descriptors: &'a [(String, CameraImportDescriptor)],
) -> Option<&'a CameraImportDescriptor> {
    descriptors.iter().find(|(root, _)| image.starts_with(root.as_str())).map(|(_, descriptor)| descriptor)
}

/// `image`: the photo's upper-case full path.
fn resolve_source_group(image: &str, descriptor: Option<&CameraImportDescriptor>) -> String {
    let Some(descriptor) = descriptor else {
        return String::new();
    };
    let separator = std::path::MAIN_SEPARATOR_STR;
    descriptor
        .sources
        .iter()
        .find(|source| image.contains(&format!("{separator}{}{separator}", source.imported_folder.to_uppercase())))
        .map_or_else(|| descriptor.batch_id.clone(), |source| source.source_group.clone())
}
