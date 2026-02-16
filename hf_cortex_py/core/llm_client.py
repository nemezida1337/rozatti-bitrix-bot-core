# ================================
#  llm_client.py — HF-CORTEX v2
#  Контакты + вызов LLM
# ================================

import re
import json
import unicodedata
from typing import Dict, Any, Optional

from openai import OpenAI

from core.models import CortexResult
from core.prompt_lead_sales import SYSTEM_PROMPT


# --------------------------------------------
# 1. Нормализация телефона (утилиты, могут использоваться детекторами)
# --------------------------------------------

def normalize_phone(raw: Optional[str]) -> Optional[str]:
    """
    Мягкая нормализация телефона в формат +7XXXXXXXXXX.
    ВАЖНО: в normalize_llm_result больше НЕ вызывается автоматически.
    Используется только там, где это явно нужно (например, в детекторах).
    """
    if not raw:
        return None

    digits = re.sub(r"\D", "", raw)

    # 8XXXXXXXXXX → 7XXXXXXXXXX
    if len(digits) == 11 and digits[0] == "8":
        digits = "7" + digits[1:]

    # 7XXXXXXXXXX → +7XXXXXXXXXX
    if len(digits) == 11 and digits[0] == "7":
        return f"+{digits}"

    # 10 цифр → добавляем +7
    if len(digits) == 10:
        return f"+7{digits}"

    return None


def extract_phone(text: str) -> Optional[str]:
    """
    Пытаемся вытащить телефон из текста.
    Поддерживаем разные форматы: +7..., 8..., 7..., с пробелами, скобками и т.д.

    ВНИМАНИЕ:
    В normalize_llm_result больше НЕ вызывается автоматически,
    чтобы не портить данные лида/контакта без явного сигнала от LLM.
    """
    matches = re.findall(r"(\+?[78]?\D?\d{3}\D?\d{3}\D?\d{2}\D?\d{2})", text)
    if not matches:
        return None
    return normalize_phone(matches[0])


# --------------------------------------------
# 2. Разбор ФИО
# --------------------------------------------

def _clean_fio_part(x: str) -> str:
    x = unicodedata.normalize("NFKC", x)
    x = x.strip()
    x = re.sub(r"[^\w\-ЁёА-Яа-я]", "", x)
    return x.capitalize()


RUS_PATRONYMIC_SUFFIXES = ("вич", "вна", "чна", "ич", "лы", "оглы")


def is_patronymic(word: str) -> bool:
    w = word.lower()
    return any(w.endswith(s) for s in RUS_PATRONYMIC_SUFFIXES)


def parse_full_name(text: str) -> Dict[str, Optional[str]]:
    """
    СТРОГИЙ разбор ФИО (только полное ФИО: Фамилия Имя Отчество).

    Возвращаем поля только если уверены, что есть отчество.
    Все неполные варианты (2 слова, инициалы и т.п.) считаются НЕвалидными.
    """

    if not isinstance(text, str):
        return {"last": None, "first": None, "middle": None}

    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"[\t\r\n]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()

    # Выделим слова на кириллице (с дефисом)
    words = re.findall(r"[А-ЯЁа-яё\-]{2,}", text)
    if len(words) < 3:
        return {"last": None, "first": None, "middle": None}

    # Берём первое подходящее окно из 3 слов
    patronymic_re = re.compile(r"(ович|евич|ич|овна|евна|ична|инична|вна|на)$", re.IGNORECASE)

    def norm(w: str) -> str:
        w = w.strip("-")
        if not w:
            return w
        return w[0].upper() + w[1:].lower()

    for i in range(0, len(words) - 2):
        w1, w2, w3 = words[i], words[i + 1], words[i + 2]
        # варианты: Фамилия Имя Отчество  или  Имя Отчество Фамилия
        if patronymic_re.search(w3):
            return {"last": norm(w1), "first": norm(w2), "middle": norm(w3)}
        if patronymic_re.search(w2):
            return {"last": norm(w3), "first": norm(w1), "middle": norm(w2)}

    return {"last": None, "first": None, "middle": None}


# --------------------------------------------
# 4. Нормализация результата LLM → CortexResult
# --------------------------------------------

