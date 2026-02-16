from typing import Any, Dict, Optional, List

from core.models import Offer


def _get_price(off: Dict[str, Any]) -> Optional[float]:
    val = off.get("price")
    if isinstance(val, (int, float)):
        return float(val)
    return None


def _get_min_days(off: Dict[str, Any]) -> Optional[int]:
    """
    Берём минимальный срок поставки:
    - приоритет minDays
    - если его нет, используем maxDays
    """
    md = off.get("minDays")
    xd = off.get("maxDays")

    if isinstance(md, (int, float)):
        return int(md)
    if isinstance(xd, (int, float)):
        return int(xd)
    return None


def _pick_fastest(offers: list[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    Вариант 1 — самый быстрый:
      - сортируем по min_days (возрастание)
      - при равенстве по price (возрастание)
    """
    scored = []
    for off in offers:
        if not isinstance(off, dict):
            continue
        price = _get_price(off)
        days = _get_min_days(off)
        if days is None:
            continue
        scored.append((days, price if price is not None else float("inf"), off))

    if not scored:
        return None

    scored.sort(key=lambda x: (x[0], x[1]))
    _, _, best = scored[0]
    return _compact_offer(best)


def _pick_cheapest(offers: list[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    Вариант 2 — самый дешёвый:
      - сортируем по price (возрастание)
      - при равенстве по min_days (возрастание)
    """
    scored = []
    for off in offers:
        if not isinstance(off, dict):
            continue
        price = _get_price(off)
        if price is None:
            continue
        days = _get_min_days(off)
        scored.append((price, days if days is not None else 10**9, off))

    if not scored:
        return None

    scored.sort(key=lambda x: (x[0], x[1]))
    _, _, best = scored[0]
    return _compact_offer(best)


def _compact_offer(off: Dict[str, Any]) -> Dict[str, Any]:
    """
    Компактное представление одного оффера:
      - price, minDays, maxDays
      - плюс немного метаданных, если они есть (brand, name, supplier).
    Это удобно для LLM и для логов.
    """
    price = _get_price(off)
    md = off.get("minDays")
    xd = off.get("maxDays")

    result: Dict[str, Any] = {}

    if price is not None:
        result["price"] = price
    if isinstance(md, (int, float)):
        result["minDays"] = int(md)
    if isinstance(xd, (int, float)):
        result["maxDays"] = int(xd)

    # Немного контекста, но без лишнего шума
    for key in ("brand", "name", "article", "supplier", "isOriginal", "isOem"):
        if key in off:
            result[key] = off[key]

    return result


def summarize_abcp(abcp: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """
    Сводка по ABCP-ответу для каждого OEM.
    """
    summary: Dict[str, Dict[str, Any]] = {}

    for oem, data in (abcp or {}).items():
        if not isinstance(data, dict):
            continue

        offers = data.get("offers") or []
        if not isinstance(offers, list):
            offers = []

        prices: list[float] = []
        days: list[int] = []

        for off in offers:
            if not isinstance(off, dict):
                continue

            price_val = _get_price(off)
            if price_val is not None:
                prices.append(price_val)

            md = off.get("minDays")
            xd = off.get("maxDays")
            if isinstance(md, (int, float)):
                days.append(int(md))
            if isinstance(xd, (int, float)):
                days.append(int(xd))

        min_price = min(prices) if prices else None
        max_price = max(prices) if prices else None

        min_days = min(days) if days else None
        max_days = max(days) if days else None

        variant_1 = _pick_fastest(offers) if offers else None
        variant_2 = _pick_cheapest(offers) if offers else None

        summary[oem] = {
            "offers": len(offers),
            "min_price": min_price,
            "max_price": max_price,
            "min_days": min_days,
            "max_days": max_days,
            "variant_1": variant_1,
            "variant_2": variant_2,
        }

    return summary


def build_offers_from_abcp(abcp: Dict[str, Any]) -> List[Offer]:
    """
    Строит КАНОНИЧЕСКИЙ список Offer из нормализованного ABCP-ответа.

    ВАЖНО:
      - id тут задаём как детерминированный глобальный счётчик,
        но окончательную нумерацию (requested first) делаем в flow.py.
      - порядок детерминированный внутри OEM: сначала дешевле, потом дороже,
        при равенстве — быстрее.
    """
    result: List[Offer] = []
    if not isinstance(abcp, dict):
        return result

    global_id = 1

    # Базовый детерминированный порядок OEM (алфавитный).
    # В flow.py мы переупорядочим requested-first и переназначим id ещё раз.
    for oem in sorted(abcp.keys()):
        data = abcp[oem]
        if not isinstance(data, dict):
            continue

        raw_offers = data.get("offers") or []
        if not isinstance(raw_offers, list):
            continue

        scored: list[tuple[float, int, Dict[str, Any]]] = []

        for off in raw_offers:
            if not isinstance(off, dict):
                continue

            price = _get_price(off)
            if price is None:
                continue

            days = _get_min_days(off)
            days_for_sort = days if days is not None else 10**9

            # Ключ сортировки: цена, затем срок
            scored.append((price, days_for_sort, off))

        if not scored:
            continue

        scored.sort(key=lambda x: (x[0], x[1]))

        for price, _days_for_sort, off in scored:
            brand = off.get("brand")
            name = off.get("name")
            if not isinstance(name, str) or not name.strip():
                if isinstance(brand, str) and brand.strip():
                    name = f"{brand} {oem}"
                else:
                    name = oem

            delivery_days = _get_min_days(off)
            supplier = off.get("supplier")
            source = str(supplier) if supplier is not None else None

            offer = Offer(
                id=global_id,
                oem=oem,
                brand=brand if isinstance(brand, str) else None,
                name=name,
                price=float(price),
                currency="RUB",
                quantity=1,
                delivery_days=delivery_days,
                source=source,
                comment=None,
            )
            result.append(offer)
            global_id += 1

    return result
