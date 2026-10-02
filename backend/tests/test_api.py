"""End-to-end API tests: upload → OCR (offline engine) → parse → review → export."""

from __future__ import annotations

import importlib
import io
import os
import time
from pathlib import Path

import cv2
import pytest
from docx import Document
from fastapi.testclient import TestClient

from tests import fixtures_gen

BEST = Path("/opt/tessdata_best")


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    data_dir = tmp_path_factory.mktemp("data")
    env = {"DATA_DIR": str(data_dir), "ADMIN_PASSWORD": "", "ANTHROPIC_API_KEY": ""}
    if (BEST / "fas.traineddata").exists():
        env["TESSDATA_DIR"] = str(BEST)
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    from app import config

    config.get_settings.cache_clear()
    main = importlib.reload(importlib.import_module("app.main"))
    with TestClient(main.app) as test_client:
        yield test_client
    for key, value in old.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    config.get_settings.cache_clear()


def _wait_ready(client: TestClient, project_id: str, timeout: float = 240) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        project = client.get(f"/api/projects/{project_id}").json()
        if project["status"] in ("ready", "failed"):
            return project
        time.sleep(0.5)
    raise AssertionError("processing timed out")


def _upload(client: TestClient, files: list[tuple[str, bytes, str]], **form) -> dict:
    response = client.post(
        "/api/projects",
        files=[("booklet", f) for f in files],
        data={"track": "bar", "year": "1404", "engine": "offline", **form},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _assert_four_questions(project: dict) -> None:
    assert project["status"] == "ready", project["error"]
    numbers = [q["number"] for q in project["questions"]]
    assert numbers == [1, 2, 3, 4]
    for question in project["questions"]:
        assert question["stem"]
        assert [o["key"] for o in question["options"]] == ["1", "2", "3", "4"]
        assert question["regions"], "each question must be locatable on the page"


def test_health_and_meta(client):
    health = client.get("/api/health").json()
    assert health["engines"]["offline"] is True
    assert health["push_configured"] is False
    meta = client.get("/api/meta").json()
    assert any(b["code"] == "BAR-1405" for b in meta["blueprints"])
    assert {"key": "civil", "name": "حقوق مدنی"} in meta["subjects"]


def test_typed_pdf_end_to_end(client):
    created = _upload(
        client, [("booklet.pdf", fixtures_gen.booklet_pdf(), "application/pdf")], blueprint="BAR-1405"
    )
    project = _wait_ready(client, created["id"])
    _assert_four_questions(project)
    assert project["questions"][0]["subject_key"] == "civil"

    pid = project["id"]
    page = client.get(f"/api/projects/{pid}/pages/booklet/0").json()
    assert page["source"] == "text_layer"
    image = client.get(f"/api/projects/{pid}/pages/booklet/0.jpg")
    assert image.status_code == 200 and image.headers["content-type"] == "image/jpeg"

    # edit + approve: manual key only when the key actually changes
    q1 = project["questions"][0]
    update = {
        "stem": q1["stem"],
        "options": q1["options"],
        "correct_key": "2",
        "explanation": "گزینه ۲ صحیح است.",
        "status": "approved",
    }
    saved = client.put(f"/api/projects/{pid}/questions/1", json=update).json()
    assert saved["status"] == "approved" and saved["key_source"] == "manual"
    assert not [i for i in saved["issues"] if i["code"] == "missing_key"]

    # add / delete
    assert client.post(f"/api/projects/{pid}/questions", json={"number": 5}).status_code == 200
    assert client.post(f"/api/projects/{pid}/questions", json={"number": 5}).status_code == 409
    assert client.delete(f"/api/projects/{pid}/questions/5").json() == {"ok": True}

    # exports
    payload = client.get(f"/api/projects/{pid}/export.json?only_approved=1").json()
    assert [q["source_number"] for q in payload["questions"]] == [1]
    assert payload["questions"][0]["correct_key"] == "2"
    docx = client.get(f"/api/projects/{pid}/export.docx")
    assert docx.status_code == 200
    text = "\n".join(p.text for p in Document(io.BytesIO(docx.content)).paragraphs)
    assert "سربرگ آزمون" in text and "سوال 4:" in text and "پاسخ صحیح: ب" in text

    # reparse rebuilds from stored OCR
    reparsed = client.post(f"/api/projects/{pid}/reparse", json={"blueprint": "auto"}).json()
    assert reparsed["blueprint"] == "auto" and len(reparsed["questions"]) == 4


def test_phone_photos_end_to_end(client):
    page = fixtures_gen.render(fixtures_gen.booklet_pdf(), dpi=200)
    photo = fixtures_gen.phone_scan(page)
    ok, jpeg = cv2.imencode(".jpg", photo, [cv2.IMWRITE_JPEG_QUALITY, 88])
    assert ok
    created = _upload(client, [("IMG_0001.jpg", jpeg.tobytes(), "image/jpeg")])
    assert created["documents"][0]["page_count"] == 1
    project = _wait_ready(client, created["id"])
    _assert_four_questions(project)
    result = client.get(f"/api/projects/{project['id']}/pages/booklet/0").json()
    assert result["source"] == "ocr" and result["preprocess"]


def test_multiple_images_become_pages(client):
    page = fixtures_gen.render(fixtures_gen.booklet_pdf(), dpi=120)
    ok, png = cv2.imencode(".png", page)
    files = [("p1.png", png.tobytes(), "image/png"), ("p2.png", png.tobytes(), "image/png")]
    response = client.post(
        "/api/projects", files=[("booklet", f) for f in files], data={"engine": "offline"}
    )
    assert response.status_code == 200
    assert response.json()["documents"][0]["page_count"] == 2
    client.delete(f"/api/projects/{response.json()['id']}")


def test_rejects_invalid_upload(client):
    response = client.post(
        "/api/projects", files=[("booklet", ("x.pdf", b"not a pdf", "application/pdf"))]
    )
    assert response.status_code == 400
    assert "معتبر" in response.json()["detail"]


def test_unknown_project(client):
    assert client.get("/api/projects/doesnotexist").status_code == 404
