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

const accountOrderLocks = new Map();
const orderIdempotencyCache = new Map();

const DEFAULT_TS_ADDRESS = "г. Москва, ул. Тверская, д. 1";
const DEFAULT_TS_PERSON = "Тестовый получатель";
const DEFAULT_TS_CONTACT = "+79990000001";

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

function getApiStatusCode(data) {
  if (data && typeof data === "object") {
    if (Object.prototype.hasOwnProperty.call(data, "status")) {
      const n = Number(data.status);
      return Number.isFinite(n) ? n : null;
    }
    if (data.result && typeof data.result === "object") {
      const n = Number(data.result.status);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function isApiSuccess(data) {
  return getApiStatusCode(data) === 1;
}

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function sanitizeNumberFix(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9]/g, "");
}

function getAxiosErrorData(err) {
  if (!err || typeof err !== "object") return null;
  return err?.response?.data || null;
}

function isOrdersV1DisabledPayload(data) {
  if (!data || typeof data !== "object") return false;
  const errorCode = Number(data?.errorCode ?? data?.result?.errorCode ?? NaN);
  const errorMessage = String(data?.errorMessage ?? data?.result?.errorMessage ?? "");
  return errorCode === 403 && /orders\s*v1\s*disabled/i.test(errorMessage);
}

function isOrdersV1DisabledError(err) {
  return isOrdersV1DisabledPayload(getAxiosErrorData(err));
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

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeOem(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function extractDeliveryDays(offer) {
  return toPositiveInt(
    offer?.delivery_days ?? offer?.minDays ?? offer?.deliveryDays ?? offer?.maxDays,
  );
}

function hasOrderablePayload(offer) {
  const code = String(offer?.code || "").trim();
  if (code) return true;

  const brand = String(offer?.brand || "").trim();
  const number = String(offer?.oem || offer?.number || "").trim();
  const supplierCode = String(offer?.supplierCode || "").trim();
  const itemKey = String(offer?.itemKey || "").trim();
  return Boolean(brand && number && supplierCode && itemKey);
}

function collectAbcpSessionOffers(session) {
  const payload = session?.abcp;
  if (!payload || typeof payload !== "object") return [];

  const out = [];
  for (const [oem, packet] of Object.entries(payload)) {
    const offers = Array.isArray(packet?.offers) ? packet.offers : [];
    for (const offer of offers) {
      if (!offer || typeof offer !== "object") continue;
      out.push({
        ...offer,
        oem: String(offer?.oem || oem || "").trim(),
      });
    }
  }
  return out;
}

function scoreAbcpCandidateMatch({ offer, candidate }) {
  if (!candidate || typeof candidate !== "object") return Number.POSITIVE_INFINITY;
  if (!hasOrderablePayload(candidate)) return Number.POSITIVE_INFINITY;

  const offerOem = normalizeOem(offer?.oem || offer?.number);
  const candOem = normalizeOem(candidate?.oem || candidate?.number);
  if (offerOem && candOem && offerOem !== candOem) return Number.POSITIVE_INFINITY;

  const offerPrice = toFiniteNumber(offer?.price);
  const candPrice = toFiniteNumber(candidate?.price);
  const offerDays = extractDeliveryDays(offer);
  const candDays = extractDeliveryDays(candidate);

  let score = 0;
  if (offerOem && !candOem) score += 50;

  const offerBrand = normalizeText(offer?.brand).toUpperCase();
  const candBrand = normalizeText(candidate?.brand).toUpperCase();
  if (offerBrand && candBrand && offerBrand !== candBrand) score += 10;

  if (offerPrice !== null && candPrice !== null) {
    score += Math.abs(offerPrice - candPrice);
  } else if (offerPrice !== null || candPrice !== null) {
    score += 3;
  }

  if (offerDays !== null && candDays !== null) {
    score += Math.abs(offerDays - candDays) * 0.25;
  } else if (offerDays !== null || candDays !== null) {
    score += 1;
  }

  return score;
}

function enrichOfferFromSessionAbcp(offer, session) {
  if (!offer || typeof offer !== "object") return offer;
  if (hasOrderablePayload(offer)) return offer;

  const candidates = collectAbcpSessionOffers(session);
  if (!candidates.length) return offer;

  let bestCandidate = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const score = scoreAbcpCandidateMatch({ offer, candidate });
    if (score < bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate || !Number.isFinite(bestScore)) {
    return offer;
  }

  const quantity =
    toPositiveInt(offer?.orderQuantity || offer?.quantity) ||
    toPositiveInt(bestCandidate?.orderQuantity || bestCandidate?.quantity) ||
    1;

  return {
    ...offer,
    brand: normalizeText(offer?.brand) || normalizeText(bestCandidate?.brand),
    oem:
      normalizeText(offer?.oem || offer?.number) ||
      normalizeText(bestCandidate?.oem || bestCandidate?.number),
    supplierCode:
      offer?.supplierCode ??
      bestCandidate?.supplierCode ??
      bestCandidate?.distributorRouteId ??
      bestCandidate?.routeId ??
      null,
    itemKey: offer?.itemKey ?? bestCandidate?.itemKey ?? null,
    code: offer?.code ?? bestCandidate?.code ?? null,
    numberFix: offer?.numberFix ?? bestCandidate?.numberFix ?? null,
    description: offer?.description ?? bestCandidate?.description ?? null,
    orderQuantity: quantity,
  };
}

function pickOffersForOrder({ session, llm }) {
  const llmOffers = Array.isArray(llm?.offers) ? llm.offers : [];
  const sessionOffers = Array.isArray(session?.state?.offers) ? session.state.offers : [];
  const chosenIds = parseChosenIds(llm?.chosen_offer_id ?? session?.state?.chosen_offer_id);
  if (!chosenIds.length) return [];

  const offers = llmOffers.length > 0 ? llmOffers : sessionOffers;
  let selected = offers.filter((o) => chosenIds.includes(Number(o?.id)));

  if (!selected.length && sessionOffers.length > 0 && offers !== sessionOffers) {
    selected = sessionOffers.filter((o) => chosenIds.includes(Number(o?.id)));
  }

  if (!selected.length) return [];
  return selected.map((offer) => enrichOfferFromSessionAbcp(offer, session));
}

function getOrderIdempotencyTtlMs() {
  const raw = Number(process.env.ABCP_ORDER_IDEMPOTENCY_TTL_MS || 10 * 60 * 1000);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
}

function makeSelectedOffersSignature(selectedOffers = []) {
  const parts = selectedOffers
    .map((o) => {
      const id = String(o?.id ?? "");
      const code = String(o?.code ?? "");
      const itemKey = String(o?.itemKey ?? "");
      const supplierCode = String(o?.supplierCode ?? "");
      const oem = String(o?.oem ?? o?.number ?? "");
      return [id, code, itemKey, supplierCode, oem].join(":");
    })
    .filter(Boolean)
    .sort();
  return parts.join("|");
}

function makeOrderIdempotencyKey({ dialogId, selectedOffers }) {
  const dialogPart = String(dialogId || "no-dialog");
  const offersPart = makeSelectedOffersSignature(selectedOffers);
  return `${dialogPart}::${offersPart}`;
}

function getRecentOrderByKey(key) {
  const ttl = getOrderIdempotencyTtlMs();
  const now = Date.now();

  for (const [k, v] of orderIdempotencyCache.entries()) {
    if (!v || now - Number(v.at || 0) > ttl) {
      orderIdempotencyCache.delete(k);
    }
  }

  const hit = orderIdempotencyCache.get(key);
  if (!hit) return null;
  if (now - Number(hit.at || 0) > ttl) {
    orderIdempotencyCache.delete(key);
    return null;
  }
  return hit;
}

function rememberRecentOrder(key, orderNumbers = []) {
  orderIdempotencyCache.set(key, {
    at: Date.now(),
    orderNumbers: Array.isArray(orderNumbers) ? orderNumbers : [],
  });
}

function getAccountOrderLockKey() {
  return `${ABCP_DOMAIN || "no-domain"}|${ABCP_LOGIN || "no-login"}`;
}

async function withAccountOrderLock(task) {
  const key = getAccountOrderLockKey();
  const previous = accountOrderLocks.get(key) || Promise.resolve();

  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });

  accountOrderLocks.set(key, previous.then(() => current));
  await previous;

  try {
    return await task();
  } finally {
    release();
  }
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

  const directRootNumber = root?.number || root?.orderNumber || root?.id || null;
  if (directRootNumber) numbers.push(String(directRootNumber));

  return Array.from(new Set(numbers));
}

function listFromTsResponse(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray(data.list)) return data.list;
  return [];
}

