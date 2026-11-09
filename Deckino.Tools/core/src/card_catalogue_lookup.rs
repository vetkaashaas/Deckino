use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rusqlite::{OptionalExtension, named_params};
use serde_json::Value;

use crate::bulk_data_sync::run_blocking;
use crate::card_images::CardImageService;
use crate::db::Database;
use crate::paths::TrainingPaths;

/// `printing_id` is the printing a model matched, when its labels are on this computer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogueCard {
    pub oracle_id: String,
    pub name: String,
    pub art_path: Option<PathBuf>,
    pub printing_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CataloguePrinting {
    pub printing_id: String,
    pub set_code: String,
    pub set_name: Option<String>,
    pub collector_number: String,
    pub art_path: Option<PathBuf>,
}

/// A model's prototypes in order: the printing and face each one was built from.
type PrototypePrintings = Option<Arc<Vec<(Option<String>, i32)>>>;

const ART_FOR_ORACLE: &str = "
    (SELECT i.file_path FROM cards c JOIN card_images i ON i.scryfall_id = c.scryfall_id
     WHERE c.oracle_id = o.oracle_id AND i.status = 'downloaded' ORDER BY c.released_at DESC, i.face_index LIMIT 1)";

/// Card names and cached full-card images for the Identify Card page, from the synced Scryfall catalogue.
/// Image paths are stored relative to the data root and returned absolute.
pub struct CardCatalogueLookup {
    database: Database,
    paths: TrainingPaths,
    prototype_printings: Mutex<HashMap<String, PrototypePrintings>>,
}

impl CardCatalogueLookup {
    pub fn new(database: Database, paths: TrainingPaths) -> Self {
        Self { database, paths, prototype_printings: Mutex::new(HashMap::new()) }
    }

    /// The face of the printing the model matched (its prototype) when that model's labels are on this computer,
    /// else the newest printing's front.
    pub async fn find(
        &self,
        oracle_id: &str,
        model_version: Option<&str>,
        prototype: Option<i32>,
    ) -> Result<Option<CatalogueCard>> {
        let (printing, face) = self.prototype(model_version, prototype)?;
        let connection = self.database.open()?;
        let card = connection
            .query_row(
                &format!(
                    "SELECT o.oracle_id AS OracleId, o.name AS Name,
                       COALESCE((SELECT file_path FROM card_images WHERE scryfall_id = $printing AND status = 'downloaded'
                                 ORDER BY face_index = $face DESC, face_index LIMIT 1),
                                {ART_FOR_ORACLE}) AS ArtPath,
                       $printing AS PrintingId
                    FROM oracle_cards o WHERE o.oracle_id = $oracleId"
                ),
                named_params! {"$oracleId": oracle_id, "$printing": printing, "$face": face},
                |row| {
                    Ok(CatalogueCard {
                        oracle_id: row.get(0)?,
                        name: row.get(1)?,
                        art_path: row.get::<_, Option<String>>(2)?.map(|path| self.absolute(&path)),
                        printing_id: row.get(3)?,
                    })
                },
            )
            .optional()?;
        Ok(card)
    }

