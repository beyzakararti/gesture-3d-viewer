"""Optional Claude-backed natural language bridge for the 3D scene.

The renderer always has a deterministic offline interpreter, so this module is a
pure enhancement: when ANTHROPIC_API_KEY is present the model turns free-form
Turkish or English into the same action objects the offline parser emits, and
when it is absent the endpoint reports that cleanly so the renderer can fall
back without surfacing an error to the user.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
MODEL = "claude-sonnet-5"
REQUEST_TIMEOUT_SECONDS = 30
MAX_PROMPT_CHARS = 2000

SYSTEM_PROMPT = """Sen bir 3B model görüntüleyicisinin komut yorumlayıcısısın.
Kullanıcının Türkçe veya İngilizce isteğini, sahnede uygulanacak eylemlere çevir.
SADECE tek bir JSON nesnesi döndür, başka hiçbir metin ekleme.

Şema:
{"reply": "<kullanıcıya tek cümlelik Türkçe yanıt>", "actions": [<eylem>, ...]}

Geçerli eylemler:
{"type":"color","value":"#rrggbb","part":"<parça adı veya null>"}
{"type":"scalePercent","value":<10-1000 arası sayı>}
{"type":"scaleMultiply","value":<0.1-10 arası çarpan>}
{"type":"position","axis":"x"|"y"|"z","value":<birim>,"relative":true|false}
{"type":"rotate","axis":"x"|"y"|"z","degrees":<sayı>}
{"type":"explode","value":<0-1 arası oran>}
{"type":"assemble"}
{"type":"wireframe","value":true|false}
{"type":"opacity","value":<0-1>}
{"type":"autoRotate","value":true|false}
{"type":"reset"}
{"type":"fit"}
{"type":"metallic","value":<0-1>}
{"type":"roughness","value":<0-1>}

Renk adlarını hex'e çevir. "yüzde 40 büyüt" -> scaleMultiply 1.4.
"boyutu yüzde 40 olsun" -> scalePercent 40. İstek anlaşılmazsa actions boş dizi olsun."""


class AssistantUnavailable(RuntimeError):
    """Raised when no API key is configured or the upstream call fails."""


def is_configured() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def interpret(prompt: str, scene_summary: str) -> dict:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise AssistantUnavailable("ANTHROPIC_API_KEY is not set")

    prompt = prompt.strip()[:MAX_PROMPT_CHARS]
    if not prompt:
        raise AssistantUnavailable("Empty prompt")

    body = json.dumps(
        {
            "model": MODEL,
            "max_tokens": 1024,
            "system": SYSTEM_PROMPT,
            "messages": [
                {
                    "role": "user",
                    "content": f"Sahne durumu:\n{scene_summary}\n\nKullanıcı isteği:\n{prompt}",
                }
            ],
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        API_URL,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": API_VERSION,
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise AssistantUnavailable(f"Claude API error {error.code}") from error
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise AssistantUnavailable(f"Claude API unreachable: {error}") from error

    text = "".join(
        block.get("text", "")
        for block in payload.get("content", [])
        if block.get("type") == "text"
    ).strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise AssistantUnavailable("Claude returned non-JSON output") from error

    actions = parsed.get("actions")
    return {
        "reply": str(parsed.get("reply", "")),
        "actions": actions if isinstance(actions, list) else [],
    }