function listFromCpUsersResponse(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.list)) return data.list;
    if (data.result && typeof data.result === "object") {
      if (Array.isArray(data.result.items)) return data.result.items;
      if (Array.isArray(data.result.list)) return data.result.list;
    }
  }
  return [];
}

function toClientIdFromUser(user) {
  return (
    toPositiveInt(user?.clientId) ||
    toPositiveInt(user?.customerId) ||
    toPositiveInt(user?.userId) ||
    toPositiveInt(user?.id)
  );
}

function normalizePhoneForAbcp(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) {
    return `7${digits.slice(1)}`;
  }

  if (digits.length === 10) {
    return `7${digits}`;
  }

  return digits;
}

function buildPhoneSearchCandidates(value) {
  const raw = String(value || "").trim();
  const normalized = normalizePhoneForAbcp(value);

  return Array.from(
    new Set(
      [raw, normalized, normalized ? `+${normalized}` : null]
        .map((x) => String(x || "").trim())
        .filter(Boolean),
    ),
  );
}

function splitClientNameForAbcp(value) {
  const full = normalizeText(value);
  if (!full) return { name: "Клиент", secondName: "", surname: "Bitrix" };

  const parts = full
    .split(/\s+/)
    .map((x) => normalizeText(x))
    .filter(Boolean);

  if (parts.length === 1) return { name: parts[0], secondName: "", surname: "Bitrix" };
  if (parts.length === 2) return { name: parts[0], secondName: "", surname: parts[1] };

  return {
    surname: parts[0],
    name: parts[1],
    secondName: parts.slice(2).join(" "),
  };
}

