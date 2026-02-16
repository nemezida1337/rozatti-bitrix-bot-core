from typing import List, Dict, Optional, Tuple, Set, Any

from core.models import Offer


def format_price_rub(price: float) -> str:
    try:
        p = int(round(float(price)))
        return f"{p:,}".replace(",", " ")
    except Exception:
        return str(price)


def group_offers_by_oem(offers: List[Offer]) -> Dict[str, List[Offer]]:
    grouped: Dict[str, List[Offer]] = {}
    for off in offers:
        key = (off.oem or "").strip() or "UNKNOWN_OEM"
        grouped.setdefault(key, []).append(off)

    for k in grouped:
        grouped[k].sort(key=lambda x: (x.price or 0, x.delivery_days or 10**9))
    return grouped


def order_oems(requested_oem: Optional[str], available_oems: List[str]) -> List[str]:
    """
    requested first, затем остальные в алфавитном порядке.
    """
    oems = [x for x in available_oems if x and x != "UNKNOWN_OEM"]
    rest = sorted([x for x in oems if x != requested_oem])
    if requested_oem and requested_oem in oems:
        return [requested_oem] + rest
    return rest


def reassign_ids_in_order(grouped: Dict[str, List[Offer]], ordered_oems: List[str]) -> List[Offer]:
    """
    Перенумеровывает варианты глобально: 1..N в порядке:
      requested OEM офферы, затем replacements офферы.
    """
    new_list: List[Offer] = []
    gid = 1
    for oem in ordered_oems:
        for off in grouped.get(oem, []):
            off.id = gid
            gid += 1
            new_list.append(off)
    return new_list


def build_pricing_reply(
    requested_oem: Optional[str],
    canonical_offers: List[Offer],
) -> Tuple[str, List[str], List[Offer]]:
    grouped = group_offers_by_oem(canonical_offers)
    available_oems = list(grouped.keys())

    ordered_oems = order_oems(requested_oem, available_oems)
    ordered_offers = reassign_ids_in_order(grouped, ordered_oems)

    lines: List[str] = []

    for oem in ordered_oems:
        offers = grouped.get(oem) or []
        if not offers:
            continue

        if requested_oem and oem == requested_oem:
            lines.append(f"Добрый день! По номеру {oem} есть варианты:")
        else:
            lines.append(f"Есть оригинальная замена {oem}:")

        for off in offers:
            brand = off.brand or "OEM"
            price = format_price_rub(off.price)
            if off.delivery_days and off.delivery_days > 0:
                delivery = f"срок до {off.delivery_days} раб. дней"
            else:
                delivery = "срок уточним"
            lines.append(f"Вариант {off.id} — {brand} {oem} за {price} ₽, {delivery}.")

        lines.append("")

    lines.append("Выберите, пожалуйста, подходящий вариант (можно несколько).")
    reply = "\n".join([l for l in lines if l is not None]).strip()

    return reply, ordered_oems, ordered_offers


def valid_offer_ids(offers: List[Offer]) -> Set[int]:
    ids: Set[int] = set()
    for o in offers:
        try:
            if isinstance(o.id, int) and o.id > 0:
                ids.add(o.id)
        except Exception:
            continue
    return ids


def sanitize_chosen_offer_id(
    chosen: Any,
    valid_ids: Set[int],
) -> Tuple[Optional[Any], Dict[str, Any]]:
    """
    Возвращает:
      - sanitized chosen_offer_id (None | int | list[int])
      - debug patch (если были проблемы)
    """
    debug: Dict[str, Any] = {}

    if chosen is None:
        return None, debug

    # int
    if isinstance(chosen, int):
        if chosen in valid_ids:
            return chosen, debug
        debug["chosen_offer_id_invalid"] = chosen
        return None, debug

    # list[int]
    if isinstance(chosen, list):
        sanitized: List[int] = []
        invalid: List[Any] = []
        for x in chosen:
            if isinstance(x, int) and x in valid_ids:
                sanitized.append(x)
            else:
                invalid.append(x)

        sanitized = sorted(list(dict.fromkeys(sanitized)))  # unique + stable
        if invalid:
            debug["chosen_offer_id_invalid_items"] = invalid

        if not sanitized:
            return None, debug

        return sanitized, debug

    # everything else -> drop
    debug["chosen_offer_id_invalid_type"] = str(type(chosen))
    return None, debug
