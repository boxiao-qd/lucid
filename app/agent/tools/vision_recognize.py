"""vision_recognize tool — in-loop image recognition for the agent.

Complements the pre-loop vision pipeline (which auto-recognizes images in the
user's original request). This tool lets the agent recognize images it encounters
DURING execution — e.g. a URL returned by web_fetch, or a file path discovered
by file_search.

Uses the same VisionRecognizer as the pre-loop path, but allows the agent to
specify a custom prompt (what it wants to know about the image).
"""

import json
import logging

from app.agent.vision_recognizer import VisionRecognizer
from app.middleware.error_handler import AppError

log = logging.getLogger(__name__)


TOOL_DEF = {
    "type": "function",
    "function": {
        "name": "vision_recognize",
        "description": (
            "Recognize and analyze images via a vision model. "
            "Use this when you encounter an image URL during execution (e.g. from web_fetch, file_search) "
            "and need to understand its content. "
            "Note: images attached to the user's original message are already recognized automatically "
            "before the agent loop — do NOT call this tool for those."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "image_urls": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of image URLs (HTTP/HTTPS) to recognize",
                },
                "prompt": {
                    "type": "string",
                    "description": (
                        "What you want to know about the images. "
                        "Default: general description of objects, scene, text, and key info. "
                        "Example: '这张图片里有没有海鲜？价格是多少？'"
                    ),
                    "default": "",
                },
            },
            "required": ["image_urls"],
        },
    },
}


async def execute(args_str: str, employee_id: int) -> str:
    args = json.loads(args_str)
    image_urls = args.get("image_urls", [])
    prompt = args.get("prompt", "")

    if not image_urls or not isinstance(image_urls, list):
        return json.dumps({"error": "image_urls is required and must be a non-empty array"}, ensure_ascii=False)

    # Validate all entries are strings
    clean_urls = [u for u in image_urls if isinstance(u, str) and u.strip()]
    if not clean_urls:
        return json.dumps({"error": "image_urls must contain at least one non-empty URL string"}, ensure_ascii=False)

    try:
        recognizer = VisionRecognizer()
        text = await recognizer.recognize(clean_urls, prompt=prompt)
        log.info("vision_recognize: %d images, prompt=%r → %d chars", len(clean_urls), prompt[:50], len(text))
        return json.dumps(
            {"recognition": text, "image_count": len(clean_urls)},
            ensure_ascii=False,
        )
    except AppError as e:
        log.warning("vision_recognize AppError: %s", e.message)
        return json.dumps({"error": e.message}, ensure_ascii=False)
    except Exception as e:
        log.error("vision_recognize unexpected error", exc_info=e)
        return json.dumps({"error": f"Vision recognition failed: {e}"}, ensure_ascii=False)