function getSessionClientName(session) {
  const fromState = normalizeText(session?.state?.client_name);
  if (fromState) return fromState;

  const fromName = normalizeText(session?.name);
  if (fromName) return fromName;

  const fromContact = normalizeText(
    [
      session?.state?.contact_last_name,
      session?.state?.contact_name,
      session?.state?.contact_second_name,
    ]
      .map((x) => normalizeText(x))
      .filter(Boolean)
      .join(" "),
  );
  if (fromContact) return fromContact;

  return "";
}

function getSessionPhone(session) {
  const phone = normalizeText(
    session?.phone || session?.state?.phone || session?.state?.client_phone || "",
  );
  return phone || "";
}

function pickBestCpUserCandidate(users = []) {
  if (!Array.isArray(users) || users.length === 0) return null;

  const valid = users
    .map((user) => ({ user, clientId: toClientIdFromUser(user) }))
    .filter((item) => item.clientId);

  if (!valid.length) return null;

  valid.sort((a, b) => b.clientId - a.clientId);
  return valid[0].user;
}

async function findCpUserByPhone(phone) {
  const candidates = buildPhoneSearchCandidates(phone);
  if (!candidates.length) return null;

  for (const phoneCandidate of candidates) {
    try {
      const response = await api.get("/cp/users", {
        params: {
          ...authPayload(),
          phone: phoneCandidate,
          limit: 25,
          skip: 0,
        },
      });

      const list = listFromCpUsersResponse(response?.data);
      const best = pickBestCpUserCandidate(list);
      const clientId = toClientIdFromUser(best);
      if (clientId) {
        return {
          clientId,
          source: "CP_USERS",
          rawUser: best,
          phone: phoneCandidate,
        };
      }
    } catch (e) {
      logger.warn(
        { ctx: CTX, error: String(e), phone: phoneCandidate },
        "Поиск клиента через /cp/users не удался",
      );
      return null;
    }
  }

  return null;
}

