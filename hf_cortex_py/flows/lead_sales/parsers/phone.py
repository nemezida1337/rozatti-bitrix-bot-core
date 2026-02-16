import re
from typing import Optional

from flows.lead_sales.parsers.common import normalize_text


_PHONE_CAND_RE = re.compile(r"(\+?\d[\d\-\s\(\)]{8,}\d)")


def extract_phone_from_text(text: str) -> Optional[str]:
    """Достаёт российский телефон из текста. Возвращает нормализованное +7XXXXXXXXXX."""
    t = normalize_text(text)
    if not t:
        return None

    for m in _PHONE_CAND_RE.finditer(t):
        raw = m.group(1)
        digits = re.sub(r"\D+", "", raw)
        if len(digits) == 11 and digits[0] in ("7", "8"):
            if digits[0] == "8":
                digits = "7" + digits[1:]
            return "+{}".format(digits)
        if len(digits) == 10:
            # без кода страны (редко, но бывает)
            return "+7{}".format(digits)
    return None
