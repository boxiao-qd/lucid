"""Vision Recognizer — multimodal image recognition before agent loop.

Uses a dedicated vision model (e.g. Qwen3.6-35B-A3B) with OpenAI-compatible API.
Separated from LLMRouter because vision models require special params
(chat_template_kwargs / enable_thinking) not supported by the generic router.

Flow:
    image URLs → download bytes → base64 data URL → vision model → recognition text
"""

import asyncio
import base64
import logging

import boto3
import httpx
from openai import AsyncOpenAI, APIError, APITimeoutError
from urllib.parse import urlparse, parse_qs

from app.config import settings
from app.middleware.error_handler import AppError

log = logging.getLogger(__name__)

_MIME_BY_EXT = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
}

_VISION_PROMPT = (
    "请详细识别这张图片：描述其中的物体、场景、人物，"
    "提取可见的文字（如有），并总结关键信息。"
)


class VisionRecognizer:
    """Recognize images via a dedicated vision model.

    Does NOT go through LLMRouter — vision models need vendor-specific
    params (chat_template_kwargs, enable_thinking) that the generic router
    doesn't support.
    """

    def __init__(self):
        if not settings.vision_api_base or not settings.vision_api_key or not settings.vision_model:
            raise AppError(
                "BX_AGENT_7010",
                "Vision model not configured (VISION_API_BASE/VISION_API_KEY/VISION_MODEL empty)",
                500,
            )
        self._client = AsyncOpenAI(
            api_key=settings.vision_api_key,
            base_url=settings.vision_api_base,
            timeout=httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=10.0),
        )

    async def recognize(self, image_urls: list[str], prompt: str = "") -> str:
        """Download images, send to vision model, return recognition text.

        Multiple images are sent in a single request (content array with
        multiple image_url parts). Returns the model's text response.

        Args:
            image_urls: List of HTTP/HTTPS URLs to images.
            prompt: Optional custom prompt. If empty, uses the default
                    general-recognition prompt. The tool path uses this to
                    let the agent ask specific questions about the image.
        """
        if not image_urls:
            return ""

        text_prompt = prompt or _VISION_PROMPT

        # 1. Download each image and convert to base64 data URL.
        #    The vision API can't reach localhost MinIO, so we inline the bytes.
        content_parts: list[dict] = [{"type": "text", "text": text_prompt}]
        async with httpx.AsyncClient(timeout=30.0) as http:
            for url in image_urls:
                data_url = await self._to_data_url(http, url)
                content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": data_url},
                })

        # 2. Call vision model (non-streaming — single-shot recognition)
        try:
            resp = await self._client.chat.completions.create(
                model=settings.vision_model,
                messages=[{"role": "user", "content": content_parts}],
                max_tokens=1024,
                top_p=0.95,
                temperature=1,
                stream=False,
                extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            )
            text = resp.choices[0].message.content or ""
            log.info("VisionRecognizer: %d images → %d chars", len(image_urls), len(text))
            return text.strip()
        except (APITimeoutError, httpx.TimeoutException) as e:
            raise AppError("BX_AGENT_7010", f"Vision model timeout: {e}", 504)
        except APIError as e:
            raise AppError("BX_AGENT_7010", f"Vision model API error: {e}", 502)
        except Exception as e:
            raise AppError("BX_AGENT_7010", f"Vision recognition failed: {e}", 500)

    async def _to_data_url(self, http: httpx.AsyncClient, url: str) -> str:
        """Convert a URL (http/https) or data: URL to a base64 data URL.

        For internal proxy URLs (/bx/api/v1/files/attachment?key=...),
        reads from MinIO directly via the S3 client — no HTTP roundtrip.
        """
        if url.startswith("data:"):
            return url  # already a data URL — pass through

        # Internal proxy URL — read from MinIO directly (avoids HTTP self-call)
        if "/files/attachment" in url and "key=" in url:
            return await self._read_from_minio_as_data_url(url)

        resp = await http.get(url)
        resp.raise_for_status()
        content_type = resp.headers.get("content-type", "").split(";")[0].strip().lower()
        if not content_type or not content_type.startswith("image/"):
            # Infer from extension
            ext = "." + url.rsplit(".", 1)[-1].lower() if "." in url.split("?")[0] else ""
            content_type = _MIME_BY_EXT.get(ext, "image/jpeg")
        b64 = base64.b64encode(resp.content).decode("ascii")
        return f"data:{content_type};base64,{b64}"

    async def _read_from_minio_as_data_url(self, url: str) -> str:
        """Read an image from MinIO by extracting the key from a proxy URL.

        Runs the sync boto3 call in a thread to avoid blocking the event loop.
        """
        params = parse_qs(urlparse(url).query)
        key = params.get("key", [""])[0]
        if not key:
            raise AppError("BX_AGENT_7010", f"No key in attachment URL: {url}", 500)

        def _read() -> str:
            bucket = settings.object_storage_bucket
            kw = dict(
                aws_access_key_id=settings.object_storage_access_key,
                aws_secret_access_key=settings.object_storage_secret_key,
                region_name=settings.object_storage_region or "us-east-1",
            )
            if settings.object_storage_endpoint:
                kw["endpoint_url"] = settings.object_storage_endpoint
            s3 = boto3.client("s3", **kw)
            resp = s3.get_object(Bucket=bucket, Key=key)
            data = resp["Body"].read()
            content_type = resp.get("ContentType", "image/jpeg")
            if not content_type or not content_type.startswith("image/"):
                ext = "." + key.rsplit(".", 1)[-1].lower() if "." in key else ""
                content_type = _MIME_BY_EXT.get(ext, "image/jpeg")
            b64 = base64.b64encode(data).decode("ascii")
            return f"data:{content_type};base64,{b64}"

        return await asyncio.to_thread(_read)