    pub async fn search(&self, text: &str) -> Result<Vec<CatalogueCard>> {
        let text = text.trim();
        // C# string.Length: UTF-16 code units.
        if text.encode_utf16().count() < 2 {
            return Ok(Vec::new());
        }
        let pattern = format!("%{}%", text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let connection = self.database.open()?;
        let mut statement = connection.prepare(&format!(
            "SELECT o.oracle_id AS OracleId, o.name AS Name, {ART_FOR_ORACLE} AS ArtPath, NULL AS PrintingId
            FROM oracle_cards o WHERE o.name LIKE $pattern ESCAPE '\\'
            ORDER BY lower(o.name) = lower($text) DESC, length(o.name), o.name LIMIT 24"
        ))?;
        let cards = statement
            .query_map(named_params! {"$pattern": pattern, "$text": text}, |row| {
                Ok(CatalogueCard {
                    oracle_id: row.get(0)?,
                    name: row.get(1)?,
                    art_path: row.get::<_, Option<String>>(2)?.map(|path| self.absolute(&path)),
                    printing_id: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(cards)
    }

    /// Every paper printing of a card, newest first, for picking the exact one in a photo.
    pub async fn printings(&self, oracle_id: &str) -> Result<Vec<CataloguePrinting>> {
        let connection = self.database.open()?;
        let mut statement = connection.prepare(
            "SELECT c.scryfall_id AS PrintingId, c.set_code AS SetCode, s.name AS SetName,
                   c.collector_number AS CollectorNumber,
                   (SELECT file_path FROM card_images WHERE scryfall_id = c.scryfall_id AND status = 'downloaded'
                    ORDER BY face_index LIMIT 1) AS ArtPath
            FROM cards c LEFT JOIN sets s ON s.code = c.set_code
            WHERE c.oracle_id = $oracleId AND c.is_paper = 1
            ORDER BY c.released_at DESC, c.set_code, length(c.collector_number), c.collector_number",
        )?;
        let printings = statement
            .query_map(named_params! {"$oracleId": oracle_id}, |row| {
                Ok(CataloguePrinting {
                    printing_id: row.get(0)?,
                    set_code: row.get(1)?,
                    set_name: row.get(2)?,
                    collector_number: row.get(3)?,
                    art_path: row.get::<_, Option<String>>(4)?.map(|path| self.absolute(&path)),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(printings)
    }

    /// The printing behind a model's prototype, when that model's labels are on this computer.
    pub async fn printing_for_prototype(
        &self,
        model_version: Option<&str>,
        prototype: Option<i32>,
    ) -> Result<Option<String>> {
        Ok(self.prototype(model_version, prototype)?.0)
    }

    // The printing and face behind a model's prototype. Models from before per-face references name no face,
    // which reads as the front.
    fn prototype(&self, model_version: Option<&str>, prototype: Option<i32>) -> Result<(Option<String>, i32)> {
        // The first call per model parses a multi-MB labels.json, so keep it off the caller's async worker.
        let printings = match model_version {
            Some(model_version) => run_blocking(|| self.prototype_printings(model_version))?,
            None => None,
        };
        Ok(match (prototype, printings) {
            (Some(index), Some(printings)) if index >= 0 && (index as usize) < printings.len() => {
                printings[index as usize].clone()
            }
            _ => (None, 0),
        })
    }

    fn absolute(&self, relative_path: &str) -> PathBuf {
        CardImageService::absolute_path(&self.paths.data_root, relative_path)
    }

    /// Reprints that reuse an illustration look the same to the artwork model, so a guess of either is right.
    pub async fn same_artwork(&self, printing_id: &str, other_printing_id: &str) -> Result<bool> {
        if printing_id.to_lowercase() == other_printing_id.to_lowercase() {
            return Ok(true);
        }
        let connection = self.database.open()?;
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM cards a JOIN cards b ON b.illustration_id = a.illustration_id
            WHERE a.scryfall_id = $printingId AND b.scryfall_id = $otherPrintingId AND a.illustration_id IS NOT NULL",
            named_params! {"$printingId": printing_id, "$otherPrintingId": other_printing_id},
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    fn prototype_printings(&self, model_version: &str) -> Result<PrototypePrintings> {
        let mut cache = self.prototype_printings.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = cache.get(model_version) {
            return Ok(cached.clone());
        }
        let path = self.paths.mobile_artwork_root.join(model_version).join("labels.json");
        let mut printings = None;
        if path.is_file() {
            let document: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
            let prototypes = document
                .get("prototypes")
                .and_then(Value::as_array)
                .with_context(|| format!("{} has no prototypes list.", path.display()))?;
            let mut list = Vec::with_capacity(prototypes.len());
            for item in prototypes {
                let printing = match item.get("printing_id") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(id)) => Some(id.clone()),
                    Some(_) => anyhow::bail!("{}: a prototype's printing_id is not a string.", path.display()),
                };
                let face = item.get("face_index").and_then(Value::as_i64).map_or(0, |face| face as i32);
                list.push((printing, face));
            }
            printings = Some(Arc::new(list));
        }
        cache.insert(model_version.to_string(), printings.clone());
        Ok(printings)
    }
}
