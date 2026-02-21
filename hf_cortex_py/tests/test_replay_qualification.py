import copy
import json
from pathlib import Path
from typing import Any, Dict, List, Tuple

from core.models import CortexResult
from flows.lead_sales.flow import run_lead_sales_flow
import flows.lead_sales.flow as lead_sales_flow

FIXTURE_FILE = Path(__file__).parent / "fixtures" / "replay_qualification" / "cases.v1.json"


def _load_fixture() -> Dict[str, Any]:
    with open(FIXTURE_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def _default_llm_stub() -> Dict[str, Any]:
    return {
        "action": "reply",
        "stage": "NEW",
        "reply": "ok",
        "oems": [],
        "offers": [],
        "chosen_offer_id": None,
        "update_lead_fields": {},
        "product_rows": [],
        "product_picks": [],
        "meta": {},
        "debug": {},
    }


def _mk_stub_result(stub: Dict[str, Any]) -> CortexResult:
    payload = _default_llm_stub()
    payload.update(stub or {})
    return CortexResult(**payload)


def _to_dict(model: Any) -> Dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


def _prepare_llm_stub(monkeypatch, case: Dict[str, Any]) -> None:
    if case.get("forbid_llm"):
        monkeypatch.setattr(
            lead_sales_flow,
            "call_llm_with_cortex_request",
            lambda _req: (_ for _ in ()).throw(
                AssertionError(f"LLM must not be called for replay case '{case['id']}'")
            ),
        )
        return

    stub_result = _mk_stub_result(case.get("llm_stub") or {})

    def _fake_llm(_req):
        # flow/policy/hardening мутируют result, поэтому отдаём копию.
        return copy.deepcopy(stub_result)

    monkeypatch.setattr(lead_sales_flow, "call_llm_with_cortex_request", _fake_llm)


def _check_expected(actual: Dict[str, Any], expected: Dict[str, Any]) -> List[str]:
    errors: List[str] = []

    for key, exp_value in (expected or {}).items():
        if key == "reply_contains":
            actual_reply = str(actual.get("reply") or "").lower()
            if str(exp_value).lower() not in actual_reply:
                errors.append(
                    f"reply does not contain '{exp_value}' (actual='{actual.get('reply')}')"
                )
            continue

        if key == "offers_count":
            actual_count = len(actual.get("offers") or [])
            if actual_count != int(exp_value):
                errors.append(f"offers_count expected={exp_value} actual={actual_count}")
            continue

        if key == "oems_count":
            actual_count = len(actual.get("oems") or [])
            if actual_count != int(exp_value):
                errors.append(f"oems_count expected={exp_value} actual={actual_count}")
            continue

        actual_value = actual.get(key)
        if actual_value != exp_value:
            errors.append(f"{key} expected={exp_value!r} actual={actual_value!r}")

    return errors


def _run_case(case: Dict[str, Any], monkeypatch) -> Tuple[Dict[str, Any], List[str]]:
    _prepare_llm_stub(monkeypatch, case)

    result = run_lead_sales_flow(
        msg=case.get("msg") or {},
        session=case.get("session") or {},
        injected_abcp=case.get("injected_abcp"),
        payload_offers=case.get("payload_offers"),
    )
    actual = _to_dict(result)

    errors = _check_expected(actual, case.get("expected") or {})
    return actual, errors


def test_replay_qualification_cases(monkeypatch):
    payload = _load_fixture()
    cases = payload.get("cases") or []
    assert len(cases) > 0, "Replay fixture has no cases."

    failures: List[str] = []
    for case in cases:
        case_id = case.get("id") or "unknown_case"
        actual, errors = _run_case(case, monkeypatch)
        if errors:
            failures.append(
                "\n".join(
                    [
                        f"[{case_id}] " + "; ".join(errors),
                        f"  message={case.get('msg', {}).get('text')!r}",
                        f"  actual_intent={actual.get('intent')!r} stage={actual.get('stage')!r} action={actual.get('action')!r}",
                    ]
                )
            )

    assert not failures, "Replay qualification mismatches:\n" + "\n".join(failures)


def test_replay_qualification_key_intent_accuracy(monkeypatch):
    payload = _load_fixture()
    cases = payload.get("cases") or []
    thresholds = payload.get("min_accuracy_by_intent") or {}
    key_intents = payload.get("key_intents") or []

    stats: Dict[str, Dict[str, int]] = {}
    for case in cases:
        intent_class = str(case.get("intent_class") or case.get("expected", {}).get("intent") or "").upper()
        if not intent_class:
            continue
        if key_intents and intent_class not in key_intents:
            continue

        rec = stats.setdefault(intent_class, {"total": 0, "passed": 0})
        rec["total"] += 1

        _, errors = _run_case(case, monkeypatch)
        if not errors:
            rec["passed"] += 1

    violations: List[str] = []
    for intent, min_acc in thresholds.items():
        intent_key = str(intent).upper()
        rec = stats.get(intent_key, {"total": 0, "passed": 0})
        total = rec["total"]
        passed = rec["passed"]
        acc = (passed / total) if total > 0 else 0.0

        if total == 0:
            violations.append(f"{intent_key}: no replay cases")
            continue

        if acc < float(min_acc):
            violations.append(
                f"{intent_key}: accuracy={acc:.3f}, threshold={float(min_acc):.3f}, passed={passed}, total={total}"
            )

    assert not violations, "Key intent accuracy degraded:\n" + "\n".join(violations)
