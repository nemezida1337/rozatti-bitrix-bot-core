import re
from typing import Optional, List, Tuple


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

    raw_tokens = re.findall(r"[A-Za-z0-9]{6,25}", text.upper())
    if not raw_tokens:
        return None

    tokens: List[str] = []
    for tok in raw_tokens:
        if looks_like_vin(tok):
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
