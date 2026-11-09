//! The Toolbox's command line: a sync, an image download, or a bundle import/pack, without the window.

use std::path::Path;

use anyhow::{Result, anyhow};
use chrono::Utc;
use tokio_util::sync::CancellationToken;

use crate::bulk_data_sync::BulkSyncStatus;
use crate::card_images::CardImageProgress;
use crate::n0;
use crate::services::Services;

/// Any of these on the command line runs `run` instead of opening the window.
pub const HEADLESS_FLAGS: &[&str] = &[
    "--sync",
    "--sync-images",
    "--import-extraction",
    "--import-artwork",
    "--pack-artwork",
    "--pack-extraction-handoff",
];

pub fn is_headless(args: &[String]) -> bool {
    args.iter().any(|argument| HEADLESS_FLAGS.iter().any(|flag| argument.eq_ignore_ascii_case(flag)))
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn AttachConsole(process_id: u32) -> i32;
}

const ATTACH_PARENT_PROCESS: u32 = u32::MAX;

/// Runs the first headless command found in `args`. 0 on success.
pub async fn run(services: &Services, args: &[String]) -> i32 {
    // A windowed exe prints to the console it was started from.
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
    match run_command(services, args).await {
        Ok(code) => code,
        Err(error) => {
            services.log.error("headless", "Headless operation failed.", Some(&error));
            eprintln!("FAILED: {error:?}");
            1
        }
    }
}

async fn run_command(services: &Services, arguments: &[String]) -> Result<i32> {
    let log = &services.log;
    let exporter = &services.training_result_exporter;
    let cancel = CancellationToken::new();

    if has_option(arguments, "--import-extraction") {
        let import_path = option_value(arguments, "--import-extraction")
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow!("Pass a ZIP path after --import-extraction."))?;
        log.information("headless-import", &format!("Importing extraction bundle {import_path}."));
        let imported = exporter.import_extraction_bundle(Path::new(&import_path), &cancel).await?;
        println!(
            "imported {} ({} files) -> {}",
            imported.model_version,
            imported.file_count,
            Path::new(&imported.artifact_root).display()
        );
        log.information("headless-import", &format!("Imported {}.", imported.model_version));
        return Ok(0);
    }

    if has_option(arguments, "--import-artwork") {
        let artwork_path = option_value(arguments, "--import-artwork")
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow!("Pass a ZIP path after --import-artwork."))?;
        log.information("headless-import", &format!("Importing artwork bundle {artwork_path}."));
        let imported = exporter.import_artwork_identity_bundle(Path::new(&artwork_path), &cancel).await?;
        println!(
            "imported {} ({} prototypes, {} files) -> {}",
            imported.model_version,
            n0(imported.prototypes),
            imported.file_count,
            Path::new(&imported.artifact_root).display()
        );
        log.information("headless-import", &format!("Imported artwork {}.", imported.model_version));
        return Ok(0);
    }

    if has_option(arguments, "--pack-artwork") {
        let artwork_version = option_value(arguments, "--pack-artwork").filter(|value| !value.trim().is_empty());
        log.information(
            "headless-handoff",
            &format!("Packing artwork bundle {}.", artwork_version.as_deref().unwrap_or("(latest)")),
        );
        let artwork_zip = exporter.pack_artwork_for_other_pcs(artwork_version.as_deref(), &cancel).await?;
        let artwork_zip = Path::new(&artwork_zip).display();
        println!("packed {artwork_zip}");
        log.information("headless-handoff", &format!("Packed {artwork_zip}."));
        return Ok(0);
    }

    if has_option(arguments, "--pack-extraction-handoff") {
        let model_version = match option_value(arguments, "--pack-extraction-handoff").filter(|v| !v.trim().is_empty())
        {
            Some(requested) => requested,
            None => services.extraction_workflow.resolve_suggestion_model()?.model_version,
        };
        log.information("headless-handoff", &format!("Packing extraction handoff {model_version}."));
        let zip_path = exporter.export_extraction_handoff(&model_version, &cancel).await?;
        let zip_path = Path::new(&zip_path).display();
        println!("packed {zip_path}");
        log.information("headless-handoff", &format!("Packed {zip_path}."));
        return Ok(0);
    }

    if has_option(arguments, "--sync-images") {
        log.information("headless-images", "Card image download started.");
        let preparation = services.card_images.prepare(true, None, &cancel).await?;
        let progress = |status: CardImageProgress| {
            println!(
                "{} images: {} done, {} failed, {} left",
                Utc::now().format("%H:%M:%S"),
                n0(status.downloaded),
                n0(status.failed),
                n0(status.remaining)
            );
        };
        let result = services.card_images.download_pending(None, Some(&progress), &cancel).await?;
        println!(
            "done: {} downloaded, {} failed, {} recovered, {} unused files removed",
            n0(result.downloaded),
            n0(result.failed),
            n0(preparation.recovered),
            n0(preparation.files_removed)
        );
        log.information("headless-images", "Card image download finished.");
        return Ok(if result.failed == 0 { 0 } else { 1 });
    }

    if has_option(arguments, "--sync") {
        log.information("headless-sync", "Bulk Scryfall sync started.");
        let progress = |status: BulkSyncStatus| {
            let total = status.total.map(|total| format!(" / {}", n0(total))).unwrap_or_default();
            println!("{} {}: {}{total}", Utc::now().format("%H:%M:%S"), status.stage, n0(status.processed));
        };
        let result = services.bulk_data_sync.sync_all(&progress, &cancel).await?;
        println!(
            "done: {} cards ({} sets), {} oracle cards, no-art={}, up-to-date=[{}]",
            n0(result.cards_imported),
            result.sets_upserted,
            n0(result.oracle_cards_imported),
            result.no_art_count,
            result.skipped_up_to_date.join(", ")
        );
        log.information("headless-sync", "Bulk Scryfall sync finished.");
        return Ok(0);
    }

    Ok(0)
}

fn has_option(arguments: &[String], option: &str) -> bool {
    arguments.iter().any(|value| value.eq_ignore_ascii_case(option))
}

/// The value after `option`, when it isn't another flag. --pack-extraction-handoff alone gives an empty value (the
/// latest model); any other option alone gives None.
fn option_value(arguments: &[String], option: &str) -> Option<String> {
    let index = arguments.iter().position(|value| value.eq_ignore_ascii_case(option))?;
    match arguments.get(index + 1) {
        Some(value) if !value.starts_with("--") => Some(value.clone()),
        _ if option.eq_ignore_ascii_case("--pack-extraction-handoff") => Some(String::new()),
        _ => None,
    }
}
