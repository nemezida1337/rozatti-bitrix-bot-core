import re
from typing import Optional


# 2 шт / 2шт / 2 штуки / 2pcs
_QTY_RE = re.compile(
    r"\b(\d{1,3})\s*(?:шт\.?|штук|штуки|pcs?|pc|piece|pieces)\b",
    re.IGNORECASE,
)

# x2 / 2x
_QTY_X_RE = re.compile(r"\b(?:x\s*(\d{1,3})|(\d{1,3})\s*x)\b", re.IGNORECASE)


def _clamp(n: int, min_qty: int, max_qty: int) -> int:
    return max(min_qty, min(max_qty, n))


def extract_quantity_from_text(text: str, *, min_qty: int = 1, max_qty: int = 99) -> Optional[int]:
    """Извлекает количество из сообщения пользователя.

    Примеры:
    - "... 2 шт" -> 2
    - "x3" -> 3

    Возвращает None, если количество не найдено.
    """
    if not isinstance(text, str) or not text.strip():
        return None

    m = _QTY_RE.search(text)
    if m:
        try:
            n = int(m.group(1))
            return _clamp(n, min_qty, max_qty)
        except Exception:
            pass

    mx = _QTY_X_RE.search(text)
    if mx:
        g = mx.group(1) or mx.group(2)
        try:
            n = int(g)
            return _clamp(n, min_qty, max_qty)
        except Exception:
            pass

    return None
