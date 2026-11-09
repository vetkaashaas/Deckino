//! ScryfallClient and the Scryfall JSON it reads (ScryfallClient.cs, ScryfallDtos.cs).

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, Instant};

use anyhow::Result;
use reqwest::header::{ACCEPT, HeaderMap, HeaderValue};
use reqwest::{Response, Url};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::error::Cancelled;

/// HttpClient's default timeout, which ends a request that has not answered (its headers) in time.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(100);

/// A request that got no answer within HttpClient's 100 seconds (a TaskCanceledException in the C# Toolbox).
#[derive(Debug)]
pub struct RequestTimedOut;

impl std::fmt::Display for RequestTimedOut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The request was canceled due to the configured HttpClient.Timeout of 100 seconds elapsing.")
    }
}

impl std::error::Error for RequestTimedOut {}

pub struct ScryfallClient {
    http: reqwest::Client,
    rate_gate: RateLimiter,
}

impl ScryfallClient {
    pub fn new(request_interval_ms: u64) -> Self {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        let http = reqwest::Client::builder()
            .user_agent("Deckino.Tools/0.1")
            .default_headers(headers)
            // Bodies arrive as served (HttpClientHandler decompresses nothing): the bulk files are gzip, read as such.
            .no_gzip()
            .build()
            .expect("the HTTP client builds");
        Self { http, rate_gate: RateLimiter::new(request_interval_ms as i64) }
    }

    /// Returns once the response headers arrive; the caller reads the body.
    pub async fn get(&self, uri: &Url, cancel: &CancellationToken) -> Result<Response> {
        // Scryfall rate-limits its API; the file origins at *.scryfall.io (card images) have no rate limit.
        let is_file_origin = uri.host_str().is_some_and(|host| host.to_ascii_lowercase().ends_with(".scryfall.io"));
        if !is_file_origin {
            self.rate_gate.wait(cancel).await?;
        }
        tokio::select! {
            response = tokio::time::timeout(REQUEST_TIMEOUT, self.http.get(uri.clone()).send()) => match response {
                Ok(response) => Ok(response?),
                Err(_) => Err(RequestTimedOut.into()),
            },
            _ = cancel.cancelled() => Err(Cancelled.into()),
        }
    }
}

/// HttpResponseMessage.EnsureSuccessStatusCode.
pub fn ensure_success_status_code(response: Response) -> Result<Response> {
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!(
            "Response status code does not indicate success: {} ({}).",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        );
    }
    Ok(response)
}

/// The response body, read whole; a cancel stops it.
pub async fn read_body(response: Response, cancel: &CancellationToken) -> Result<Vec<u8>> {
    tokio::select! {
        bytes = response.bytes() => Ok(bytes?.to_vec()),
        _ = cancel.cancelled() => Err(Cancelled.into()),
    }
}

/// The next piece of the body, None at its end; a cancel stops it.
pub async fn read_chunk(response: &mut Response, cancel: &CancellationToken) -> Result<Option<Vec<u8>>> {
    tokio::select! {
        chunk = response.chunk() => Ok(chunk?.map(|bytes| bytes.to_vec())),
        _ = cancel.cancelled() => Err(Cancelled.into()),
    }
}

struct RateLimiter {
    interval_ms: i64,
    origin: Instant,
    /// Milliseconds after `origin`.
    next_slot_tick: AtomicI64,
}

impl RateLimiter {
    fn new(interval_ms: i64) -> Self {
        Self { interval_ms, origin: Instant::now(), next_slot_tick: AtomicI64::new(0) }
    }

    async fn wait(&self, cancel: &CancellationToken) -> Result<()> {
        loop {
            let now = self.origin.elapsed().as_millis() as i64;
            let observed = self.next_slot_tick.load(Ordering::SeqCst);
            let slot_start = observed.max(now);
            let claimed = slot_start + self.interval_ms;
            if self.next_slot_tick.compare_exchange(observed, claimed, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                if slot_start > now {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis((slot_start - now) as u64)) => {}
                        _ = cancel.cancelled() => return Err(Cancelled.into()),
                    }
                }
                return Ok(());
            }
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ScryfallCardDto {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub oracle_id: Option<String>,
    pub illustration_id: Option<String>,
    #[serde(default)]
    pub games: Vec<String>,
    #[serde(default)]
    pub set: String,
    pub set_name: Option<String>,
    #[serde(default)]
    pub collector_number: String,
    pub layout: Option<String>,
    pub released_at: Option<String>,
    pub image_uris: Option<ScryfallImageUrisDto>,
    pub card_faces: Option<Vec<ScryfallCardFaceDto>>,
}

impl ScryfallCardDto {
    pub fn is_available_in_paper(&self) -> bool {
        self.games.iter().any(|game| game == "paper")
    }

    // One image per printed face: a card with a single image (split, flip, adventure) has one, a double-faced card
    // one per side. Each keeps the illustration printed on that face.
    pub fn resolve_card_images(&self) -> Vec<ResolvedCardImage> {
        if let Some(direct) = self.image_uris.as_ref().and_then(|uris| uris.large.as_ref()) {
            let illustration_id = self.illustration_id.clone().or_else(|| {
                self.card_faces.as_ref().and_then(|faces| faces.first()).and_then(|face| face.illustration_id.clone())
            });
            return vec![ResolvedCardImage {
                image_id: format!("{}:front", self.id),
                face_index: 0,
                image_uri: direct.clone(),
                illustration_id,
            }];
        }
        self.card_faces
            .iter()
            .flatten()
            .enumerate()
            .filter_map(|(index, face)| {
                let large = face.image_uris.as_ref()?.large.as_ref()?;
                Some(ResolvedCardImage {
                    image_id: format!("{}:face-{index}", self.id),
                    face_index: index as i32,
                    image_uri: large.clone(),
                    illustration_id: face.illustration_id.clone(),
                })
            })
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedCardImage {
    pub image_id: String,
    pub face_index: i32,
    pub image_uri: String,
    pub illustration_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ScryfallImageUrisDto {
    pub large: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ScryfallCardFaceDto {
    pub illustration_id: Option<String>,
    pub image_uris: Option<ScryfallImageUrisDto>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ScryfallOracleCardDto {
    #[serde(default)]
    pub oracle_id: String,
    #[serde(default)]
    pub name: String,
    pub mana_cost: Option<String>,
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ScryfallBulkDataEntryDto {
    #[serde(default, rename = "type")]
    pub r#type: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub jsonl_download_uri: String,
}
