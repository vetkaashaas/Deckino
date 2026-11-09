from __future__ import annotations

import json
import sys
from typing import Any


def emit(event: str, **values: Any) -> None:
    payload = {"event": event, **values}
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True), flush=True)


def fail(message: str, **values: Any) -> int:
    emit("error", message=message, **values)
    return 1


def warn(message: str, **values: Any) -> None:
    payload = {"event": "warning", "message": message, **values}
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True), file=sys.stderr, flush=True)
