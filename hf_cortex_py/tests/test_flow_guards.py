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