function createTempPassword() {
  return `bot${Date.now().toString(36).slice(-6)}A1`;
}

async function createCpUser({ session, phone }) {
  const mobile = normalizePhoneForAbcp(phone);
  if (!mobile) return { ok: false, reason: "NO_PHONE_FOR_CREATE" };

  const nameParts = splitClientNameForAbcp(getSessionClientName(session));
  const marketType = toPositiveInt(process.env.ABCP_TS_NEW_CLIENT_MARKET_TYPE) || 1;
  const password = normalizeText(process.env.ABCP_TS_NEW_CLIENT_PASSWORD) || createTempPassword();
  const city = normalizeText(process.env.ABCP_TS_NEW_CLIENT_CITY) || "Москва";
  const deliveryAddress =
    normalizeText(session?.state?.delivery_address) ||
    normalizeText(process.env.ABCP_TS_DEFAULT_ADDRESS) ||
    DEFAULT_TS_ADDRESS;

  const payload = {
    ...authPayload(),
    marketType,
    name: nameParts.name || "Клиент",
    surname: nameParts.surname || "Bitrix",
    secondName: nameParts.secondName || "",
    mobile,
    password,
    city,
    deliveryAddress,
    comment: "Создано автоматически из Bitrix бота",
  };

  const filialId = toPositiveInt(process.env.ABCP_TS_NEW_CLIENT_FILIAL_ID);
  if (filialId) payload.filialId = filialId;

  const profileId = toPositiveInt(process.env.ABCP_TS_NEW_CLIENT_PROFILE_ID);
  if (profileId) payload.profileId = profileId;

  const email = normalizeText(process.env.ABCP_TS_NEW_CLIENT_EMAIL);
  if (email) payload.email = email;

  try {
    const created = await postForm("/cp/user/new", payload);
    const status = toPositiveInt(created?.data?.status);
    if (status === 1 || created?.data?.status === true) {
      return { ok: true, raw: created?.data || null };
    }
    return {
      ok: false,
      reason: "CP_USER_CREATE_REJECTED",
      raw: created?.data || null,
    };
  } catch (e) {
    return {
      ok: false,
      reason: "CP_USER_CREATE_FAILED",
      raw: getAxiosErrorData(e),
    };
  }
}

async function resolveAgreementIdForClient(clientId) {
  const fromEnvAgreementId = toPositiveInt(process.env.ABCP_TS_AGREEMENT_ID);
  if (fromEnvAgreementId) return fromEnvAgreementId;

  if (!clientId) return null;

  try {
    const r = await api.get("/ts/agreements/list", {
      params: {
        ...authPayload(),
        clientIds: String(clientId),
        limit: 1,
        skip: 0,
      },
    });
    const list = listFromTsResponse(r?.data);
    const first = list.find((x) => toPositiveInt(x?.id || x?.agreementId));
    return toPositiveInt(first?.id || first?.agreementId);
  } catch (e) {
    logger.warn(
      { ctx: CTX, error: String(e), clientId },
      "Не удалось определить agreementId из /ts/agreements/list",
    );
    return null;
  }
}

async function resolveShipmentMethodIdV1() {
  const fromEnv = toPositiveInt(process.env.ABCP_SHIPMENT_METHOD_ID);
  if (fromEnv) return { ok: true, id: fromEnv, reason: "FROM_ENV" };

  try {
    const r = await api.get("/basket/shipmentMethods", { params: authPayload() });
    const arr = Array.isArray(r?.data) ? r.data : [];
    const first = arr.find((x) => toPositiveInt(x?.id));
    return { ok: true, id: first ? toPositiveInt(first.id) : null, reason: "AUTO" };
  } catch (e) {
    if (isOrdersV1DisabledError(e)) {
      return {
        ok: false,
        reason: "ORDERS_V1_DISABLED",
        raw: getAxiosErrorData(e),
      };
    }
    logger.warn(
      { ctx: CTX, error: String(e) },
      "Не удалось получить shipmentMethod, попробуем без него",
    );
    return { ok: true, id: null, reason: "AUTO_FAILED" };
  }
}

