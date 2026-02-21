import re
from typing import Any, Dict, Optional, Set

from core.models import CortexResult
from flows.lead_sales.parsers.oem import looks_like_vin
from flows.lead_sales.parsers.phone import extract_phone_from_text

SERVICE_REPLY = "Спасибо за уведомление, проверим обновление прайса."
CLARIFY_NUMBER_REPLY = "Подскажите, пожалуйста, это номер заказа или OEM (номер детали)?"
ORDER_STATUS_REPLY = "Принял номер заказа, проверим статус и вернемся с обновлением."
HARD_PICK_REPLY = (
    "По такому запросу нужен сложный подбор по ВИН/фото, передаю вашу заявку менеджеру. "
    "Он свяжется с вами и уточнит детали."
)
LOST_REPLY = "Понял вас. Если понадобится подбор — напишите, пожалуйста."

VIN_HINT_RE = re.compile(r"\b(vin|вин)\b", re.IGNORECASE)
PHOTO_HINT_RE = re.compile(r"(фото|картинк|скрин|видео)", re.IGNORECASE)

SERVICE_PRICE_STALE_RE = re.compile(
    r"(ваш\s+прайс|прайс[^\n]{0,120}не\s+обновлял|не\s+обновлял(?:ся|ось))",
    re.IGNORECASE,
)
SERVICE_MARKETPLACE_RE = re.compile(r"(farpost|packetdated|tg\.good\.packet)", re.IGNORECASE)

ORDER_STATUS_HINT_RE = re.compile(
    r"(номер\s+заказа|заказ\s*№|статус\s+заказа|где\s+заказ|по\s+заказу|order\s*#|order\s+number)",
    re.IGNORECASE,
)
DIGIT_TOKEN_RE = re.compile(r"\b\d{4,12}\b")
ALNUM_TOKEN_RE = re.compile(r"[A-Za-z0-9]{6,25}")

LOST_RE = re.compile(
    r"(не\s*актуаль|не\s*нужн|не\s*интерес|отбой|откаж|передумал|не\s*буду\s*брать)",
    re.IGNORECASE,
)

INTENT_SERVICE_NOTICE = "SERVICE_NOTICE"
INTENT_CLARIFY_NUMBER = "CLARIFY_NUMBER_TYPE"
INTENT_ORDER_STATUS = "ORDER_STATUS"
INTENT_VIN_HARD_PICK = "VIN_HARD_PICK"
INTENT_LOST = "LOST"
INTENT_OEM_QUERY = "OEM_QUERY"
MIXED_OEM_VIN_REPLY = "Принял номер детали, подберу варианты и вернусь с ценой и сроком."


def _msg_text(msg_text: str) -> str:
    return str(msg_text or "").strip()


def _collect_digit_tokens(text: str) -> Set[str]:
    return set(DIGIT_TOKEN_RE.findall(text or ""))


def _has_vin_token(text: str) -> bool:
    for tok in ALNUM_TOKEN_RE.findall((text or "").upper()):
        if looks_like_vin(tok):
            return True
    return False


def _has_oem_like_alpha_num(text: str) -> bool:
    for tok in ALNUM_TOKEN_RE.findall((text or "").upper()):
        if tok.isdigit():
            continue
        has_alpha = any(ch.isalpha() for ch in tok)
        has_digit = any(ch.isdigit() for ch in tok)
        if has_alpha and has_digit and not looks_like_vin(tok):
            return True
    return False


def _looks_like_service_notice(text: str) -> bool:
    if not text:
        return False
    return bool(SERVICE_PRICE_STALE_RE.search(text) and SERVICE_MARKETPLACE_RE.search(text))


def _looks_like_order_status(text: str, digit_tokens: Set[str]) -> bool:
    if not text or not digit_tokens:
        return False
    return bool(ORDER_STATUS_HINT_RE.search(text))


def _looks_like_ambiguous_number(text: str, digit_tokens: Set[str]) -> bool:
    if not text or not digit_tokens:
        return False
    if len(digit_tokens) != 1:
        return False
    if _has_oem_like_alpha_num(text):
        return False
    if _has_vin_token(text):
        return False
    if _looks_like_order_status(text, digit_tokens):
        return False
    if extract_phone_from_text(text):
        return False
    return True


def _looks_like_hard_pick(text: str) -> bool:
    if not text:
        return False
    if _has_vin_token(text):
        return True
    if VIN_HINT_RE.search(text):
        return True
    if PHOTO_HINT_RE.search(text):
        return True
    return False


def _looks_like_mixed_oem_vin(text: str) -> bool:
    if not text:
        return False
    if not _has_vin_token(text):
        return False
    if not _has_oem_like_alpha_num(text):
        return False
    if PHOTO_HINT_RE.search(text):
        return False
    return True


