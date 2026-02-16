import re
from typing import Optional, Tuple

from flows.lead_sales.parsers.common import normalize_text


_STOPWORDS_FIO = {
    "город", "г", "ул", "улица", "проспект", "пр", "пр-т", "дом", "д", "кв", "квартира",
    "корп", "корпус", "стр", "строение", "офис", "самовывоз", "индекс", "республика",
    "область", "край", "район", "р-н", "шоссе", "пер", "переулок", "проезд",
}

_PATRONYMIC_RE = re.compile(
    r"(ович|евич|ич|овна|евна|ична|инична|вна|на)$",
    re.IGNORECASE,
)


def extract_full_fio_strict(text: str) -> Optional[Tuple[str, str, str, str]]:
    """Ищет СТРОГО полное ФИО (Фамилия Имя Отчество) в пользовательском тексте.

    Возвращает: (LAST_NAME, NAME, SECOND_NAME, full_name_raw) или None.
    """
    t = normalize_text(text)
    if not t:
        return None

    # Пытаемся найти три подряд идущих слова на кириллице
    fio_re = re.compile(r"([А-ЯЁа-яё][А-ЯЁа-яё\-]{1,})\s+([А-ЯЁа-яё][А-ЯЁа-яё\-]{1,})\s+([А-ЯЁа-яё][А-ЯЁа-яё\-]{1,})")
    for m in fio_re.finditer(t):
        w1, w2, w3 = m.group(1), m.group(2), m.group(3)
        lw1, lw2, lw3 = w1.lower(), w2.lower(), w3.lower()

        # отсекаем адресные/служебные слова
        if lw1 in _STOPWORDS_FIO or lw2 in _STOPWORDS_FIO or lw3 in _STOPWORDS_FIO:
            continue

        # строгая проверка отчества
        if not _PATRONYMIC_RE.search(w3):
            continue

        # финальная сборка
        def norm_word(w: str) -> str:
            w = w.strip("-")
            if not w:
                return w
            return w[0].upper() + w[1:].lower()

        last_name = norm_word(w1)
        first_name = norm_word(w2)
        second_name = norm_word(w3)
        full = f"{last_name} {first_name} {second_name}"
        return (last_name, first_name, second_name, full)

    return None


def split_full_name_strict(full_name: str) -> Optional[Tuple[str, str, str, str]]:
    return extract_full_fio_strict(full_name)