async function resolveShipmentAddressIdV1() {
  const fromEnv = toPositiveInt(process.env.ABCP_SHIPMENT_ADDRESS_ID);
  if (fromEnv) return { ok: true, id: fromEnv, reason: "FROM_ENV" };

  try {
    const r = await api.get("/basket/shipmentAddresses", { params: authPayload() });
    const arr = Array.isArray(r?.data) ? r.data : [];
    const first = arr.find((x) => toPositiveInt(x?.id));
    if (first) return { ok: true, id: toPositiveInt(first.id), reason: "AUTO" };
  } catch (e) {
    if (isOrdersV1DisabledError(e)) {
      return {
        ok: false,
        reason: "ORDERS_V1_DISABLED",
        raw: getAxiosErrorData(e),
      };
    }
    logger.warn(
      { ctx: CTX, error: String(e) },
      "Не удалось получить shipmentAddress, используем 0",
    );
  }

  // Самовывоз / нет адресов
  return { ok: true, id: 0, reason: "AUTO_DEFAULT_ZERO" };
}

async function tryCreateOrderViaBasketV1({ positions }) {
  const shouldClearBasket = process.env.ABCP_ORDER_CLEAR_BASKET === "1";

  if (shouldClearBasket) {
    try {
      const clearResp = await postForm("/basket/clear", authPayload());
      if (!isApiSuccess(clearResp?.data)) {
        if (isOrdersV1DisabledPayload(clearResp?.data)) {
          return {
            ok: false,
            reason: "ORDERS_V1_DISABLED",
            orderNumbers: [],
            raw: clearResp?.data || null,
          };
        }
        return {
          ok: false,
          reason: "BASKET_CLEAR_FAILED",
          orderNumbers: [],
          raw: clearResp?.data || null,
        };
      }
    } catch (e) {
      if (isOrdersV1DisabledError(e)) {
        return {
          ok: false,
          reason: "ORDERS_V1_DISABLED",
          orderNumbers: [],
          raw: getAxiosErrorData(e),
        };
      }
      return { ok: false, reason: "ABCP_ORDER_ERROR", orderNumbers: [] };
    }
  }

  let addResp;
  try {
    addResp = await postForm("/basket/add", {
      ...authPayload(),
      positions,
    });
  } catch (e) {
    if (isOrdersV1DisabledError(e)) {
      return {
        ok: false,
        reason: "ORDERS_V1_DISABLED",
        orderNumbers: [],
        raw: getAxiosErrorData(e),
      };
    }
    return { ok: false, reason: "ABCP_ORDER_ERROR", orderNumbers: [] };
  }

  if (!isApiSuccess(addResp?.data)) {
    if (isOrdersV1DisabledPayload(addResp?.data)) {
      return {
        ok: false,
        reason: "ORDERS_V1_DISABLED",
        orderNumbers: [],
        raw: addResp?.data || null,
      };
    }
    return {
      ok: false,
      reason: "BASKET_ADD_FAILED",
      orderNumbers: [],
      raw: addResp?.data || null,
    };
  }

  const shipmentMethod = await resolveShipmentMethodIdV1();
  if (!shipmentMethod?.ok && shipmentMethod?.reason === "ORDERS_V1_DISABLED") {
    return {
      ok: false,
      reason: "ORDERS_V1_DISABLED",
      orderNumbers: [],
      raw: shipmentMethod?.raw || null,
    };
  }

  const shipmentAddress = await resolveShipmentAddressIdV1();
  if (!shipmentAddress?.ok && shipmentAddress?.reason === "ORDERS_V1_DISABLED") {
    return {
      ok: false,
      reason: "ORDERS_V1_DISABLED",
      orderNumbers: [],
      raw: shipmentAddress?.raw || null,
    };
  }

  const paymentMethod = toPositiveInt(process.env.ABCP_PAYMENT_METHOD_ID);
  const shipmentOffice = toPositiveInt(process.env.ABCP_SHIPMENT_OFFICE_ID);

  const orderPayload = {
    ...authPayload(),
    shipmentAddress: shipmentAddress?.id ?? 0,
  };

  if (shipmentMethod?.id != null) orderPayload.shipmentMethod = shipmentMethod.id;
  if (paymentMethod) orderPayload.paymentMethod = paymentMethod;
  if (shipmentOffice) orderPayload.shipmentOffice = shipmentOffice;

  let orderResp;
  try {
    orderResp = await postForm("/basket/order", orderPayload);
  } catch (e) {
    if (isOrdersV1DisabledError(e)) {
      return {
        ok: false,
        reason: "ORDERS_V1_DISABLED",
        orderNumbers: [],
        raw: getAxiosErrorData(e),
      };
    }
    return { ok: false, reason: "ABCP_ORDER_ERROR", orderNumbers: [] };
  }

  if (!isApiSuccess(orderResp?.data)) {
    if (isOrdersV1DisabledPayload(orderResp?.data)) {
      return {
        ok: false,
        reason: "ORDERS_V1_DISABLED",
        orderNumbers: [],
        raw: orderResp?.data || null,
      };
    }
    return {
      ok: false,
      reason: "ORDER_REJECTED_BY_API",
      orderNumbers: [],
      raw: orderResp?.data || null,
    };
  }

  const orderNumbers = extractOrderNumbers(orderResp?.data);
  return {
    ok: orderNumbers.length > 0,
    reason: orderNumbers.length > 0 ? "OK" : "ORDER_ACCEPTED_WITHOUT_NUMBER",
    orderNumbers,
    raw: orderResp?.data || null,
  };
}