def _apply_service_notice(result: CortexResult) -> CortexResult:
    result.intent = INTENT_SERVICE_NOTICE
    result.confidence = 1.0
    result.ambiguity_reason = None
    result.requires_clarification = False
    result.action = "reply"
    result.stage = "IN_WORK"
    result.need_operator = False
    result.oems = []
    result.chosen_offer_id = None
    result.product_rows = []
    result.product_picks = []
    result.reply = SERVICE_REPLY
    return result


def _apply_order_status(result: CortexResult) -> CortexResult:
    result.intent = INTENT_ORDER_STATUS
    result.confidence = max(float(result.confidence or 0.0), 0.95)
    result.ambiguity_reason = None
    result.requires_clarification = False
    result.action = "reply"
    result.stage = "IN_WORK"
    result.need_operator = False
    result.oems = []
    result.chosen_offer_id = None
    result.product_rows = []
    result.product_picks = []
    if not isinstance(result.reply, str) or not result.reply.strip():
        result.reply = ORDER_STATUS_REPLY
    return result


def _apply_ambiguous_number(result: CortexResult) -> CortexResult:
    result.intent = INTENT_CLARIFY_NUMBER
    result.confidence = 1.0
    result.ambiguity_reason = "NUMBER_TYPE_AMBIGUOUS"
    result.requires_clarification = True
    result.action = "reply"
    result.need_operator = False
    result.stage = "NEW"
    result.oems = []
    result.chosen_offer_id = None
    result.product_rows = []
    result.product_picks = []
    result.reply = CLARIFY_NUMBER_REPLY
    return result


def _apply_hard_pick(result: CortexResult) -> CortexResult:
    result.intent = INTENT_VIN_HARD_PICK
    result.confidence = max(float(result.confidence or 0.0), 0.99)
    result.ambiguity_reason = None
    result.requires_clarification = False
    result.action = "handover_operator"
    result.stage = "HARD_PICK"
    result.need_operator = True
    result.oems = []
    result.chosen_offer_id = None
    result.product_rows = []
    result.product_picks = []
    if not isinstance(result.reply, str) or not result.reply.strip():
        result.reply = HARD_PICK_REPLY
    return result


def _apply_mixed_oem_vin(result: CortexResult) -> CortexResult:
    result.intent = INTENT_OEM_QUERY
    result.confidence = max(float(result.confidence or 0.0), 0.95)
    result.ambiguity_reason = None
    result.requires_clarification = False
    result.need_operator = False

    current_action = str(result.action or "").lower()
    if current_action in {"", "handover_operator"}:
        result.action = "abcp_lookup"

    current_stage = str(result.stage or "").upper()
    if current_stage in {"", "HARD_PICK", "LOST"}:
        result.stage = "PRICING"

    if not isinstance(result.reply, str) or not result.reply.strip():
        result.reply = MIXED_OEM_VIN_REPLY
    return result


def _apply_lost(result: CortexResult) -> CortexResult:
    result.intent = INTENT_LOST
    result.confidence = max(float(result.confidence or 0.0), 0.99)
    result.ambiguity_reason = None
    result.requires_clarification = False
    result.action = "reply"
    result.stage = "LOST"
    result.need_operator = False
    result.chosen_offer_id = None
    result.product_rows = []
    result.product_picks = []
    if not isinstance(result.reply, str) or not result.reply.strip():
        result.reply = LOST_REPLY
    return result


def _backfill_intent(result: CortexResult) -> None:
    if isinstance(result.intent, str) and result.intent.strip():
        return

    stage = str(result.stage or "").upper()
    action = str(result.action or "").lower()
    if stage == "LOST":
        result.intent = INTENT_LOST
        return
    if stage == "HARD_PICK" or action == "handover_operator" or bool(result.need_operator):
        result.intent = INTENT_VIN_HARD_PICK
        return
    if action == "abcp_lookup" or (isinstance(result.oems, list) and len(result.oems) > 0):
        result.intent = INTENT_OEM_QUERY


def apply_policy_engine(
    result: CortexResult,
    *,
    msg_text: str,
    msg: Optional[Dict[str, Any]] = None,
    stage_in: Optional[str] = None,
    session_snapshot: Optional[Dict[str, Any]] = None,
) -> CortexResult:
    # msg/stage_in/session_snapshot оставлены в подписи для дальнейших правил.
    _ = msg
    _ = stage_in
    _ = session_snapshot

    text = _msg_text(msg_text)
    if not text:
        _backfill_intent(result)
        return result

    digit_tokens = _collect_digit_tokens(text)

    if _looks_like_service_notice(text):
        return _apply_service_notice(result)

    if _looks_like_order_status(text, digit_tokens):
        return _apply_order_status(result)

    if _looks_like_ambiguous_number(text, digit_tokens):
        return _apply_ambiguous_number(result)

    if _looks_like_mixed_oem_vin(text):
        return _apply_mixed_oem_vin(result)

    if _looks_like_hard_pick(text):
        return _apply_hard_pick(result)

    if LOST_RE.search(text):
        return _apply_lost(result)

    _backfill_intent(result)
    return result
