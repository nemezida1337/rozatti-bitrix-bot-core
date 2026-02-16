import re
from typing import List, Optional, Union

# Русские порядковые (наиболее частые формы)
_ORDINAL_PATTERNS = {
    1: [r"\bперв(?:ый|ая|ое|ые|ого|ую|ым|ыми|ом)\b"],
    2: [r"\bвтор(?:ой|ая|ое|ые|ого|ую|ым|ыми|ом)\b"],
    3: [r"\bтрет(?:ий|ья|ье|ьи|ьего|ью|ьим|ьими|ьем)\b"],
    4: [r"\bчетв(?:ертый|ёртый|ертая|ёртая|ертое|ёртое|ертые|ёртые)\b"],
    5: [r"\bпят(?:ый|ая|ое|ые)\b"],
}

# "вариант 2" / "варианта 1 и 2" / "вариант №3"
_VARIANT_NUM_RE = re.compile(r"\bвариант(?:а|ов)?\s*(?:№\s*)?(\d{1,2})\b", re.IGNORECASE)

# Любые маленькие числа (для ответов типа "1")
_SMALL_NUM_RE = re.compile(r"\b(\d{1,2})\b")

# Чистка количества, чтобы "2 шт" не воспринималось как "вариант 2"
_QTY_PHRASE_RE = re.compile(
    r"\b\d{1,3}\s*(?:шт\.?|штук|штуки|pcs?|pc|piece|pieces)\b",
    re.IGNORECASE,
)
_X_QTY_RE = re.compile(r"\b(?:x\s*\d{1,3}|\d{1,3}\s*x)\b", re.IGNORECASE)


def extract_offer_choice_from_text(
    text: str,
    valid_offer_ids: List[int],
) -> Optional[Union[int, List[int]]]:
    """Детерминированное извлечение выбранного варианта из текста.

    Ключевая цель: не путать "2 шт" с "вариант 2".
    
    Возвращает:
      - int (если выбрали один вариант)
      - List[int] (если выбрали несколько)
      - None (если выбор не распознан)
    """
    if not isinstance(text, str) or not text.strip():
        return None

    ids_set = set(int(x) for x in valid_offer_ids if isinstance(x, int) and x > 0)
    if not ids_set:
        return None

    t = text.lower()

    # 1) Вычищаем явные выражения количества, чтобы не ловить цифры из "2 шт" / "x2"
    t_clean = _QTY_PHRASE_RE.sub(" ", t)
    t_clean = _X_QTY_RE.sub(" ", t_clean)

    found: List[int] = []

    # 2) Порядковые слова/формы ("первый", "второй" ...)
    for num, patterns in _ORDINAL_PATTERNS.items():
        if any(re.search(p, t_clean, re.IGNORECASE) for p in patterns):
            if num in ids_set:
                found.append(num)

    # 3) Явные "вариант N"
    for m in _VARIANT_NUM_RE.finditer(t_clean):
        try:
            n = int(m.group(1))
            if n in ids_set:
                found.append(n)
        except Exception:
            continue

    # 4) Фоллбек: одиночное маленькое число (часто отвечают просто "1"/"2").
    # Защита от ложных срабатываний на адресе ("дом 2", "кв 2" и т.п.).
    # Разрешаем фоллбек только если сообщение ПОХОЖЕ на чистый ответ с номером.
    if re.fullmatch(r"\s*(?:вариант\s*)?(?:№\s*)?\d{1,2}\s*", t_clean, re.IGNORECASE):
        for m in _SMALL_NUM_RE.finditer(t_clean):
            try:
                n = int(m.group(1))
                if n in ids_set:
                    found.append(n)
            except Exception:
                continue

    if not found:
        return None

    uniq = sorted(set(found))
    return uniq[0] if len(uniq) == 1 else uniq
