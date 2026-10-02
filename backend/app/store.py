"""File-system persistence: one directory per project.

data/projects/<id>/project.json        Project (questions, issues, status)
data/projects/<id>/<kind>.pdf          uploaded file
data/projects/<id>/ocr-<kind>.json     DocumentResult (raw OCR lines)
data/projects/<id>/pages/<kind>-<i>.jpg processed page (+ -orig.jpg)
"""

from __future__ import annotations

import os
import shutil
import threading
from collections import defaultdict
from pathlib import Path

from .models import DocKind, DocumentResult, Project


class ProjectNotFound(LookupError):
    pass


class Store:
    def __init__(self, root: Path) -> None:
        self.root = root / "projects"
        self.root.mkdir(parents=True, exist_ok=True)
        self._locks: defaultdict[str, threading.RLock] = defaultdict(threading.RLock)
        self._guard = threading.Lock()

    def lock(self, project_id: str) -> threading.RLock:
        with self._guard:
            return self._locks[project_id]

    def project_dir(self, project_id: str) -> Path:
        if not project_id.isalnum():
            raise ProjectNotFound(project_id)
        return self.root / project_id

    def pages_dir(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "pages"

    def page_image(self, project_id: str, kind: DocKind, page: int, orig: bool = False) -> Path:
        suffix = "-orig" if orig else ""
        return self.pages_dir(project_id) / f"{kind}-{page}{suffix}.jpg"

    # ---------------------------------------------------------------- projects

    def save(self, project: Project) -> None:
        directory = self.project_dir(project.id)
        directory.mkdir(parents=True, exist_ok=True)
        _atomic_write(directory / "project.json", project.model_dump_json())

    def load(self, project_id: str) -> Project:
        path = self.project_dir(project_id) / "project.json"
        if not path.is_file():
            raise ProjectNotFound(project_id)
        return Project.model_validate_json(path.read_text("utf-8"))

    def list(self) -> list[Project]:
        projects = []
        for path in self.root.glob("*/project.json"):
            try:
                projects.append(Project.model_validate_json(path.read_text("utf-8")))
            except (OSError, ValueError):
                continue
        return sorted(projects, key=lambda p: p.created_at, reverse=True)

    def delete(self, project_id: str) -> None:
        directory = self.project_dir(project_id)
        if not directory.is_dir():
            raise ProjectNotFound(project_id)
        shutil.rmtree(directory)

    # --------------------------------------------------------------- documents

    def save_upload(self, project_id: str, kind: DocKind, data: bytes) -> None:
        directory = self.project_dir(project_id)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{kind}.pdf").write_bytes(data)

    def load_upload(self, project_id: str, kind: DocKind) -> bytes:
        return (self.project_dir(project_id) / f"{kind}.pdf").read_bytes()

    def save_document(self, project_id: str, doc: DocumentResult) -> None:
        _atomic_write(self.project_dir(project_id) / f"ocr-{doc.kind}.json", doc.model_dump_json())

    def load_document(self, project_id: str, kind: DocKind) -> DocumentResult | None:
        path = self.project_dir(project_id) / f"ocr-{kind}.json"
        if not path.is_file():
            return None
        return DocumentResult.model_validate_json(path.read_text("utf-8"))


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, "utf-8")
    os.replace(tmp, path)
