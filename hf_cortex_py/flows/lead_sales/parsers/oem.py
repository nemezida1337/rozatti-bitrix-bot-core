import re
from typing import Optional, List, Tuple

URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
ORDER_NUMBER_CONTEXT_RE = re.compile(
    r"(номер\s+заказа|заказ\s*№|order\s*#|order\s+number)",
    re.IGNORECASE,
)
SERVICE_TOKEN_RE = re.compile(
    r"^(UTM|SOURCE|MEDIUM|CAMPAIGN|CONTENT|TERM|REF|CHAT\d{3,}|DIALOG\d{3,})$",
    re.IGNORECASE,
)


def looks_like_vin(token: str) -> bool:
    """
    VIN:
    - ровно 17 символов A-Z0-9
    - часто исключают I, O, Q (в VIN их не бывает)
    """
    if not isinstance(token, str):
        return False
    t = token.strip().upper()
    if len(t) != 17:
        return False
    if not re.fullmatch(r"[A-Z0-9]{17}", t):
        return False
    # VIN не содержит I/O/Q
    if any(ch in t for ch in ("I", "O", "Q")):
        return False
    return True


def _is_order_number_token(token: str, full_text: str) -> bool:
    if not re.fullmatch(r"\d{7,12}", token or ""):
        return False
    return bool(ORDER_NUMBER_CONTEXT_RE.search(full_text or ""))


def _is_service_token(token: str) -> bool:
    return bool(SERVICE_TOKEN_RE.fullmatch((token or "").strip()))


def _has_digit(token: str) -> bool:
    return any(ch.isdigit() for ch in str(token or ""))


def extract_oem_from_text(text: str) -> Optional[str]:
    """
    Детектор requested_oem на стадии NEW.
    ВАЖНО: VIN фильтруем (чтобы не принять VIN за OEM).
    Стратегия:
      - соберём токены [A-Za-z0-9]{6,25}
      - выкинем VIN (17 без I/O/Q)
      - выберем "наиболее похожий на OEM":
          1) предпочтение длине 6..20
          2) затем по длине (длиннее обычно ближе к OEM)
    """
    if not isinstance(text, str) or not text.strip():
        return None

    no_urls = URL_RE.sub(" ", text)
    raw_tokens = re.findall(r"[A-Za-z0-9]{6,25}", no_urls.upper())
    if not raw_tokens:
        return None

    tokens: List[str] = []
    for tok in raw_tokens:
        if looks_like_vin(tok):
            continue
        if not _has_digit(tok):
            continue
        if _is_service_token(tok):
            continue
        if _is_order_number_token(tok, no_urls):
            continue
        tokens.append(tok)

    if not tokens:
        return None

    # OEM обычно 6..20, поэтому ограничим предпочтения
    def score(tok: str) -> Tuple[int, int, str]:
        # 0 лучше, чем 1
        in_oem_len = 0 if 6 <= len(tok) <= 20 else 1
        return (in_oem_len, -len(tok), tok)

    tokens.sort(key=score)
    return tokens[0]
