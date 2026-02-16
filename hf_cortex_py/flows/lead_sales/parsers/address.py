import re
from typing import Optional

from flows.lead_sales.parsers.common import normalize_text
from flows.lead_sales.parsers.phone import extract_phone_from_text


def looks_like_address_text(text: str) -> bool:
    t = normalize_text(text).lower()
    if not t:
        return False
    if "самовывоз" in t:
        return True

    # P0: не принимаем "ФИО + телефон" за адрес.
    # Частый кейс: клиент пишет "Иванов Иван Иванович +7...".
    # В таком сообщении есть цифры, много слов, но нет адресных маркеров.
    phone = extract_phone_from_text(text)
    has_addr_words = bool(re.search(r"\b(ул|улица|дом|д\.|д |кв|квартира|корп|корпус|проспект|пр-т|шоссе|пер|переулок|проезд|г\.|город)\b", t))
    has_commas = "," in t
    if phone and not has_addr_words and not has_commas:
        return False
    # минимальные признаки адреса: есть цифры и адресные слова
    if not re.search(r"\d", t):
        return False
    if has_addr_words:
        return True
    # если просто очень похоже на адрес (много слов и цифры)
    if len(t.split()) >= 4:
        return True
    return False


def extract_address_or_pickup_raw(text: str) -> Optional[str]:
    """Адрес: RAW. Исключение: самовывоз -> 'Самовывоз'."""
    t = normalize_text(text)
    if not t:
        return None
    if "самовывоз" in t.lower():
        return "Самовывоз"
    if looks_like_address_text(t):
        return t
    return None