async function resolveTsClientContext({ session } = {}) {
  const fromEnvClientId = toPositiveInt(process.env.ABCP_TS_CLIENT_ID);
  if (fromEnvClientId) {
    const agreementId = await resolveAgreementIdForClient(fromEnvClientId);
    return {
      clientId: fromEnvClientId,
      agreementId,
      source: "ENV",
    };
  }

  const sessionPhone = getSessionPhone(session);
  const existing = await findCpUserByPhone(sessionPhone);
  if (existing?.clientId) {
    const agreementId = await resolveAgreementIdForClient(existing.clientId);
    return {
      clientId: existing.clientId,
      agreementId,
      source: existing.source || "CP_USERS",
    };
  }

  if (!normalizePhoneForAbcp(sessionPhone)) {
    logger.warn({ ctx: CTX }, "Нет телефона клиента: не можем найти/создать клиента в ABCP");
    return null;
  }

  const created = await createCpUser({ session, phone: sessionPhone });
  if (!created?.ok) {
    logger.warn(
      { ctx: CTX, reason: created?.reason || null, raw: created?.raw || null },
      "Не удалось создать клиента через /cp/user/new",
    );
    return null;
  }

  const createdLookup = await findCpUserByPhone(sessionPhone);
  if (!createdLookup?.clientId) {
    logger.warn(
      { ctx: CTX, phone: sessionPhone },
      "Клиент создан, но не найден повторным поиском /cp/users",
    );
    return null;
  }

  const agreementId = await resolveAgreementIdForClient(createdLookup.clientId);
  return {
    clientId: createdLookup.clientId,
    agreementId,
    source: "CP_USER_NEW",
  };
}

function mapOfferToTsCartPayload(offer, { clientId, agreementId }) {
  const brand = normalizeText(offer?.brand);
  const number = normalizeText(offer?.oem || offer?.number || "");
  const numberFix = sanitizeNumberFix(offer?.numberFix || number);
  const distributorRouteId = toPositiveInt(
    offer?.distributorRouteId || offer?.supplierCode || offer?.routeId,
  );
  const itemKey = normalizeText(offer?.itemKey);
  const quantity = toPositiveInt(offer?.orderQuantity || offer?.quantity || 1) || 1;

  const rawDescription = normalizeText(offer?.description);
  const description =
    rawDescription.length >= 2 ? rawDescription : `Запчасть ${numberFix || number || "товар"}`;

  if (!clientId || !brand || !number || !numberFix || !distributorRouteId || !itemKey) {
    return null;
  }

  const payload = {
    ...authPayload(),
    clientId,
    brand,
    number,
    numberFix,
    description,
    quantity,
    distributorRouteId,
    itemKey,
  };

  if (agreementId) payload.agreementId = agreementId;
  return payload;
}

