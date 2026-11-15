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

/// A card name ready for search: its oracle id, the name, and the name's normalized words, alone and joined.
type SearchName = (String, String, Vec<String>, String);

// `+i.status` keeps SQLite off the status index: walking every downloaded image took ~35 ms per card; going through
// the card's own printings takes well under one.
const ART_FOR_ORACLE: &str = "
    (SELECT i.file_path FROM cards c JOIN card_images i ON i.scryfall_id = c.scryfall_id
     WHERE c.oracle_id = o.oracle_id AND +i.status = 'downloaded' ORDER BY c.released_at DESC, i.face_index LIMIT 1)";

/// Card names and cached full-card images for the Identify Card page, from the synced Scryfall catalogue.
/// Image paths are stored relative to the data root and returned absolute.
pub struct CardCatalogueLookup {
    database: Database,
    paths: TrainingPaths,
    prototype_printings: Mutex<HashMap<String, PrototypePrintings>>,
    /// Every searchable name, normalized once, with the catalogue's card count it was read at.
    search_names: Mutex<Option<(i64, Arc<Vec<SearchName>>)>>,
}

impl CardCatalogueLookup {
    pub fn new(database: Database, paths: TrainingPaths) -> Self {
        Self { database, paths, prototype_printings: Mutex::new(HashMap::new()), search_names: Mutex::new(None) }
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

    /// Cards whose name matches what can be read of a title: every word anywhere in the name, in any order,
    /// ignoring case, accents and punctuation, with a misread letter or two in longer words.
    pub async fn search(&self, text: &str) -> Result<Vec<CatalogueCard>> {
        let query = normalized_words(text);
        if query.concat().chars().count() < 2 {
            return Ok(Vec::new());
        }
        let connection = self.database.open()?;
        let names = self.search_names(&connection)?;
        // ponytail: scores every name (~35k) per search, a few ms; an index if the catalogue grows far beyond that.
        let mut ranked: Vec<(i32, &str, &str)> = names
            .iter()
            .filter_map(|(oracle_id, name, words, joined)| {
                match_score(&query, words, joined).map(|score| (score, oracle_id.as_str(), name.as_str()))
            })
            .collect();
        ranked.sort_by(|a, b| b.0.cmp(&a.0).then(a.2.len().cmp(&b.2.len())).then(a.2.cmp(b.2)));
        let mut art = connection.prepare(&format!(
            "SELECT {ART_FOR_ORACLE} FROM oracle_cards o WHERE o.oracle_id = $oracleId"
        ))?;
        ranked
            .into_iter()
            .take(24)
            .map(|(_, oracle_id, name)| {
                let art_path = art
                    .query_row(named_params! {"$oracleId": oracle_id}, |row| row.get::<_, Option<String>>(0))?
                    .map(|path| self.absolute(&path));
                Ok(CatalogueCard { oracle_id: oracle_id.into(), name: name.into(), art_path, printing_id: None })
            })
            .collect()
    }

    /// Read again only when the catalogue's card count changes (a Scryfall sync), not per keystroke.
    fn search_names(&self, connection: &rusqlite::Connection) -> Result<Arc<Vec<SearchName>>> {
        let count: i64 = connection.query_row("SELECT COUNT(*) FROM oracle_cards", [], |row| row.get(0))?;
        let mut cached = self.search_names.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cached_count, names)) = cached.as_ref()
            && *cached_count == count
        {
            return Ok(names.clone());
        }
        // Art Series cards repeat a real card's name and art: picking one mislabels the photo.
        let names: Vec<SearchName> = connection
            .prepare(
                "SELECT o.oracle_id, o.name FROM oracle_cards o
                WHERE EXISTS (SELECT 1 FROM cards c WHERE c.oracle_id = o.oracle_id AND c.layout IS NOT 'art_series')",
            )?
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .map(|row| {
                row.map(|(oracle_id, name)| {
                    let words = normalized_words(&name);
                    let joined = words.join(" ");
                    (oracle_id, name, words, joined)
                })
            })
            .collect::<rusqlite::Result<_>>()?;
        let names = Arc::new(names);
        *cached = Some((count, names.clone()));
        Ok(names)
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

/// Lowercase words without accents or punctuation: "Thrór's Map" is "thrors map", "Battle-Scarred" "battle scarred".
fn normalized_words(text: &str) -> Vec<String> {
    let mut folded = String::with_capacity(text.len());
    for c in text.chars().flat_map(char::to_lowercase) {
        match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => folded.push('a'),
            'è' | 'é' | 'ê' | 'ë' => folded.push('e'),
            'ì' | 'í' | 'î' | 'ï' => folded.push('i'),
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' => folded.push('o'),
            'ù' | 'ú' | 'û' | 'ü' => folded.push('u'),
            'ñ' => folded.push('n'),
            'ç' => folded.push('c'),
            'æ' => folded.push_str("ae"),
            '\'' | '’' => {}
            c if c.is_alphanumeric() => folded.push(c),
            _ => folded.push(' '),
        }
    }
    folded.split_whitespace().map(str::to_string).collect()
}

/// How well a name matches the query's words, or None when a word matches nowhere. Per word: the start of a name
/// word beats anywhere in the name, which beats a near miss (a misread letter in a word of four or more, two from
/// seven). The whole name, or its start, matching outranks any of that.
fn match_score(query: &[String], words: &[String], joined: &str) -> Option<i32> {
    let mut score = 0;
    for word in query {
        score += if words.iter().any(|name_word| name_word.starts_with(word.as_str())) {
            3
        } else if joined.contains(word.as_str()) {
            2
        } else {
            // Bytes, not chars: names are folded to ASCII letters above, bar a rare non-Latin one.
            let length = word.len();
            let allowed = match length {
                0..=3 => return None,
                4..=6 => 1,
                _ => 2,
            };
            // A name word, or as much of it as was typed: "forbod" is a misread start of "foreboding".
            let near = words.iter().any(|name_word| {
                let name_word = name_word.as_bytes();
                within(word.as_bytes(), name_word, allowed)
                    || (name_word.len() > length && within(word.as_bytes(), &name_word[..length], allowed))
            });
            if !near {
                return None;
            }
            1
        };
    }
    let query = query.join(" ");
    Some(if joined == query { score + 100 } else if joined.starts_with(&query) { score + 10 } else { score })
}

/// Whether `a` becomes `b` in at most `allowed` single-letter edits. Lengths further apart can't, and a row whose
/// best is already over stops the rest: most of the catalogue's words are ruled out after a letter or two.
fn within(a: &[u8], b: &[u8], allowed: usize) -> bool {
    if a.len().abs_diff(b.len()) > allowed || b.len() >= 64 {
        return false;
    }
    let mut row = [0usize; 64];
    for (j, cell) in row.iter_mut().enumerate().take(b.len() + 1) {
        *cell = j;
    }
    for (i, &ca) in a.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        let mut best = row[0];
        for (j, &cb) in b.iter().enumerate() {
            let substituted = diagonal + usize::from(ca != cb);
            diagonal = row[j + 1];
            row[j + 1] = substituted.min(row[j] + 1).min(diagonal + 1);
            best = best.min(row[j + 1]);
        }
        if best > allowed {
            return false;
        }
    }
    row[b.len()] <= allowed
}
