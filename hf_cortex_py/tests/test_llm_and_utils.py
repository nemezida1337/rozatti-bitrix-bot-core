import json

from core import llm_client
from flows.lead_sales.session_utils import get_session_choice, get_stage
from flows.lead_sales.utils import to_dict


class _FakeOpenAIClient:
    def __init__(self, raw_content: str, sink: dict):
        self._raw_content = raw_content
        self._sink = sink
        self.chat = self._FakeChat(raw_content, sink)

    class _FakeChat:
        def __init__(self, raw_content: str, sink: dict):
            self.completions = _FakeCompletions(raw_content, sink)


class _FakeCompletions:
    def __init__(self, raw_content: str, sink: dict):
        self._raw_content = raw_content
        self._sink = sink

    def create(self, **kwargs):
        self._sink["kwargs"] = kwargs
        msg = type("Msg", (), {"content": self._raw_content})()
        choice = type("Choice", (), {"message": msg})()
        return type("Completion", (), {"choices": [choice]})()


def test_call_llm_with_cortex_request_falls_back_on_invalid_json(monkeypatch):
    sink = {}
    monkeypatch.setattr(llm_client, "OpenAI", lambda: _FakeOpenAIClient("not-a-json", sink))

    out = llm_client.call_llm_with_cortex_request({"app": "test", "flow": "lead_sales"})

    assert out.action == "reply"
    assert out.stage == "NEW"
    assert out.reply == "not-a-json"
    assert out.chosen_offer_id is None
    assert out.update_lead_fields == {}


def test_call_llm_with_cortex_request_parses_json_and_keeps_contract(monkeypatch):
    sink = {}
    raw = json.dumps(
        {
            "action": "reply",
            "stage": "CONTACT",
            "reply": "ok",
            "client_name": "Иванов Иван Иванович",
            "update_lead_fields": {},
            "contact_update": {},
            "oems": ["5QM411105R"],
            "offers": [],
            "chosen_offer_id": None,
            "product_rows": [],
            "product_picks": [],
            "need_operator": False,
            "meta": {},
            "debug": {},
        },
        ensure_ascii=False,
    )
    monkeypatch.setattr(llm_client, "OpenAI", lambda: _FakeOpenAIClient(raw, sink))

    out = llm_client.call_llm_with_cortex_request({"app": "test", "flow": "lead_sales"})

    assert out.stage == "CONTACT"
    assert out.reply == "ok"
    assert out.update_lead_fields.get("LAST_NAME") == "Иванов"
    assert out.update_lead_fields.get("NAME") == "Иван"
    assert out.update_lead_fields.get("SECOND_NAME") == "Иванович"
    assert sink["kwargs"]["model"] == "gpt-4o-mini"
    assert sink["kwargs"]["response_format"] == {"type": "json_object"}


def test_to_dict_handles_broken_model_dump_and_dict():
    class Broken:
        __slots__ = ()

        def model_dump(self):
            raise RuntimeError("boom")

        def dict(self):
            raise RuntimeError("boom")

    assert to_dict(Broken()) == {}


def test_get_session_choice_ignores_invalid_items_and_prefers_top_level():
    class BadStr:
        def __str__(self):
            raise RuntimeError("boom")

    session = {
        "chosen_offer_id": [1, "2", 0, -1, "abc", BadStr()],
        "state": {"chosen_offer_id": [3, 4]},
    }
    assert get_session_choice(session, "chosen_offer_id") == [1, 2]


def test_get_stage_prefers_state_over_top_when_state_is_advanced():
    session = {"stage": "NEW", "state": {"stage": "CONTACT"}}
    assert get_stage(session) == "CONTACT"


def test_normalize_phone_and_extract_phone_variants():
    assert llm_client.normalize_phone("+7 (999) 000-11-22") == "+79990001122"
    assert llm_client.normalize_phone("8 999 000 11 22") == "+79990001122"
    assert llm_client.normalize_phone("9990001122") == "+79990001122"
    assert llm_client.normalize_phone("12345") is None
    assert llm_client.normalize_phone(None) is None

    assert llm_client.extract_phone("my phone +79990001122") == "+79990001122"
    assert llm_client.extract_phone("no phone here") is None


def test_parse_full_name_handles_order_and_rejects_incomplete():
    fio = llm_client.parse_full_name("Иванов Иван Иванович")
    assert fio == {"last": "Иванов", "first": "Иван", "middle": "Иванович"}

    fio2 = llm_client.parse_full_name("Иван Иванович Иванов")
    assert fio2 == {"last": "Иванов", "first": "Иван", "middle": "Иванович"}

    assert llm_client.parse_full_name("Иванов Иван") == {"last": None, "first": None, "middle": None}
    assert llm_client.parse_full_name(123) == {"last": None, "first": None, "middle": None}


def test_normalize_llm_result_sanitizes_bad_payload_types():
    out = llm_client.normalize_llm_result(
        {
            "action": "reply",
            "stage": "NEW",
            "reply": "ok",
            "update_lead_fields": "bad",
            "contact_update": "bad",
            "oems": None,
            "offers": None,
            "product_rows": None,
            "product_picks": None,
            "meta": None,
            "debug": None,
        }
    )
    assert out.stage == "NEW"
    assert out.update_lead_fields == {}
    assert out.contact_update is None
    assert out.offers == []
    assert out.product_rows == []
    assert out.product_picks == []
    assert out.meta == {}
    assert out.debug == {}


def test_normalize_llm_result_does_not_override_existing_name_fields():
    out = llm_client.normalize_llm_result(
        {
            "stage": "CONTACT",
            "reply": "ok",
            "client_name": "Иванов Иван Иванович",
            "update_lead_fields": {"NAME": "Петр"},
            "contact_update": {},
        }
    )
    assert out.update_lead_fields["NAME"] == "Петр"
    assert out.update_lead_fields["LAST_NAME"] == "Иванов"
    assert out.update_lead_fields["SECOND_NAME"] == "Иванович"
