from core.models import CortexResult, Offer

from flows.lead_sales.hardening import apply_strict_funnel
from flows.lead_sales.parsers.address import extract_address_or_pickup_raw
from flows.lead_sales.parsers.choice import extract_offer_choice_from_text
from flows.lead_sales.parsers.phone import extract_phone_from_text
from flows.lead_sales.parsers.quantity import extract_quantity_from_text


def test_address_pickup():
    assert extract_address_or_pickup_raw("Самовывоз") == "Самовывоз"


def test_address_normal():
    txt = "г.Москва ул.Челюскинцев 15г"
    assert extract_address_or_pickup_raw(txt) == txt


def test_address_does_not_capture_fio_phone():
    # Классический ложноположительный кейс: ФИО + телефон (без адресных маркеров)
    txt = "Можанов Александр Михайлович +79889945791"
    assert extract_address_or_pickup_raw(txt) is None


def test_address_can_capture_real_address_even_if_phone_present():
    txt = "Москва, ул. Пушкина 1, +79889945791"
    assert extract_address_or_pickup_raw(txt) == txt


def test_choice_and_qty_do_not_conflict():
    valid = [1, 2, 3]
    txt = "первый вариант 2 шт"

    assert extract_offer_choice_from_text(txt, valid) == 1
    assert extract_quantity_from_text(txt) == 2

    assert extract_offer_choice_from_text("2 шт", valid) is None
    assert extract_offer_choice_from_text("вариант 2", valid) == 2


def test_quantity_parses_x_formats():
    assert extract_quantity_from_text("беру x2") == 2
    assert extract_quantity_from_text("беру 3x") == 3


def test_quantity_handles_empty_and_clamps():
    assert extract_quantity_from_text("") is None
    assert extract_quantity_from_text(None) is None
    assert extract_quantity_from_text("беру 0 шт") == 1
    assert extract_quantity_from_text("беру x150") == 99


def test_phone_parser_variants():
    assert extract_phone_from_text("+7 (999) 000-11-22") == "+79990001122"
    assert extract_phone_from_text("8 999 000 11 22") == "+79990001122"
    assert extract_phone_from_text("9990001122") == "+79990001122"
    assert extract_phone_from_text("no phone") is None
    assert extract_phone_from_text(None) is None


def test_strict_funnel_applies_quantity_to_chosen_offer():
    result = CortexResult(
        action="reply",
        stage="CONTACT",
        reply="",
        offers=[Offer(id=1, price=1000.0), Offer(id=2, price=2000.0)],
        chosen_offer_id=None,
        update_lead_fields={},
    )

    out = apply_strict_funnel(
        result,
        stage_in="CONTACT",
        msg_text="вариант 2 x3",
        session_snapshot={},
    )

    assert out.chosen_offer_id == 2
    assert out.offers[0].quantity == 1
    assert out.offers[1].quantity == 3
    assert (out.meta or {}).get("requested_qty") == 3


def test_strict_funnel_moves_to_final_on_address_when_contact_ready():
    # Если на входе ADDRESS и уже есть ФИО/телефон в сессии, а в сообщении адрес —
    # hardening должен перевести в FINAL.
    result = CortexResult(action="reply", stage="ADDRESS", reply="", offers=[Offer(id=1, price=1.0)])

    session_snapshot = {
        "state": {
            "stage": "ADDRESS",
        },
        "client_name": "Иванов Иван Иванович",
        "phone": "+79889945791",
    }

    out = apply_strict_funnel(
        result,
        stage_in="ADDRESS",
        msg_text="Самовывоз",
        session_snapshot=session_snapshot,
    )

    assert out.stage == "FINAL"
    assert out.update_lead_fields.get("DELIVERY_ADDRESS") == "Самовывоз"


def test_strict_funnel_contact_does_not_set_delivery_address_from_fio_phone():
    result = CortexResult(
        action="reply",
        stage="CONTACT",
        reply="",
        offers=[Offer(id=1, price=1.0)],
        chosen_offer_id=1,
        update_lead_fields={},
    )

    out = apply_strict_funnel(
        result,
        stage_in="CONTACT",
        msg_text="Иванов Иван Иванович +79990001122",
        session_snapshot={},
    )

    assert out.stage == "ADDRESS"
    assert "DELIVERY_ADDRESS" not in (out.update_lead_fields or {})


def test_strict_funnel_keeps_lost_stage():
    result = CortexResult(
        action="reply",
        stage="LOST",
        reply="Не актуально",
        offers=[Offer(id=1, price=1.0)],
        chosen_offer_id=1,
        update_lead_fields={},
    )

    out = apply_strict_funnel(
        result,
        stage_in="CONTACT",
        msg_text="не нужно",
        session_snapshot={
            "state": {
                "stage": "CONTACT",
                "chosen_offer_id": 1,
                "client_name": "Иванов Иван Иванович",
                "phone": "+79990001122",
                "delivery_address": "Самовывоз",
            }
        },
    )

    assert out.stage == "LOST"
    assert out.reply == "Не актуально"


def test_strict_funnel_keeps_handover_operator_stage():
    result = CortexResult(
        action="handover_operator",
        stage="HARD_PICK",
        reply="Передаю менеджеру",
        need_operator=True,
        offers=[Offer(id=1, price=1.0)],
        chosen_offer_id=1,
        update_lead_fields={},
    )

    out = apply_strict_funnel(
        result,
        stage_in="CONTACT",
        msg_text="скину VIN",
        session_snapshot={
            "state": {
                "stage": "CONTACT",
                "chosen_offer_id": 1,
                "client_name": "Иванов Иван Иванович",
                "phone": "+79990001122",
                "delivery_address": "Самовывоз",
            }
        },
    )

    assert out.stage == "HARD_PICK"
    assert out.action == "handover_operator"
    assert out.need_operator is True
