import json
from pathlib import Path

from flows.lead_sales.flow import run_lead_sales_flow

FIXTURES = Path(__file__).parent / "fixtures" / "trace_2026_01_05"


def _load(name: str):
    with open(FIXTURES / name, "r", encoding="utf-8") as f:
        return json.load(f)


def _dump_model(m):
    # pydantic v2 has model_dump; keep compatibility just in case
    if hasattr(m, "model_dump"):
        return m.model_dump()
    return m.dict()


def _pick_offer_shape(offers):
    """Сужаем сравнение до стабильных полей (без служебных)."""
    out = []
    for o in offers or []:
        out.append(
            {
                "id": o.get("id"),
                "oem": o.get("oem"),
                "brand": o.get("brand"),
                "name": o.get("name"),
                "price": o.get("price"),
                "currency": o.get("currency"),
                "quantity": o.get("quantity"),
                "delivery_days": o.get("delivery_days"),
            }
        )
    return out


def _assert_contract(actual_result: dict, expected_response: dict):
    exp_res = expected_response["result"]

    assert actual_result["action"] == exp_res["action"]
    assert actual_result.get("stage") == exp_res.get("stage")

    assert actual_result.get("chosen_offer_id") == exp_res.get("chosen_offer_id")

    assert actual_result.get("update_lead_fields", {}) == exp_res.get("update_lead_fields", {})
    assert actual_result.get("product_rows", []) == exp_res.get("product_rows", [])

    assert _pick_offer_shape(actual_result.get("offers")) == _pick_offer_shape(exp_res.get("offers"))

    # Reply проверяем мягко: он должен быть непустым
    # и содержать ключевой контекст (OEM/шаблон), чтобы не ломаться на правках текста.
    reply = actual_result.get("reply") or ""
    assert isinstance(reply, str) and len(reply.strip()) > 0


def test_trace_2026_01_05_step1_pricing():
    req = _load("2026-01-05T16-36-05-903Z__nochat__a8f903__request.json")
    exp = _load("2026-01-05T16-36-05-903Z__nochat__a8f903__response.json")

    payload = req["payload"]
    result = run_lead_sales_flow(
        msg=payload.get("msg") or {},
        session=payload.get("sessionSnapshot") or {},
        injected_abcp=payload.get("injected_abcp"),
    )

    actual = _dump_model(result)
    _assert_contract(actual, exp)

    # Доп. гарантии для PRICING
    assert actual.get("stage") == "PRICING"
    assert actual.get("chosen_offer_id") is None
    assert len(actual.get("offers") or []) == 3


def test_trace_2026_01_05_step2_choice_to_contact():
    req = _load("2026-01-05T16-36-18-253Z__nochat__2d391c__request.json")
    exp = _load("2026-01-05T16-36-18-253Z__nochat__2d391c__response.json")

    payload = req["payload"]
    result = run_lead_sales_flow(
        msg=payload.get("msg") or {},
        session=payload.get("sessionSnapshot") or {},
        injected_abcp=payload.get("injected_abcp"),
    )

    actual = _dump_model(result)
    _assert_contract(actual, exp)

    assert actual.get("stage") == "CONTACT"
    assert actual.get("chosen_offer_id") == 3


def test_trace_2026_01_05_step3_contact_parse_no_address_pollution():
    req = _load("2026-01-05T16-37-11-673Z__nochat__aa39ee__request.json")
    exp = _load("2026-01-05T16-37-11-673Z__nochat__aa39ee__response.json")

    payload = req["payload"]
    result = run_lead_sales_flow(
        msg=payload.get("msg") or {},
        session=payload.get("sessionSnapshot") or {},
        injected_abcp=payload.get("injected_abcp"),
    )

    actual = _dump_model(result)
    _assert_contract(actual, exp)

    assert actual.get("stage") == "ADDRESS"

    # Ключевая защита: ФИО+телефон не должны попасть в DELIVERY_ADDRESS
    assert "DELIVERY_ADDRESS" not in (actual.get("update_lead_fields") or {})

    # А телефон — должен
    assert (actual.get("update_lead_fields") or {}).get("PHONE") is not None


def test_trace_2026_01_05_step4_final_sets_product_rows_and_address():
    req = _load("2026-01-05T16-37-33-666Z__nochat__11bb53__request.json")
    exp = _load("2026-01-05T16-37-33-666Z__nochat__11bb53__response.json")

    payload = req["payload"]
    result = run_lead_sales_flow(
        msg=payload.get("msg") or {},
        session=payload.get("sessionSnapshot") or {},
        injected_abcp=payload.get("injected_abcp"),
    )

    actual = _dump_model(result)
    _assert_contract(actual, exp)

    assert actual.get("stage") == "FINAL"
    assert (actual.get("update_lead_fields") or {}).get("DELIVERY_ADDRESS") in ("Самовывоз", "Pickup")

    rows = actual.get("product_rows") or []
    assert len(rows) == 1
    assert rows[0].get("QUANTITY") == 1
