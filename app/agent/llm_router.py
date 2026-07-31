"""LLM Router — OpenAI-compatible multi-model routing with key rotation and fallback."""

import httpx
from openai import AsyncOpenAI, APIError, APITimeoutError
from app.config import settings
import logging

log = logging.getLogger(__name__)

# Context overflow detection patterns (matching OpenClaw's approach)
_OVERFLOW_PATTERNS = [
    "request_too_large",
    "request exceeds the maximum size",
    "context length exceeded",
    "maximum context length",
    "prompt is too long",
    "exceeds model context window",
    "context overflow",
    "413",
]


class ContextOverflowError(Exception):
    """Raised when the LLM returns a context-length exceeded error.

    The caller should trigger compression and retry rather than failing immediately.
    """

    def __init__(self, message: str = "", original_error: Exception | None = None):
        super().__init__(message)
        self.original_error = original_error


def _is_context_overflow(error: APIError) -> bool:
    """Check if an APIError indicates a context overflow condition."""
    error_text = str(error).lower()
    # Also check the response body if available
    body = getattr(error, "body", None)
    if body and isinstance(body, dict):
        error_text += " " + str(body.get("error", "")).lower()
    return any(pattern in error_text for pattern in _OVERFLOW_PATTERNS)


class LLMRouter:
    def __init__(self):
        self._keys = settings.openai_api_keys or []
        self._key_index = 0

    def _get_client(self, api_key: str = "") -> AsyncOpenAI:
        key = api_key or (self._keys[self._key_index % len(self._keys)] if self._keys else "")
        # Use per-phase httpx timeouts:
        # - connect: short (15s) — fast fail if host is unreachable
        # - read: matches sse_ingress_timeout_seconds — streaming chunks can arrive slowly
        # - write: 30s — request upload
        # Passing a flat int to create() would override all phases to the same value,
        # which causes ReadTimeout on slow/long streaming responses.
        timeout = httpx.Timeout(
            connect=15.0,
            read=float(settings.sse_ingress_timeout_seconds),
            write=30.0,
            pool=10.0,
        )
        return AsyncOpenAI(api_key=key, base_url=settings.openai_api_base, timeout=timeout)

    def _rotate_key(self):
        if self._keys:
            self._key_index = (self._key_index + 1) % len(self._keys)

    async def chat(
        self,
        model: str,
        messages: list[dict],
        tools: list[dict] | None = None,
        stream: bool = True,
    ) -> object:
        """Call LLM with key rotation and model fallback on failure."""
        last_error = None
        models_to_try = [model] + settings.fallback_chain.get(model, [])

        for try_model in models_to_try:
            for key_attempt in range(min(len(self._keys), 3) if self._keys else 1):
                try:
                    client = self._get_client()
                    response = await client.chat.completions.create(
                        model=try_model,
                        messages=messages,
                        tools=tools,
                        stream=stream,
                    )
                    return response
                except (APITimeoutError, httpx.ReadTimeout, httpx.ConnectTimeout) as e:
                    last_error = e
                    log.warning("LLM timeout for model=%s, key_attempt=%d: %s",
                                try_model, key_attempt, type(e).__name__)
                    self._rotate_key()
                except APIError as e:
                    last_error = e
                    if _is_context_overflow(e):
                        raise ContextOverflowError(
                            f"Context overflow detected for model={try_model}: {e}", original_error=e
                        ) from e
                    if e.status_code in (401, 403):
                        log.warning("LLM auth error, rotating key")
                        self._rotate_key()
                    elif e.status_code == 429:
                        log.warning("LLM rate limited, rotating key")
                        self._rotate_key()
                    else:
                        log.warning("LLM API error: %s", e)
                        break

        from app.middleware.error_handler import AppError
        raise AppError("BX_AGENT_7001", f"LLM unavailable: {last_error}", 503)