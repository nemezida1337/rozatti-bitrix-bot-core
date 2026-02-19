import re
from typing import Optional

from flows.lead_sales.parsers.common import normalize_text
from flows.lead_sales.parsers.phone import extract_phone_from_text

ADDRESS_WORDS_RE = re.compile(
    r"\b(ул|улица|дом|д\.|д |кв|квартира|корп|корпус|проспект|пр-т|шоссе|пер|переулок|проезд|г\.|город)\b"
)
NON_ADDRESS_INTENT_RE = re.compile(
    r"(нужна\s+запчаст|сможете\s+привезти|подбор|подберите|цена|вариант|oem|артикул)"
)


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
    has_addr_words = bool(ADDRESS_WORDS_RE.search(t))
    has_commas = "," in t
    has_digits = bool(re.search(r"\d", t))

    # P0.1: не принимаем "товарные" запросы за адрес даже при наличии цифр.
    if NON_ADDRESS_INTENT_RE.search(t) and not has_addr_words:
        return False

    # Вопрос без адресных маркеров почти всегда не адрес.
    if "?" in t and not has_addr_words:
        return False

    if phone and not has_addr_words and not has_commas:
        return False
    # минимальные признаки адреса: есть цифры и адресные слова
    if not has_digits:
        return False
    if has_addr_words:
        return True
    # fallback без явных маркеров: допускаем только "город, улица, 10"
    # (должны быть запятые, чтобы не ловить фразы вида "нужна запчасть 12345")
    if has_commas and len(t.split()) >= 3:
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
