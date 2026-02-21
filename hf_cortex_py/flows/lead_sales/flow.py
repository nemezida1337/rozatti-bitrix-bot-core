# flows/lead_sales/flow.py (v2 — 10/10 hardening)
# - VIN-guard для requested_oem
# - жёсткая валидация chosen_offer_id (int|list) по canonical offer.id
# - offers/oems всегда канонические (Python), LLM не может их "сломать"
# - мягкий fallback: если chosen_offer_id невалиден → chosen_offer_id=None + debug
#
# REFAC: файл разрезан на модули (parsers/offers/session_utils/hardening/utils).
# В этом файле осталась только оркестрация и сборка контекста.

from typing import Any, Dict, Optional, List

from core.models import CortexResult, Offer
from core.llm_client import call_llm_with_cortex_request

from flows.lead_sales.abcp_summary import summarize_abcp, build_offers_from_abcp
from flows.lead_sales.hardening import apply_strict_funnel
from flows.lead_sales.policy_engine import apply_policy_engine
from flows.lead_sales.offers import (
    build_pricing_reply,
    group_offers_by_oem,
    order_oems,
    reassign_ids_in_order,
    valid_offer_ids,
    sanitize_chosen_offer_id,
)
from flows.lead_sales.parsers.common import get_msg_text
from flows.lead_sales.parsers.oem import extract_oem_from_text, looks_like_vin
from flows.lead_sales.session_utils import get_stage
from flows.lead_sales.utils import to_dict


def _to_int(value: Any) -> Optional[int]:
    try:
        v = int(value)
        if v > 0:
            return v
    except Exception:
        return None
    return None


def _to_float(value: Any) -> Optional[float]:
    try:
        return float(value)
    except Exception:
        return None


def _to_delivery_days(row: Dict[str, Any]) -> Optional[int]:
    for key in ("delivery_days", "minDays", "maxDays"):
        val = _to_int(row.get(key))
        if val is not None:
            return val
    return None


def _build_offers_from_payload(payload_offers: Any) -> List[Offer]:
    out: List[Offer] = []
    if not isinstance(payload_offers, list):
        return out

    seen_ids = set()
    for row in payload_offers:
        if not isinstance(row, dict):
            continue

        offer_id = _to_int(row.get("id"))
        price = _to_float(row.get("price"))
        if offer_id is None or price is None:
            continue
        if offer_id in seen_ids:
            continue

        seen_ids.add(offer_id)

        oem = row.get("oem")
        brand = row.get("brand")
        name = row.get("name")
        currency = row.get("currency")
        quantity = _to_int(row.get("quantity")) or 1
        delivery_days = _to_delivery_days(row)
        source = row.get("source")
        comment = row.get("comment")

        out.append(
            Offer(
                id=offer_id,
                oem=str(oem).strip().upper() if isinstance(oem, str) and oem.strip() else None,
                brand=str(brand).strip() if isinstance(brand, str) and brand.strip() else None,
                name=str(name).strip() if isinstance(name, str) and name.strip() else None,
                price=float(price),
                currency=str(currency).strip() if isinstance(currency, str) and currency.strip() else "RUB",
                quantity=quantity,
                delivery_days=delivery_days,
                source=str(source).strip() if isinstance(source, str) and source.strip() else None,
                comment=str(comment).strip() if isinstance(comment, str) and comment.strip() else None,
            )
        )

    return out


def _extract_ordered_oems_from_offers(offers: List[Offer]) -> List[str]:
    seen = set()
    out: List[str] = []
    for off in offers:
        oem = (off.oem or "").strip().upper()
        if not oem or oem in seen:
            continue
        seen.add(oem)
        out.append(oem)
    return out


