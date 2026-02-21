from flows.lead_sales.parsers.common import get_msg_text, normalize_text
from flows.lead_sales.parsers.oem import extract_oem_from_text, looks_like_vin


def test_get_msg_text_reads_top_level_and_nested_shapes():
    assert get_msg_text({"text": " hello "}) == "hello"
    assert get_msg_text({"MESSAGE": "Привет"}) == "Привет"
    assert get_msg_text({"message": {"text": "nested"}}) == "nested"
    assert get_msg_text({"data": {"TEXT": "up"}}) == "up"
    assert get_msg_text({"payload": {"body": "payload-body"}}) == "payload-body"


def test_get_msg_text_returns_empty_for_non_dict_or_missing_text():
    assert get_msg_text(None) == ""
    assert get_msg_text("text") == ""
    assert get_msg_text({"message": {"x": 1}}) == ""


def test_normalize_text_compacts_spaces_and_unicode_forms():
    src = "  Иванов\tИван\nИванович   "
    assert normalize_text(src) == "Иванов Иван Иванович"


def test_looks_like_vin_strict_rules():
    assert looks_like_vin("WDB2110421A123456") is True
    assert looks_like_vin("wdb2110421a123456") is True
    assert looks_like_vin("WDB2110421A12345") is False  # len 16
    assert looks_like_vin("WDB2110421A12345I") is False  # forbidden I
    assert looks_like_vin(123) is False


def test_extract_oem_from_text_ignores_vin_and_picks_best_token():
    text = "VIN WDB2110421A123456 и номер 5QM411105R"
    assert extract_oem_from_text(text) == "5QM411105R"

    # Between candidates in 6..20 range it should prefer longer one.
    assert extract_oem_from_text("номера ABC123 and 4N0907998") == "4N0907998"

    # Empty / unsupported input
    assert extract_oem_from_text("") is None
    assert extract_oem_from_text("VIN WDB2110421A123456") is None


def test_extract_oem_from_text_ignores_url_and_order_number_context():
    assert (
        extract_oem_from_text("https://site.ru/?utm_source=chat30792&utm_campaign=QWERTY123456")
        is None
    )
    assert extract_oem_from_text("Добрый день, номер заказа 102123458") is None


def test_extract_oem_from_text_ignores_pure_word_tokens():
    assert extract_oem_from_text("LFV3B20V0P3507500 Volkswagen Talagon") is None
    assert extract_oem_from_text("Volkswagen Talagon") is None