def normalize_llm_result(llm: Dict[str, Any]) -> CortexResult:
    """
    Приводит ответ модели к CortexResult.

    КЛЮЧЕВЫЕ ПРИНЦИПЫ:

    1) НИКАКОЙ "магии" по ФИО/телефону/адресу из reply.
       Мы НИКОГДА не используем reply как источник ФИО.
       Мы НИКОГДА не вытаскиваем телефон/адрес из ответа бота.

    2) Дополнительный разбор ФИО допускается ТОЛЬКО если:
       - stage ∈ { "CONTACT", "ADDRESS", "FINAL" }
       - и есть ЯВНЫЙ источник ФИО:
         client_name / update_lead_fields.client_name / contact_update.full_name / contact_update.fio

    3) Телефон и адрес:
       - не добавляем автоматически;
       - если модель их уже положила в update_lead_fields/contact_update — просто пропускаем дальше.

    Таким образом, Cortex перестаёт "придумывать" ФИО и телефон,
    а только структурирует то, что модель явно указала.
    """

    # Базовые структуры
    update_lead_fields = llm.get("update_lead_fields") or {}
    if not isinstance(update_lead_fields, dict):
        update_lead_fields = {}

    contact_update = llm.get("contact_update") or {}
    if not isinstance(contact_update, dict):
        contact_update = {}

    # Текст ответа (могут быть нужны для отладки, но НЕ для ФИО/телефона)
    reply_text = llm.get("reply") or ""
    stage = llm.get("stage") or "NEW"

    # ----------------------------------------
    # 4.1. Разбор ФИО (только на CONTACT / FINAL
    #      и только если есть явный источник ФИО)
    # ----------------------------------------
    if stage in {"CONTACT", "FINAL"}:
        fio_source = (
            llm.get("client_name")
            or update_lead_fields.get("client_name")
            or contact_update.get("full_name")
            or contact_update.get("fio")
        )

        if isinstance(fio_source, str) and fio_source.strip():
            parsed = parse_full_name(fio_source)

            # Не перезатираем явно заданные поля, только добавляем туда, где пусто.
            if parsed["last"] and not update_lead_fields.get("LAST_NAME"):
                update_lead_fields["LAST_NAME"] = parsed["last"]
            if parsed["first"] and not update_lead_fields.get("NAME"):
                update_lead_fields["NAME"] = parsed["first"]
            if parsed["middle"] and not update_lead_fields.get("SECOND_NAME"):
                update_lead_fields["SECOND_NAME"] = parsed["middle"]

            # contact_update — "мягкое" дополнение
            contact_update.setdefault("last_name", parsed["last"])
            contact_update.setdefault("name", parsed["first"])
            contact_update.setdefault("second_name", parsed["middle"])

    # ----------------------------------------
    # 4.2. Телефон и адрес
    # ----------------------------------------
    # НИЧЕГО автоматически не извлекаем.
    # Если модель вернула PHONE / contact_update.phone — просто оставляем как есть.
    # Форматирование телефона под Bitrix делает Node (safeUpdateLeadAndContact).

    # ----------------------------------------
    # 4.3. Формирование CortexResult
    # ----------------------------------------
    result = CortexResult(
        action=llm.get("action", "reply"),
        stage=stage,
        reply=reply_text,
        oems=llm.get("oems") or [],
        need_operator=bool(llm.get("need_operator", False)),
        update_lead_fields=update_lead_fields,
        client_name=llm.get("client_name"),
        product_rows=llm.get("product_rows") or [],
        product_picks=llm.get("product_picks") or [],
        offers=llm.get("offers") or [],
        chosen_offer_id=llm.get("chosen_offer_id"),
        contact_update=contact_update or None,
        meta=llm.get("meta") or {},
        debug=llm.get("debug") or {},
    )

    return result


# --------------------------------------------
# 5. Основной вызов LLM
# --------------------------------------------

def call_llm_with_cortex_request(cortex_request: Dict[str, Any]) -> CortexResult:
    """
    Вызывает OpenAI с SYSTEM_PROMPT для lead_sales и
    возвращает уже нормализованный CortexResult.
    """

    client = OpenAI()

    # SYSTEM_PROMPT — из core.prompt_lead_sales
    system_prompt = SYSTEM_PROMPT

    completion = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(cortex_request, ensure_ascii=False)},
        ],
        response_format={"type": "json_object"},
    )

    raw = completion.choices[0].message.content or ""

    try:
        llm_dict = json.loads(raw)
    except Exception:
        # fallback, если модель сломала JSON
        llm_dict = {
            "action": "reply",
            "stage": "NEW",
            "reply": raw,
            "need_operator": False,
            "oems": [],
            "update_lead_fields": {},
            "client_name": None,
            "offers": [],
            "chosen_offer_id": None,
            "contact_update": None,
            "product_rows": [],
            "product_picks": [],
        }

    return normalize_llm_result(llm_dict)