def run_lead_sales_flow(
    msg: Any,
    session: Optional[Any] = None,
    injected_abcp: Optional[Dict[str, Any]] = None,
    payload_offers: Optional[List[Dict[str, Any]]] = None,
) -> CortexResult:
    msg_dict = to_dict(msg)
    session_snapshot = to_dict(session)

    stage = get_stage(session_snapshot)

    injected_block: Dict[str, Any] = {
        "has_abcp": False,
        "summary_by_oem": {},
        "offers_by_oem": {},
    }

    if isinstance(injected_abcp, dict) and injected_abcp:
        offers_by_oem = injected_abcp
        summary_by_oem = summarize_abcp(offers_by_oem)

        has_any = False
        try:
            for _oem, pack in offers_by_oem.items():
                if (
                    isinstance(pack, dict)
                    and isinstance(pack.get("offers"), list)
                    and len(pack.get("offers")) > 0
                ):
                    has_any = True
                    break
        except Exception:
            has_any = True

        injected_block = {
            "has_abcp": bool(has_any),
            "summary_by_oem": summary_by_oem,
            "offers_by_oem": offers_by_oem,
        }

    canonical_offers: List[Offer] = []
    canonical_source: Optional[str] = None
    if injected_block["has_abcp"]:
        canonical_offers = build_offers_from_abcp(injected_block["offers_by_oem"])
        if canonical_offers:
            canonical_source = "abcp"

    # Fallback: если ABCP не пришёл, но Node прислал offers — используем их как канон.
    if not canonical_offers:
        canonical_from_payload = _build_offers_from_payload(payload_offers)
        if canonical_from_payload:
            canonical_offers = canonical_from_payload
            canonical_source = "payload"

    # msg_text (канонический)
    msg_text = get_msg_text(msg_dict)
    if msg_text:
        msg_dict["text"] = msg_text  # для промпта/LLM всегда кладём text

    # requested_oem
    requested_oem: Optional[str] = None
    if stage == "NEW":
        requested_oem = extract_oem_from_text(msg_text)

        # fallback: если Node уже сохранил OEM в session.state.oems, а текст почему-то пустой
        if not requested_oem:
            state = session_snapshot.get("state")
            if isinstance(state, dict):
                oems = state.get("oems")
                if isinstance(oems, list) and oems:
                    first = oems[0]
                    if isinstance(first, str) and first.strip():
                        cand = first.strip().upper()
                        if not looks_like_vin(cand):
                            requested_oem = cand
    else:
        state = session_snapshot.get("state")
        if isinstance(state, dict):
            oems = state.get("oems")
            if isinstance(oems, list) and oems:
                first = oems[0]
                if isinstance(first, str) and first.strip():
                    # на всякий: если в state почему-то VIN — игнор
                    cand = first.strip().upper()
                    if not looks_like_vin(cand):
                        requested_oem = cand

    # Если ABCP injected и мы на NEW — не вызываем LLM, сразу отдаём PRICING
    if canonical_source == "abcp" and injected_block["has_abcp"] and canonical_offers and stage == "NEW":
        reply, ordered_oems, ordered_offers = build_pricing_reply(requested_oem, canonical_offers)
        return CortexResult(
            action="reply",
            stage="PRICING",
            reply=reply,
            intent="OEM_QUERY",
            confidence=1.0,
            ambiguity_reason=None,
            requires_clarification=False,
            oems=ordered_oems,
            offers=ordered_offers,
            chosen_offer_id=None,
            update_lead_fields={},
            product_rows=[],
            product_picks=[],
            client_name=None,
            need_operator=False,
            contact_update=None,
            meta={},
            debug={
                "short_path": "abcp_injected_new",
                "requested_oem": requested_oem,
                "offers_source": canonical_source,
            },
        )

    base_context: Dict[str, Any] = {
        "injected_abcp": injected_block,
    }

    cortex_request: Dict[str, Any] = {
        "app": "hf-rozatti-py",
        "flow": "lead_sales",
        "payload": {
            "msg": msg_dict,
            "sessionSnapshot": session_snapshot,
            "baseContext": base_context,
        },
    }

    ordered_offers: List[Offer] = []
    ordered_oems: List[str] = []

    # Если есть офферы — даём LLM уже готовые варианты (канон)
    if canonical_offers:
        if canonical_source == "payload":
            ordered_offers = canonical_offers
            ordered_oems = _extract_ordered_oems_from_offers(ordered_offers)
            req = (requested_oem or "").strip().upper()
            if req and req in ordered_oems:
                ordered_oems = [req] + [x for x in ordered_oems if x != req]
        else:
            grouped = group_offers_by_oem(canonical_offers)
            ordered_oems = order_oems(requested_oem, list(grouped.keys()))
            ordered_offers = reassign_ids_in_order(grouped, ordered_oems)
        cortex_request["payload"]["offers"] = [o.model_dump() for o in ordered_offers]
    else:
        cortex_request["payload"]["offers"] = []

    result: CortexResult = call_llm_with_cortex_request(cortex_request)

    # Истина по офферам — всегда Python canonical (ordered_offers)
    if canonical_offers:
        if canonical_source != "payload":
            # на всякий случай пересоберём, чтобы не зависеть от возможных изменений объектов
            grouped = group_offers_by_oem(canonical_offers)
            ordered_oems = order_oems(requested_oem, list(grouped.keys()))
            ordered_offers = reassign_ids_in_order(grouped, ordered_oems)
        else:
            if not ordered_oems:
                ordered_oems = _extract_ordered_oems_from_offers(ordered_offers)

        result.offers = ordered_offers
        result.oems = ordered_oems

        # Валидируем chosen_offer_id
        valid_ids = valid_offer_ids(result.offers)
        sanitized, dbg = sanitize_chosen_offer_id(result.chosen_offer_id, valid_ids)
        if dbg:
            try:
                if not isinstance(result.debug, dict):
                    result.debug = {}
                result.debug.update(dbg)
            except Exception:
                pass
        result.chosen_offer_id = sanitized

    # ------------------------------------------------
    # POLICY ENGINE: детерминированная квалификация поверх черновика LLM
    # ------------------------------------------------
    result = apply_policy_engine(
        result,
        msg_text=msg_text,
        msg=msg_dict,
        stage_in=stage,
        session_snapshot=session_snapshot,
    )

    # ------------------------------------------------
    # HARDENING: строгая воронка CONTACT -> ADDRESS -> FINAL
    # ------------------------------------------------
    result = apply_strict_funnel(
        result,
        stage_in=stage,
        msg_text=msg_text,
        session_snapshot=session_snapshot,
    )

    # Добавим немного тех. debug (не для клиента)
    try:
        if not isinstance(result.debug, dict):
            result.debug = {}
        result.debug.setdefault("requested_oem", requested_oem)
        result.debug.setdefault("has_abcp", bool(injected_block.get("has_abcp")))
        result.debug.setdefault("offers_source", canonical_source)
        result.debug.setdefault("stage_in", stage)
    except Exception:
        pass

    return result