function pickTsDeliveryMethod(methods = []) {
  if (!Array.isArray(methods) || methods.length === 0) return null;
  const preferredMethodId = toPositiveInt(process.env.ABCP_TS_DELIVERY_METHOD_ID);
  if (preferredMethodId) {
    const preferred = methods.find((m) => toPositiveInt(m?.id) === preferredMethodId);
    if (preferred) return preferred;
  }
  return methods[0];
}

function buildTsMeetData({ method, session }) {
  const defaultAddress = normalizeText(
    session?.state?.delivery_address || process.env.ABCP_TS_DEFAULT_ADDRESS || DEFAULT_TS_ADDRESS,
  );
  const defaultPerson = normalizeText(
    session?.state?.client_name || process.env.ABCP_TS_DEFAULT_PERSON || DEFAULT_TS_PERSON,
  );
  const defaultContact = normalizeText(
    session?.phone || process.env.ABCP_TS_DEFAULT_CONTACT || DEFAULT_TS_CONTACT,
  );
  const defaultComment = normalizeText(process.env.ABCP_TS_DELIVERY_COMMENT);

  const meetData = {
    comment: defaultComment || "Заказ через Bitrix bot",
  };

  const methodType = normalizeText(method?.type).toLowerCase();

  if (methodType === "pickup") {
    const envOfficeId = toPositiveInt(process.env.ABCP_TS_PICKUP_OFFICE_ID);
    const officeId = envOfficeId || toPositiveInt(method?.offices?.[0]?.id);
    const pickupAddress = normalizeText(
      method?.addresses?.[0]?.address || method?.offices?.[0]?.address || defaultAddress,
    );

    if (officeId) meetData.officeId = officeId;
    if (pickupAddress) meetData.address = pickupAddress;
    if (defaultPerson) meetData.person = defaultPerson;
    if (defaultContact) meetData.contact = defaultContact;

    return meetData;
  }

  const shipmentAddressId = toPositiveInt(process.env.ABCP_TS_SHIPMENT_ADDRESS_ID);
  if (shipmentAddressId) {
    meetData.shipmentAddressId = shipmentAddressId;
  } else if (defaultAddress) {
    meetData.address = defaultAddress;
  }

  meetData.person = defaultPerson || DEFAULT_TS_PERSON;
  meetData.contact = defaultContact || DEFAULT_TS_CONTACT;

  return meetData;
}

