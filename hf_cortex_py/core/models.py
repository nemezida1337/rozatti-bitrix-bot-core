from datetime import datetime
from typing import Any, Dict, Optional, List, Union
import uuid

from pydantic import BaseModel, Field


class CortexPayload(BaseModel):
    """
    Общий payload, который приходит в HF-CORTEX от Node.
    msg            — последнее сообщение пользователя / контекст.
    sessionSnapshot — слепок сессии (лид, контакт, стадия, OEM и т.п.).
    baseContext    — дополнительные данные (ABCP_SUMMARY, портал, настройки).
    injected_abcp  — сырой ответ ABCP, который Node может «вкалывать» во второй проход.
    """
    msg: Optional[Dict[str, Any]] = None
    sessionSnapshot: Optional[Dict[str, Any]] = None
    baseContext: Optional[Dict[str, Any]] = None
    injected_abcp: Optional[Dict[str, Any]] = None
    # Канонические варианты, которые может прислать Node (fallback, когда injected_abcp отсутствует)
    offers: Optional[List[Dict[str, Any]]] = None


class CortexRequest(BaseModel):
    """
    Обёртка над CortexPayload: кто обращается и за каким потоком.
    """
    app: str = Field(..., description="Кто обращается (hf-rozatti-py / bot и т.д.)")
    flow: str = Field(..., description="Имя потока (lead_sales и т.п.)")
    payload: CortexPayload


class Offer(BaseModel):
    """
    Нормализованный оффер по одному варианту запчасти.
    Это то, с чем будет работать и Cortex, и Node (product_rows, комментарии).
    """
    id: int = Field(..., description="Номер варианта (1, 2, 3...) для человека и бота")
    oem: Optional[str] = Field(None, description="Основной OEM артикула")
    brand: Optional[str] = Field(None, description="Бренд (например, MERCEDES-BENZ)")
    name: Optional[str] = Field(
        None,
        description="Человекочитаемое название / краткое описание (может совпадать с OEM+брендом)",
    )
    price: float = Field(..., description="Цена одной позиции")
    currency: str = Field("RUB", description="Валюта цены (по умолчанию RUB)")
    quantity: int = Field(1, description="Количество по умолчанию 1")
    delivery_days: Optional[int] = Field(
        None,
        description="Срок поставки в рабочих днях (после нормализации ABCP)",
    )
    source: Optional[str] = Field(
        None,
        description="Источник (DK, дилер и т.п.) — для логов, клиенту не показываем как есть",
    )
    comment: Optional[str] = Field(
        None,
        description="Краткий служебный комментарий (можно использовать для нюансов по офферу)",
    )


class ContactUpdate(BaseModel):
    """
    Структурированные данные по клиенту, которые Cortex смог вытащить из диалога.
    Node может на их основе обновлять Контакт и Лид.
    """
    full_name_raw: Optional[str] = Field(
        None,
        description="ФИО в том виде, как написал клиент (для логов и парсинга)",
    )
    name: Optional[str] = Field(None, description="Имя (NAME)")
    last_name: Optional[str] = Field(None, description="Фамилия (LAST_NAME)")
    second_name: Optional[str] = Field(None, description="Отчество (SECOND_NAME)")
    phone: Optional[str] = Field(None, description="Телефон клиента (как вернула модель / Cortex)")
    address: Optional[str] = Field(None, description="Адрес / город / удобное место получения")


class CortexResult(BaseModel):
    """
    Минимальный набор полей, понятных Node-боту + расширения под HF-CORTEX.
    Это фактический контракт ответа Python-кортекса.
    """

    # Основное действие (поведение) кортекса:
    # reply, abcp_lookup, handover_operator и т.д.
    action: str = "reply"

    # Текущая стадия воронки:
    # NEW / PRICING / CONTACT / ADDRESS / FINAL / HARD_PICK / LOST
    #
    # ВАЖНО:
    # - SUCCESS в лидах не используем (переезд в сделки).
    stage: Optional[str] = "NEW"

    # Текст, который нужно отправить клиенту в чат.
    reply: Optional[str] = "Привет! HF-CORTEX онлайн. Интеграция работает."

    # Результат квалификации входящего сообщения (таксономия Cortex).
    # Примеры: OEM_QUERY / VIN_HARD_PICK / ORDER_STATUS / SERVICE_NOTICE / SMALL_TALK /
    # CLARIFY_NUMBER_TYPE / LOST / OUT_OF_SCOPE
    intent: Optional[str] = None

    # Уверенность классификатора/LLM в квалификации (0..1).
    confidence: Optional[float] = None

    # Причина неоднозначности для диагностик/уточняющего вопроса.
    ambiguity_reason: Optional[str] = None

    # Нужно ли обязательно уточнение перед действием.
    requires_clarification: bool = False

    # Нормализованные OEM'ы, которые Cortex увидел/подтвердил.
    oems: List[str] = Field(default_factory=list)

    # Поля лида Bitrix24, которые нужно обновить (STAGE_ID, UF_*, TITLE и т.п.).
    update_lead_fields: Dict[str, Any] = Field(default_factory=dict)

    # Товарные позиции для crm.lead.productrows.set.
    # Здесь оставляем Any, чтобы Node мог гибко строить строки под себя.
    product_rows: List[Any] = Field(default_factory=list)

    # Дополнительно: выбор/рекомендации по товарам (если понадобится).
    product_picks: List[Any] = Field(default_factory=list)

    # Имя клиента (если Cortex смог его понять из диалога).
    client_name: Optional[str] = None

    # Флаг на будущее (например, принудительный перевод на оператора).
    need_operator: bool = False

    # Новый блок: офферы по запчастям (вариант 1 / вариант 2 и т.п.).
    offers: List[Offer] = Field(
        default_factory=list,
        description="Список предложенных вариантов для клиента (вариант 1 / 2 / 3)",
    )

    # Если клиент выбрал вариант(ы) — сюда кладём его/их id (1, 2, 3...).
    # ВАЖНО: поддерживаем как одиночный выбор (int), так и несколько вариантов (List[int]).
    chosen_offer_id: Optional[Union[int, List[int]]] = Field(
        None,
        description="ID выбранного варианта(ов) из offers (1, 2, 3 ...), если выбор уже сделан",
    )

    # Обновление данных по клиенту (ФИО, телефон, адрес).
    contact_update: Optional[ContactUpdate] = Field(
        None,
        description="Структурированные данные по клиенту для обновления Контакта/Лида",
    )

    # Служебные метаданные, которые Node может логировать, но не обязан обрабатывать.
    meta: Dict[str, Any] = Field(
        default_factory=dict,
        description="Служебные метаданные (портал, стратегия, внутренние флаги и т.п.)",
    )

    # Отладочные данные для логов (prompt, raw LLM JSON и т.д. — по минимуму).
    debug: Dict[str, Any] = Field(
        default_factory=dict,
        description="Отладочная информация, не предназначена для клиента",
    )


class CortexResponse(BaseModel):
    """
    Обёртка-ответ HF-CORTEX для Node.
    """
    ok: bool = True
    app: str = "hf-rozatti-py"
    flow: str = "lead_sales"
    stage: Optional[str] = None
    context: Dict[str, Any] = Field(default_factory=dict)
    result: CortexResult
    error: Optional[str] = None
    request_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    ts: str = Field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")
