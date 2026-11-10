"""The model benchmark's cards, held out of artwork training.

The benchmark's photos live in ``training/camera/benchmark`` (synced to the bucket's own ``benchmark/v1/`` prefix),
beside ``camera/imports``, so no trainer ever reads them. Its cards stay out of real-photo training too: a model that
trained on other photos of a benchmark card would be flattered on it.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path

LABEL_STATUSES = {"confirmed", "corrected"}


def benchmark_oracles(data_root: Path) -> set[str]:
    """Every card labelled in the benchmark: training must never see a photo of one."""
    camera = data_root / "training" / "camera"
    root = camera / "benchmark"
    # The folder alone proves nothing (scoring and Open photos folder create it too): only a finished Sync now of
    # the benchmark (its catalogue's last_successful_sync_utc) says this PC has every PC's benchmark cards.
    catalog = camera / "benchmark-sync.db"
    synced = None
    if catalog.is_file():
        # Read-only: the Toolbox may be writing its sync catalogue.
        try:
            with closing(sqlite3.connect(f"{catalog.resolve().as_uri()}?mode=ro", uri=True)) as connection:
                synced = connection.execute(
                    "SELECT value FROM meta WHERE key = ?", ("last_successful_sync_utc",)).fetchone()
        except sqlite3.Error as error:
            raise ValueError(f"Could not read the model benchmark's sync catalogue ({catalog}); try again once the "
                             f"Toolbox's sync has finished ({error})") from error
    if not (synced and synced[0]) or not root.is_dir():
        raise ValueError(f"The model benchmark has not been synced to this PC ({root}): run Sync now on the Dataset "
                         "Sync page first, so the benchmark's cards stay out of training")
    oracles = set()
    for path in root.rglob("*._identity.json"):
        try:
            identity = json.loads(path.read_text(encoding="utf-8-sig"))
            if identity.get("Status") in LABEL_STATUSES and identity.get("OracleId"):
                oracles.add(identity["OracleId"].lower())
        except (OSError, ValueError, AttributeError) as error:
            # Skipping it could let the benchmark's card into training: the label has to be fixed first.
            raise ValueError(f"Unreadable benchmark label {path}: fix or delete it, then train again ({error})") from error
    return oracles