async function tryCreateOrderViaTsApi({ selectedOffers, session, dialogId }) {
  const context = await resolveTsClientContext({ session });
  if (!context?.clientId) {
    return { ok: false, reason: "TS_CLIENT_CONTEXT_NOT_FOUND", orderNumbers: [] };
  }

  const shouldClearBasket = process.env.ABCP_ORDER_CLEAR_BASKET === "1";
  if (shouldClearBasket) {
    try {
      await postForm("/ts/cart/clear", {
        ...authPayload(),
        clientId: context.clientId,
      });
    } catch (e) {
      logger.warn(
        { ctx: CTX, error: String(e), clientId: context.clientId },
        "Не удалось очистить TS-корзину перед заказом, продолжаем",
      );
    }
  }

  const positionIds = [];
  for (const offer of selectedOffers) {
    const payload = mapOfferToTsCartPayload(offer, context);
    if (!payload) {
      return { ok: false, reason: "NO_ORDERABLE_POSITIONS", orderNumbers: [] };
    }

    try {
      const created = await postForm("/ts/cart/create", payload);
      const posId = toPositiveInt(created?.data?.id || created?.data?.positionId);
      if (!posId) {
        return {
          ok: false,
          reason: "TS_CART_CREATE_INVALID_RESPONSE",
          orderNumbers: [],
          raw: created?.data || null,
        };
      }
      positionIds.push(posId);
    } catch (e) {
      return {
        ok: false,
        reason: "TS_CART_CREATE_FAILED",
        orderNumbers: [],
        raw: getAxiosErrorData(e),
      };
    }
  }

  const uniquePositionIds = Array.from(new Set(positionIds));
  if (!uniquePositionIds.length) {
    return { ok: false, reason: "NO_ORDERABLE_POSITIONS", orderNumbers: [] };
  }

  let deliveryMethods = [];
  try {
    const deliveryResp = await api.get("/ts/deliveryMethod/forCo", {
      params: {
        ...authPayload(),
        clientId: context.clientId,
        cartPositionIds: uniquePositionIds.join(","),
      },
    });
    deliveryMethods = listFromTsResponse(deliveryResp?.data);
  } catch (e) {
    return {
      ok: false,
      reason: "TS_DELIVERY_METHODS_FAILED",
      orderNumbers: [],
      raw: getAxiosErrorData(e),
    };
  }

  const method = pickTsDeliveryMethod(deliveryMethods);
  const methodId = toPositiveInt(method?.id);
  if (!methodId) {
    return {
      ok: false,
      reason: "TS_NO_DELIVERY_METHODS",
      orderNumbers: [],
      raw: deliveryMethods,
    };
  }

  const orderPayload = {
    ...authPayload(),
    clientId: context.clientId,
    positions: uniquePositionIds,
    delivery: {
      methodId,
      meetData: buildTsMeetData({ method, session }),
    },
    externalId: `bitrix-${String(dialogId || "no-dialog")}-${Date.now()}`,
  };

  if (context?.agreementId) orderPayload.agreementId = context.agreementId;

  let createdOrder;
  try {
    createdOrder = await postForm("/ts/orders/createByCart", orderPayload);
  } catch (e) {
    return {
      ok: false,
      reason: "TS_ORDER_CREATE_FAILED",
      orderNumbers: [],
      raw: getAxiosErrorData(e),
    };
  }

  const orderNumbers = extractOrderNumbers(createdOrder?.data);
  return {
    ok: orderNumbers.length > 0,
    reason: orderNumbers.length > 0 ? "OK" : "ORDER_ACCEPTED_WITHOUT_NUMBER",
    orderNumbers,
    raw: createdOrder?.data || null,
  };
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

  return withAccountOrderLock(async () => {
    const idemKey = makeOrderIdempotencyKey({ dialogId, selectedOffers });
    const recentOrder = getRecentOrderByKey(idemKey);
    if (recentOrder) {
      return {
        ok: Array.isArray(recentOrder.orderNumbers) && recentOrder.orderNumbers.length > 0,
        reason: "ORDER_ALREADY_SUBMITTED_RECENTLY",
        orderNumbers: Array.isArray(recentOrder.orderNumbers) ? recentOrder.orderNumbers : [],
      };
    }

    try {
      let result = await tryCreateOrderViaBasketV1({ positions });

      if (result?.reason === "ORDERS_V1_DISABLED") {
        logger.info(
          { ctx: CTX, dialogId: dialogId || null },
          "ABCP Orders v1 отключен, переключаемся на TS API",
        );
        result = await tryCreateOrderViaTsApi({ selectedOffers, session, dialogId });
      }

      if (!result) {
        return { ok: false, reason: "ABCP_ORDER_ERROR", orderNumbers: [] };
      }

      if (result.ok || result.reason === "ORDER_ACCEPTED_WITHOUT_NUMBER") {
        rememberRecentOrder(idemKey, result.orderNumbers || []);
      }

      if (result.ok && Array.isArray(result.orderNumbers) && result.orderNumbers.length > 0) {
        logger.info(
          {
            ctx: CTX,
            dialogId: dialogId || null,
            selectedOffers: selectedOffers.length,
            createdOrders: result.orderNumbers,
          },
          "Заказ ABCP создан",
        );
      }

      return result;
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
  });
}

export default { createAbcpOrderFromSession };
