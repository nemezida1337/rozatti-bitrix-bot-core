from typing import Any, Dict, Optional

from core.models import CortexResult, ContactUpdate

from flows.lead_sales.parsers.fio import extract_full_fio_strict, split_full_name_strict
from flows.lead_sales.parsers.phone import extract_phone_from_text
from flows.lead_sales.parsers.address import extract_address_or_pickup_raw
from flows.lead_sales.session_utils import get_session_str, get_session_int, get_session_choice
from flows.lead_sales.parsers.choice import extract_offer_choice_from_text
from flows.lead_sales.parsers.quantity import extract_quantity_from_text


def apply_strict_funnel(
    result: CortexResult,
    *,
    stage_in: str,
    msg_text: str,
    session_snapshot: Dict[str, Any],
) -> CortexResult:
    """HARDENING: строгая воронка CONTACT -> ADDRESS -> FINAL.

    ВАЖНО: поведение должно оставаться прежним. Эта функция —
    вынесенная из flow.py логика без изменения семантики.
    """
    try:
        # -------------------------
        # sticky / deterministic chosen_offer_id
        # -------------------------

        # 0) Сначала пробуем детерминированно распознать выбор из текущего сообщения,
        # чтобы не путать "2 шт" с "вариант 2".
        valid_ids = [o.id for o in (result.offers or []) if hasattr(o, "id")]
        det_choice = extract_offer_choice_from_text(msg_text, valid_ids) if valid_ids else None
        if det_choice is not None:
            result.chosen_offer_id = det_choice
        else:
            # 1) sticky chosen_offer_id из сессии (если модель "потеряла" выбор)
            sess_chosen = get_session_choice(session_snapshot, "chosen_offer_id")
            if sess_chosen and not result.chosen_offer_id:
                result.chosen_offer_id = sess_chosen

        # 2) Количество: если в сообщении указали "2 шт" —
        # проставляем quantity в выбранных офферах (Node возьмёт это в product_rows).
        qty = extract_quantity_from_text(msg_text)
        if qty and result.chosen_offer_id and isinstance(result.offers, list) and len(result.offers) > 0:
            ids = result.chosen_offer_id
            ids_list = ids if isinstance(ids, list) else [ids]
            for off in result.offers:
                try:
                    if int(off.id) in [int(x) for x in ids_list]:
                        off.quantity = int(qty)
                except Exception:
                    continue
            # для логов/диагностики
            try:
                result.meta["requested_qty"] = int(qty)
            except Exception:
                pass

        # Truth sources из сессии
        sess_client_name = get_session_str(session_snapshot, "client_name")
        sess_phone = get_session_str(session_snapshot, "phone")
        sess_address = (
            get_session_str(session_snapshot, "address")
            or get_session_str(session_snapshot, "client_address")
            or get_session_str(session_snapshot, "CLIENT_ADDRESS")
            or get_session_str(session_snapshot, "DELIVERY_ADDRESS")
            or get_session_str(session_snapshot, "delivery_address")
        )

        # Truth из текущего сообщения
        fio_msg = extract_full_fio_strict(msg_text)
        phone_msg = extract_phone_from_text(msg_text)
        addr_msg = extract_address_or_pickup_raw(msg_text)

        fio_sess = split_full_name_strict(sess_client_name) if sess_client_name else None

        has_full_fio = bool(fio_msg or fio_sess)
        has_phone = bool(phone_msg or (sess_phone and sess_phone.strip()))
        has_address = bool(addr_msg or (sess_address and sess_address.strip()))

        effective_fio = fio_msg or fio_sess
        effective_phone = phone_msg or (sess_phone.strip() if isinstance(sess_phone, str) else None)
        effective_address = addr_msg or (sess_address.strip() if isinstance(sess_address, str) else None)

        # Защита от LLM-галлюцинаций: если данные не подтверждены сообщением и отсутствуют в сессии — не пишем в CRM.
        if not isinstance(result.update_lead_fields, dict):
            result.update_lead_fields = {}

        if not effective_fio:
            for k in ("NAME", "LAST_NAME", "SECOND_NAME"):
                result.update_lead_fields.pop(k, None)
        if not effective_phone:
            result.update_lead_fields.pop("PHONE", None)
        if not effective_address:
            result.update_lead_fields.pop("CLIENT_ADDRESS", None)
            result.update_lead_fields.pop("DELIVERY_ADDRESS", None)

        # Сбор contact_update как "истины"
        cu: Dict[str, Any] = {}
        if result.contact_update is not None:
            try:
                cu = result.contact_update.model_dump()
            except Exception:
                cu = {}

        if effective_fio:
            last_name, first_name, second_name, full_raw = effective_fio
            result.update_lead_fields["LAST_NAME"] = last_name
            result.update_lead_fields["NAME"] = first_name
            result.update_lead_fields["SECOND_NAME"] = second_name
            result.client_name = full_raw
            cu["full_name_raw"] = full_raw
            cu["last_name"] = last_name
            cu["name"] = first_name
            cu["second_name"] = second_name

        if effective_phone:
            result.update_lead_fields["PHONE"] = effective_phone
            cu["phone"] = effective_phone

        if effective_address:
            # Адрес доставки пишем только в лид. В контакт адрес не пишем.
            # Новый ключ для Node: DELIVERY_ADDRESS (legacy CLIENT_ADDRESS не используем).
            result.update_lead_fields["DELIVERY_ADDRESS"] = effective_address

        result.contact_update = ContactUpdate(**cu) if cu else None

        # Строгое управление стадиями: после выбора варианта
        chosen = result.chosen_offer_id
        enforce_now = (stage_in.upper() in ("CONTACT", "ADDRESS")) or (bool(chosen) and stage_in.upper() != "FINAL")

        if enforce_now:
            # 1) Нет полного ФИО или телефона -> CONTACT
            if not has_full_fio or not has_phone:
                result.stage = "CONTACT"
                result.action = "reply"
                result.product_rows = []

                if not has_full_fio and not has_phone:
                    result.reply = "Спасибо! Для оформления напишите, пожалуйста, полное ФИО (Фамилия Имя Отчество) и номер телефона."
                elif not has_full_fio:
                    result.reply = "Спасибо! Напишите, пожалуйста, полное ФИО (Фамилия Имя Отчество)."
                else:
                    result.reply = "Спасибо! Напишите, пожалуйста, номер телефона для связи."

            # 2) Есть ФИО+телефон, но нет адреса -> ADDRESS
            elif not has_address:
                result.stage = "ADDRESS"
                result.action = "reply"
                result.product_rows = []
                result.reply = "Спасибо! Укажите адрес доставки (город, улица, дом, квартира) или напишите «Самовывоз»."

            # 3) Всё есть -> FINAL
            else:
                result.stage = "FINAL"
                if not isinstance(result.reply, str) or not result.reply.strip():
                    result.reply = "Отлично, всё получил. Сейчас оформлю заказ и передам менеджеру для подтверждения."

    except Exception:
        # Не ломаем основной поток: hardening не должен падать.
        pass

    return result
