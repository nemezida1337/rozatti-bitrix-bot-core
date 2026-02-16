from typing import Any, Dict, Optional, List, Union


def get_stage(session_snapshot: Dict[str, Any]) -> str:
    """Определяет текущую стадию.

    Правило: если state.stage уже "продвинута" (не NEW), она важнее верхнего session.stage,
    потому что верхний stage иногда приходит из CRM-маппинга и может быть устаревшим/NEW.
    """
    if not session_snapshot:
        return "NEW"

    st_top = session_snapshot.get("stage")
    st_top = st_top.strip() if isinstance(st_top, str) else None

    state = session_snapshot.get("state")
    st_state = None
    if isinstance(state, dict):
        st2 = state.get("stage")
        st_state = st2.strip() if isinstance(st2, str) else None

    # Если state.stage уже не NEW — считаем его истиной, даже если верхний stage = NEW/пусто.
    if st_state and st_state.upper() != "NEW":
        return st_state.upper()

    if st_top:
        return st_top.upper()
    if st_state:
        return st_state.upper()
    return "NEW"



def get_session_str(session_snapshot: Dict[str, Any], key: str) -> Optional[str]:
    # верхний уровень
    v = session_snapshot.get(key)
    if isinstance(v, str) and v.strip():
        return v.strip()

    # state.*
    state = session_snapshot.get("state")
    if isinstance(state, dict):
        vv = state.get(key)
        if isinstance(vv, str) and vv.strip():
            return vv.strip()

        # state.lead.*
        lead = state.get("lead")
        if isinstance(lead, dict):
            vvv = lead.get(key)
            if isinstance(vvv, str) and vvv.strip():
                return vvv.strip()

    # lead.*
    lead2 = session_snapshot.get("lead")
    if isinstance(lead2, dict):
        vv2 = lead2.get(key)
        if isinstance(vv2, str) and vv2.strip():
            return vv2.strip()

    return None



def get_session_int(session_snapshot: Dict[str, Any], key: str) -> Optional[int]:
    v = session_snapshot.get(key)
    if isinstance(v, int):
        return v
    if isinstance(v, str) and v.isdigit():
        return int(v)
    state = session_snapshot.get("state")
    if isinstance(state, dict):
        vv = state.get(key)
        if isinstance(vv, int):
            return vv
        if isinstance(vv, str) and vv.isdigit():
            return int(vv)
    return None


def get_session_choice(session_snapshot: Dict[str, Any], key: str) -> Optional[Union[int, List[int]]]:
    """Достаёт chosen_offer_id из sessionSnapshot в виде int или List[int].

    Нужен, потому что Node может хранить выбранные варианты как число или массив.
    """
    if not session_snapshot:
        return None

    def _normalize(v: Any) -> Optional[Union[int, List[int]]]:
        if v is None:
            return None
        if isinstance(v, int):
            return v
        if isinstance(v, str) and v.isdigit():
            return int(v)
        if isinstance(v, list):
            out: List[int] = []
            for x in v:
                try:
                    n = int(str(x).strip())
                    out.append(n)
                except Exception:
                    continue
            out = [x for x in out if x > 0]
            if not out:
                return None
            uniq = sorted(set(out))
            return uniq
        return None

    # верхний уровень
    v = _normalize(session_snapshot.get(key))
    if v is not None:
        return v

    # state.*
    state = session_snapshot.get("state")
    if isinstance(state, dict):
        v2 = _normalize(state.get(key))
        if v2 is not None:
            return v2

    return None
