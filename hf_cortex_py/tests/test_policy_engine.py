from core.models import CortexResult
from flows.lead_sales.policy_engine import apply_policy_engine


def _base_result():
    return CortexResult(
        action="reply",
        stage="NEW",
        reply="ok",
        oems=[],
        offers=[],
        chosen_offer_id=None,
        update_lead_fields={},
        product_rows=[],
        product_picks=[],
        meta={},
        debug={},
    )


def test_policy_marks_service_notice_and_moves_to_in_work():
    result = _base_result()
    out = apply_policy_engine(
        result,
        msg_text="Ваш прайс давно не обновлялся на farpost, проверьте packetdated.",
        msg={},
        stage_in="NEW",
        session_snapshot={},
    )

    assert out.intent == "SERVICE_NOTICE"
    assert out.stage == "IN_WORK"
    assert out.action == "reply"
    assert out.confidence == 1.0
    assert out.requires_clarification is False
    assert "проверим обновление прайса" in (out.reply or "").lower()


def test_policy_marks_order_status_by_context():
    result = _base_result()
    out = apply_policy_engine(
        result,
        msg_text="Добрый день, номер заказа 102123458, подскажите статус",
        msg={},
        stage_in="NEW",
        session_snapshot={},
    )

    assert out.intent == "ORDER_STATUS"
    assert out.stage == "IN_WORK"
    assert out.action == "reply"
    assert out.requires_clarification is False
    assert out.ambiguity_reason is None


def test_policy_marks_ambiguous_number_and_forces_clarification():
    result = _base_result()
    out = apply_policy_engine(
        result,
        msg_text="102123458",
        msg={},
        stage_in="NEW",
        session_snapshot={},
    )

    assert out.intent == "CLARIFY_NUMBER_TYPE"
    assert out.stage == "NEW"
    assert out.action == "reply"
    assert out.requires_clarification is True
    assert out.ambiguity_reason == "NUMBER_TYPE_AMBIGUOUS"
    assert "номер заказа или oem" in (out.reply or "").lower()


def test_policy_marks_short_ambiguous_number_and_forces_clarification():
    result = _base_result()
    out = apply_policy_engine(
        result,
        msg_text="4655",
        msg={},
        stage_in="NEW",
        session_snapshot={},
    )

    assert out.intent == "CLARIFY_NUMBER_TYPE"
    assert out.stage == "NEW"
    assert out.action == "reply"
    assert out.requires_clarification is True
    assert out.ambiguity_reason == "NUMBER_TYPE_AMBIGUOUS"


def test_policy_marks_vin_hard_pick():
    result = _base_result()
    out = apply_policy_engine(
        result,
        msg_text="VIN WDB2110421A123456",
        msg={},
        stage_in="NEW",
        session_snapshot={},
    )

    assert out.intent == "VIN_HARD_PICK"
    assert out.stage == "HARD_PICK"
    assert out.action == "handover_operator"
    assert out.need_operator is True


def test_policy_prefers_oem_query_for_mixed_oem_vin():
    result = _base_result()
    result.action = "handover_operator"
    result.stage = "HARD_PICK"
    out = apply_policy_engine(
        result,
        msg_text="VIN WDB2110421A123456 и номер 52105A67977",
        msg={},
        stage_in="NEW",
        session_snapshot={},
    )

    assert out.intent == "OEM_QUERY"
    assert out.action == "abcp_lookup"
    assert out.need_operator is False
    assert out.stage == "PRICING"


def test_policy_marks_explicit_lost():
    result = _base_result()
    out = apply_policy_engine(
        result,
        msg_text="Не актуально, спасибо",
        msg={},
        stage_in="CONTACT",
        session_snapshot={},
    )

    assert out.intent == "LOST"
    assert out.stage == "LOST"
    assert out.action == "reply"
    assert out.need_operator is False


def test_policy_backfills_oem_query_intent():
    result = _base_result()
    result.action = "abcp_lookup"
    result.stage = "PRICING"
    result.oems = ["5QM411105R"]

    out = apply_policy_engine(
        result,
        msg_text="",
        msg={},
        stage_in="NEW",
        session_snapshot={},
    )

    assert out.intent == "OEM_QUERY"
