import axios from "axios";

import { logger } from "../../../core/logger.js";

const CTX = "ABCP_ORDER";

const ABCP_DOMAIN = process.env.ABCP_DOMAIN || process.env.ABCP_HOST;
const ABCP_LOGIN = process.env.ABCP_KEY || process.env.ABCP_USERLOGIN;
const ABCP_USERPSW_MD5 =
  process.env.ABCP_USERPSW_MD5 || process.env.ABCP_USERPSW;

const api = axios.create({
  baseURL: `https://${ABCP_DOMAIN}`,
  timeout: 8000,
});

function authPayload() {
  return {
    userlogin: ABCP_LOGIN,
    userpsw: ABCP_USERPSW_MD5,
  };
}

function canUseAbcpOrderApi() {
  return Boolean(ABCP_DOMAIN && ABCP_LOGIN && ABCP_USERPSW_MD5);
}

function flattenToFormData(value, prefix, out) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => flattenToFormData(item, `${prefix}[${i}]`, out));
    return;
  }

  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      flattenToFormData(v, prefix ? `${prefix}[${k}]` : k, out);
    }
    return;
  }

  if (value === null || value === undefined) return;
  out.append(prefix, String(value));
}

function toFormData(data) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(data || {})) {
    flattenToFormData(v, k, form);
  }
  return form;
}

async function postForm(url, data) {
  const body = toFormData(data);
  return api.post(url, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

function parseChosenIds(chosen_offer_id) {
  const list = Array.isArray(chosen_offer_id)
    ? chosen_offer_id
    : chosen_offer_id != null
      ? [chosen_offer_id]
      : [];

  return list
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x))
    .map((x) => Number(x));
}

function pickOffersForOrder({ session, llm }) {
  const llmOffers = Array.isArray(llm?.offers) ? llm.offers : [];
  const sessionOffers = Array.isArray(session?.state?.offers) ? session.state.offers : [];
  const offers = llmOffers.length > 0 ? llmOffers : sessionOffers;
  if (!offers.length) return [];

  const chosenIds = parseChosenIds(llm?.chosen_offer_id ?? session?.state?.chosen_offer_id);
  if (!chosenIds.length) return [];

  const selected = offers.filter((o) => chosenIds.includes(Number(o?.id)));
  return selected;
}

function mapOfferToPosition(offer) {
  const brand = String(offer?.brand || "").trim();
  const number = String(offer?.oem || offer?.number || "").trim();
  const supplierCode = String(offer?.supplierCode || "").trim();
  const itemKey = String(offer?.itemKey || "").trim();
  const code = String(offer?.code || "").trim();

  const quantityRaw = Number(offer?.orderQuantity || 1);
  const quantity = Number.isFinite(quantityRaw) && quantityRaw > 0 ? quantityRaw : 1;

  if (code) {
    return { code, quantity };
  }

  if (!brand || !number || !supplierCode || !itemKey) {
    return null;
  }

  return { brand, number, supplierCode, itemKey, quantity };
}

function extractOrderNumbers(orderResponseData) {
  const root = orderResponseData || {};
  const list = Array.isArray(root?.orders)
    ? root.orders
    : Array.isArray(root?.result?.orders)
      ? root.result.orders
      : [];

  const numbers = list
    .map((x) => x?.number || x?.orderNumber || x?.id || null)
    .filter(Boolean)
    .map((x) => String(x));

  return Array.from(new Set(numbers));
}

async function resolveShipmentMethodId() {
  const fromEnv = process.env.ABCP_SHIPMENT_METHOD_ID;
  if (fromEnv && Number.isFinite(Number(fromEnv))) return Number(fromEnv);

  try {
    const r = await api.get("/basket/shipmentMethods", { params: authPayload() });
    const arr = Array.isArray(r?.data) ? r.data : [];
    const first = arr.find((x) => Number.isFinite(Number(x?.id)));
    return first ? Number(first.id) : null;
  } catch (e) {
    logger.warn(
      { ctx: CTX, error: String(e) },
      "Не удалось получить shipmentMethod, попробуем без него",
    );
    return null;
  }
}

async function resolveShipmentAddressId() {
  const fromEnv = process.env.ABCP_SHIPMENT_ADDRESS_ID;
  if (fromEnv && Number.isFinite(Number(fromEnv))) return Number(fromEnv);

  try {
    const r = await api.get("/basket/shipmentAddresses", { params: authPayload() });
    const arr = Array.isArray(r?.data) ? r.data : [];
    const first = arr.find((x) => Number.isFinite(Number(x?.id)));
    if (first) return Number(first.id);
  } catch (e) {
    logger.warn(
      { ctx: CTX, error: String(e) },
      "Не удалось получить shipmentAddress, используем 0",
    );
  }

  // Самовывоз / нет адресов
  return 0;
}

export async function createAbcpOrderFromSession({ session, llm, dialogId } = {}) {
  if (!canUseAbcpOrderApi()) {
    return { ok: false, reason: "ABCP_NOT_CONFIGURED", orderNumbers: [] };
  }

  const selectedOffers = pickOffersForOrder({ session, llm });
  if (!selectedOffers.length) {
    return { ok: false, reason: "NO_SELECTED_OFFERS", orderNumbers: [] };
  }

  const positions = selectedOffers.map(mapOfferToPosition).filter(Boolean);
  if (!positions.length) {
    return { ok: false, reason: "NO_ORDERABLE_POSITIONS", orderNumbers: [] };
  }

  const shouldClearBasket = process.env.ABCP_ORDER_CLEAR_BASKET !== "0";

  try {
    if (shouldClearBasket) {
      await postForm("/basket/clear", authPayload());
    }

    await postForm("/basket/add", {
      ...authPayload(),
      positions,
    });

    const shipmentMethod = await resolveShipmentMethodId();
    const shipmentAddress = await resolveShipmentAddressId();
    const paymentMethod = Number(process.env.ABCP_PAYMENT_METHOD_ID || 0);
    const shipmentOffice = Number(process.env.ABCP_SHIPMENT_OFFICE_ID || 0);

    const orderPayload = {
      ...authPayload(),
      shipmentAddress,
    };

    if (shipmentMethod != null) orderPayload.shipmentMethod = shipmentMethod;
    if (Number.isFinite(paymentMethod) && paymentMethod > 0) {
      orderPayload.paymentMethod = paymentMethod;
    }
    if (Number.isFinite(shipmentOffice) && shipmentOffice > 0) {
      orderPayload.shipmentOffice = shipmentOffice;
    }

    const orderResp = await postForm("/basket/order", orderPayload);
    const orderNumbers = extractOrderNumbers(orderResp?.data);

    logger.info(
      {
        ctx: CTX,
        dialogId: dialogId || null,
        selectedOffers: selectedOffers.length,
        createdOrders: orderNumbers,
      },
      "Заказ ABCP создан",
    );

    return {
      ok: orderNumbers.length > 0,
      reason: orderNumbers.length > 0 ? "OK" : "ORDER_RESPONSE_WITHOUT_NUMBERS",
      orderNumbers,
      raw: orderResp?.data || null,
    };
  } catch (e) {
    logger.error(
      {
        ctx: CTX,
        dialogId: dialogId || null,
        error: String(e),
      },
      "Ошибка создания заказа в ABCP",
    );
    return { ok: false, reason: "ABCP_ORDER_ERROR", orderNumbers: [] };
  }
}

export default { createAbcpOrderFromSession };
