"""Small OpenAI-compatible HTTP wrapper around Qwen3-ASR."""

from __future__ import annotations

import asyncio
import os
import secrets
import tempfile
from pathlib import Path
from typing import Annotated

import torch
import uvicorn
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from qwen_asr import Qwen3ASRModel
from starlette.concurrency import run_in_threadpool


MODEL_NAME = os.environ.get("PEGAS_ASR_MODEL", "Qwen/Qwen3-ASR-0.6B")
API_KEY = os.environ.get("PEGAS_ASR_API_KEY", "")
DTYPE_NAME = os.environ.get("PEGAS_ASR_DTYPE", "float16")
MAX_AUDIO_BYTES = int(os.environ.get("PEGAS_ASR_MAX_AUDIO_BYTES", str(50 * 1024 * 1024)))
MAX_NEW_TOKENS = int(os.environ.get("PEGAS_ASR_MAX_NEW_TOKENS", "1024"))

LANGUAGE_NAMES = {
    "ar": "Arabic",
    "de": "German",
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "hi": "Hindi",
    "id": "Indonesian",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "ms": "Malay",
    "nl": "Dutch",
    "pt": "Portuguese",
    "ru": "Russian",
    "th": "Thai",
    "tr": "Turkish",
    "vi": "Vietnamese",
    "yue": "Cantonese",
    "zh": "Chinese",
}

app = FastAPI(title="Pegas Qwen3-ASR", docs_url=None, redoc_url=None)
inference_slot = asyncio.Semaphore(1)
runtime: Qwen3ASRModel | None = None


def require_api_key(authorization: Annotated[str | None, Header()] = None) -> None:
    if not API_KEY:
        return
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(token, API_KEY):
        raise HTTPException(status_code=401, detail="invalid API key")


def normalize_language(language: str | None) -> str | None:
    if not language:
        return None
    value = language.strip()
    return LANGUAGE_NAMES.get(value.lower(), value)


def load_model() -> None:
    global runtime
    try:
        dtype = getattr(torch, DTYPE_NAME)
    except AttributeError as error:
        raise RuntimeError(f"Unsupported torch dtype: {DTYPE_NAME}") from error

    runtime = Qwen3ASRModel.from_pretrained(
        MODEL_NAME,
        dtype=dtype,
        device_map="cuda:0",
        max_inference_batch_size=1,
        max_new_tokens=MAX_NEW_TOKENS,
    )


def healthz() -> dict[str, str]:
    if runtime is None:
        raise HTTPException(status_code=503, detail="model is loading")
    return {"status": "ok", "model": MODEL_NAME}


def models() -> dict[str, object]:
    return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model"}]}


async def transcribe(
    file: Annotated[UploadFile, File()],
    model: Annotated[str, Form()],
    language: Annotated[str | None, Form()] = None,
) -> dict[str, str]:
    if model != MODEL_NAME:
        raise HTTPException(status_code=400, detail=f"unknown model: {model}")
    if runtime is None:
        raise HTTPException(status_code=503, detail="model is loading")

    suffix = Path(file.filename or "audio.wav").suffix[:16] or ".audio"
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as target:
            temp_path = Path(target.name)
            size = 0
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_AUDIO_BYTES:
                    raise HTTPException(status_code=413, detail="audio is too large")
                target.write(chunk)

        async with inference_slot:
            results = await run_in_threadpool(
                runtime.transcribe,
                audio=str(temp_path),
                language=normalize_language(language),
            )
        if not results or not results[0].text.strip():
            raise HTTPException(status_code=502, detail="model returned an empty transcript")
        return {
            "text": results[0].text.strip(),
            "language": str(results[0].language),
        }
    finally:
        await file.close()
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


app.add_event_handler("startup", load_model)
app.add_api_route("/healthz", healthz, methods=["GET"])
app.add_api_route(
    "/v1/models",
    models,
    methods=["GET"],
    dependencies=[Depends(require_api_key)],
)
app.add_api_route(
    "/v1/audio/transcriptions",
    transcribe,
    methods=["POST"],
    dependencies=[Depends(require_api_key)],
)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, access_log=False)
