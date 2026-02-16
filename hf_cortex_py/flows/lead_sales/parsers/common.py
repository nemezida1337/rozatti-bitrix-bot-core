import re
import unicodedata
from typing import Any, Dict


def get_msg_text(msg_dict: Dict[str, Any]) -> str:
    """Достаёт текст сообщения из разных возможных полей."""
    if not isinstance(msg_dict, dict):
        return ""

    # прямые варианты
    for k in ("text", "MESSAGE", "message", "body", "msg", "TEXT"):
        v = msg_dict.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()

    # вложенные варианты: {"message": {"text": ...}}, {"data": {"text": ...}}
    for k in ("message", "msg", "data", "payload"):
        v = msg_dict.get(k)
        if isinstance(v, dict):
            for kk in ("text", "MESSAGE", "message", "body", "TEXT"):
                vv = v.get(kk)
                if isinstance(vv, str) and vv.strip():
                    return vv.strip()

    return ""


def normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    return re.sub(r"\s+", " ", text).strip()
