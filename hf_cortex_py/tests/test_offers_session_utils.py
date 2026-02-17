from core.models import Offer
from flows.lead_sales.offers import (
    build_pricing_reply,
    format_price_rub,
    group_offers_by_oem,
    order_oems,
    reassign_ids_in_order,
    sanitize_chosen_offer_id,
    valid_offer_ids,
)
from flows.lead_sales.session_utils import get_session_choice, get_session_int, get_session_str


def test_session_utils_str_and_int_resolution_paths():
    snap = {
        "state": {"lead": {"city": "  Moscow  ", "count": "11"}},
        "lead": {"fallback": " yes "},
    }
    assert get_session_str(snap, "city") == "Moscow"
    assert get_session_str(snap, "fallback") == "yes"
    assert get_session_str(snap, "missing") is None
    assert get_session_int({"count": "7"}, "count") == 7
    assert get_session_int({"state": {"count": "12"}}, "count") == 12
    assert get_session_int({"count": "abc"}, "count") is None


def test_session_choice_falls_back_to_state_and_filters_items():
    snap = {"chosen_offer_id": ["x"], "state": {"chosen_offer_id": [3, "4", 0, -1]}}
    assert get_session_choice(snap, "chosen_offer_id") == [3, 4]


def test_format_price_rub_and_grouping_and_ordering():
    class BadFloat:
        def __float__(self):
            raise RuntimeError("bad")

    assert format_price_rub(10600.4) == "10 600"
    bad = BadFloat()
    assert format_price_rub(bad) == str(bad)

    offers = [
        Offer(id=9, oem="A", brand="B1", price=2000, delivery_days=9),
        Offer(id=8, oem="A", brand="B2", price=1000, delivery_days=20),
        Offer(id=7, oem=None, brand="B3", price=1500, delivery_days=None),
    ]
    grouped = group_offers_by_oem(offers)
    assert list(grouped.keys()) == ["A", "UNKNOWN_OEM"]
    assert [o.price for o in grouped["A"]] == [1000.0, 2000.0]

    assert order_oems("A", ["B", "A"]) == ["A", "B"]
    assert order_oems("X", ["B", "A"]) == ["A", "B"]


def test_reassign_build_reply_and_valid_ids():
    grouped = {
        "A": [Offer(id=10, oem="A", brand="BR", price=1200, delivery_days=5)],
        "B": [Offer(id=11, oem="B", brand="BR", price=1500, delivery_days=None)],
    }
    ordered = reassign_ids_in_order(grouped, ["B", "A"])
    assert [o.id for o in ordered] == [1, 2]

    reply, oems, offs = build_pricing_reply("A", ordered)
    assert oems == ["A", "B"]
    assert "По номеру A есть варианты" in reply
    assert "Есть оригинальная замена B" in reply
    assert "срок до 5 раб. дней" in reply
    assert "срок уточним" in reply
    assert "Выберите, пожалуйста" in reply

    class BadId:
        @property
        def id(self):
            raise RuntimeError("bad")

    ids = valid_offer_ids([offs[0], offs[1], BadId()])  # type: ignore[list-item]
    assert ids == {1, 2}


def test_sanitize_chosen_offer_id_variants():
    valid = {1, 2, 3}

    s, d = sanitize_chosen_offer_id(None, valid)
    assert s is None and d == {}

    s, d = sanitize_chosen_offer_id(2, valid)
    assert s == 2 and d == {}

    s, d = sanitize_chosen_offer_id(9, valid)
    assert s is None and d.get("chosen_offer_id_invalid") == 9

    s, d = sanitize_chosen_offer_id([3, 3, 1, "x", 0], valid)
    assert s == [1, 3]
    assert d.get("chosen_offer_id_invalid_items") == ["x", 0]

    s, d = sanitize_chosen_offer_id([], valid)
    assert s is None and d == {}

    s, d = sanitize_chosen_offer_id({"id": 1}, valid)
    assert s is None and "chosen_offer_id_invalid_type" in d
