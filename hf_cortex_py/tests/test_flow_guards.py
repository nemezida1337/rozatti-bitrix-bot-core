from core.models import CortexResult
from flows.lead_sales.flow import run_lead_sales_flow
import flows.lead_sales.flow as lead_sales_flow


def _mk_injected_abcp():
    return {
        "5QM411105R": {
            "offers": [
                {"brand": "VAG", "price": 21800, "minDays": 217, "maxDays": 217},
                {"brand": "VAG", "price": 17700, "minDays": 337, "maxDays": 337},
            ]
        }
    }


def _mk_payload_offers():
    return [
        {
            "id": 1,
            "oem": "5QM411105R",
            "brand": "VAG",
            "name": "VAG 5QM411105R",
            "price": 17700,
            "currency": "RUB",
            "quantity": 1,
            "delivery_days": 12,
        },
        {
            "id": 2,
            "oem": "5QM411105R",
            "brand": "VAG",
            "name": "VAG 5QM411105R",
            "price": 21800,
            "currency": "RUB",
            "quantity": 1,
            "delivery_days": 7,
        },
    ]


def test_flow_sanitizes_invalid_chosen_offer_id(monkeypatch):
    monkeypatch.setattr(
        lead_sales_flow,
        "call_llm_with_cortex_request",
        lambda _req: CortexResult(
            action="reply",
            stage="CONTACT",
            reply="ok",
            chosen_offer_id=999,  # invalid id for current offers
            offers=[],
            oems=[],
            update_lead_fields={},
            product_rows=[],
            product_picks=[],
            meta={},
            debug={},
        ),
    )

    result = run_lead_sales_flow(
        msg={"text": "оформляем"},
        session={"state": {"stage": "CONTACT", "oems": ["5QM411105R"]}},
        injected_abcp=_mk_injected_abcp(),
    )

    assert result.chosen_offer_id is None
    assert isinstance(result.debug, dict)
    assert result.debug.get("chosen_offer_id_invalid") == 999


def test_flow_uses_sticky_choice_from_session(monkeypatch):
    monkeypatch.setattr(
        lead_sales_flow,
        "call_llm_with_cortex_request",
        lambda _req: CortexResult(
            action="reply",
            stage="CONTACT",
            reply="ok",
            chosen_offer_id=None,
            offers=[],
            oems=[],
            update_lead_fields={},
            product_rows=[],
            product_picks=[],
            meta={},
            debug={},
        ),
    )

    result = run_lead_sales_flow(
        msg={"text": "готов оформить"},
        session={
            "state": {
                "stage": "CONTACT",
                "oems": ["5QM411105R"],
                "chosen_offer_id": 2,
            }
        },
        injected_abcp=_mk_injected_abcp(),
    )

    assert result.chosen_offer_id == 2


def test_flow_uses_payload_offers_fallback_without_injected_abcp(monkeypatch):
    seen = {}

    def _fake_llm(req):
        seen["offers"] = req["payload"].get("offers")
        return CortexResult(
            action="reply",
            stage="PRICING",
            reply="ok",
            chosen_offer_id=2,
            offers=[],
            oems=[],
            update_lead_fields={},
            product_rows=[],
            product_picks=[],
            meta={},
            debug={},
        )

    monkeypatch.setattr(lead_sales_flow, "call_llm_with_cortex_request", _fake_llm)

    result = run_lead_sales_flow(
        msg={"text": "беру вариант 2"},
        session={"state": {"stage": "PRICING"}},
        injected_abcp=None,
        payload_offers=_mk_payload_offers(),
    )

    assert isinstance(seen.get("offers"), list)
    assert len(seen["offers"]) == 2
    assert [o.id for o in (result.offers or [])] == [1, 2]
    assert result.chosen_offer_id == 2
    assert isinstance(result.debug, dict)
    assert result.debug.get("offers_source") == "payload"


def test_flow_keeps_policy_clarification_without_hardening_override(monkeypatch):
    monkeypatch.setattr(
        lead_sales_flow,
        "call_llm_with_cortex_request",
        lambda _req: CortexResult(
            action="reply",
            stage="CONTACT",
            reply="ok",
            chosen_offer_id=None,
            offers=[],
            oems=[],
            update_lead_fields={},
            product_rows=[],
            product_picks=[],
            meta={},
            debug={},
        ),
    )

    result = run_lead_sales_flow(
        msg={"text": "102123458"},
        session={"state": {"stage": "CONTACT"}},
        injected_abcp=None,
    )

    assert result.intent == "CLARIFY_NUMBER_TYPE"
    assert result.requires_clarification is True
    assert result.stage == "NEW"
    assert result.action == "reply"
    assert "номер заказа или oem" in (result.reply or "").lower()


def test_flow_keeps_service_notice_policy_without_hardening_override(monkeypatch):
    monkeypatch.setattr(
        lead_sales_flow,
        "call_llm_with_cortex_request",
        lambda _req: CortexResult(
            action="reply",
            stage="CONTACT",
            reply="Напишите ФИО и телефон",
            chosen_offer_id=None,
            offers=[],
            oems=[],
            update_lead_fields={},
            product_rows=[],
            product_picks=[],
            meta={},
            debug={},
        ),
    )

    result = run_lead_sales_flow(
        msg={"text": "Ваш прайс давно не обновлялся на farpost, проверьте packetdated"},
        session={"state": {"stage": "CONTACT"}},
        injected_abcp=None,
    )

    assert result.intent == "SERVICE_NOTICE"
    assert result.requires_clarification is False
    assert result.stage == "IN_WORK"
    assert result.action == "reply"
    assert "проверим обновление прайса" in (result.reply or "").lower()
