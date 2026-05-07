"""
Tiny HTTP wrapper around Microsoft's MarkItDown so the Memory worker can
convert binary documents (PDF/DOCX/XLSX/PPTX/HTML/RTF/EPUB/audio/images)
to Markdown over a stable contract.

Single endpoint:
  POST /convert
    multipart/form-data:
      file: the binary document
      content_type (optional): MIME type override; falls back to the
                              uploaded part's content type or sniffing.
    -> 200 { "markdown": str, "title": str | null }
    -> 4xx/5xx { "error": str }
"""
from __future__ import annotations

import io
import logging

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from markitdown import MarkItDown

logger = logging.getLogger("markitdown-server")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="markitdown-sidecar", version="1")
_converter = MarkItDown()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/convert")
async def convert(
    file: UploadFile = File(...),
    content_type: str | None = Form(default=None),
) -> JSONResponse:
    if file.filename is None:
        raise HTTPException(status_code=400, detail="filename is required")

    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="empty upload")

    mime = content_type or file.content_type or "application/octet-stream"

    try:
        result = _converter.convert_stream(
            io.BytesIO(payload),
            file_extension=_extension_from_filename(file.filename),
            stream_info_filename=file.filename,
            stream_info_mimetype=mime,
        )
    except Exception as exc:  # noqa: BLE001 — surface the underlying message
        logger.exception("conversion failed for %s (%s)", file.filename, mime)
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return JSONResponse(
        {
            "markdown": result.text_content or "",
            "title": getattr(result, "title", None),
        }
    )


def _extension_from_filename(name: str) -> str | None:
    if "." not in name:
        return None
    return "." + name.rsplit(".", 1)[1].lower()
