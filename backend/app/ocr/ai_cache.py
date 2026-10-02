"""Disk cache for AI answers: identical input → no second call (reprocessing, duplicates).

Entries live under `settings.data_dir / "ai-cache"`, one JSON file per key, sharded by the
first two hex digits. The key covers everything that influences the answer: provider,
model, mode, prompt version, image bytes and any text input.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from app.config import Settings

log = logging.getLogger(__name__)


def cache_key(
    provider: str, model: str, mode: str, prompt_version: str, image: bytes, text: str = ""
) -> str:
    h = hashlib.sha256()
    for part in (provider, model, mode, prompt_version, text):
        data = part.encode("utf-8")
        h.update(len(data).to_bytes(8, "big") + data)
    h.update(hashlib.sha256(image).digest())
    return h.hexdigest()


class AiCache:
    def __init__(self, root: Path) -> None:
        self.root = root

    @classmethod
    def from_settings(cls, settings: Settings) -> AiCache | None:
        return cls(Path(settings.data_dir) / "ai-cache") if settings.ai_cache else None

    def _path(self, key: str) -> Path:
        return self.root / key[:2] / f"{key}.json"

    def get(self, key: str) -> dict[str, Any] | None:
        path = self._path(key)
        try:
            return json.loads(path.read_text("utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:  # corrupt entry: ignore, it will be rewritten
            log.warning("unreadable AI cache entry %s: %s", path, exc)
            return None

    def put(self, key: str, value: dict[str, Any]) -> None:
        path = self._path(key)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            # Atomic write: concurrent pages never see a half-written file.
            fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(value, fh, ensure_ascii=False)
            os.replace(tmp, path)
        except OSError as exc:
            log.warning("could not write AI cache entry %s: %s", path, exc)
