import { crmSettings } from "../../../config/settings.crm.js";
import { makeBitrixClient } from "../../../core/bitrixClient.js";
import { logger } from "../../../core/logger.js";
import { getPortalAsync } from "../../../core/store.js";

const CTX = "modules/crm/leads/convertLeadToDealService";

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function normalizeOrderNumbers(orderNumbers) {
  if (!Array.isArray(orderNumbers)) return [];
  return Array.from(new Set(orderNumbers.map((x) => String(x || "").trim()).filter(Boolean)));
}

function getPrimaryOrderNumber(orderNumbers) {
  const normalized = normalizeOrderNumbers(orderNumbers);
  return normalized.length > 0 ? normalized[0] : null;
}

function toFiniteNumberOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function listFromBitrixListResult(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.result)) return payload.result;
    if (Array.isArray(payload.items)) return payload.items;
  }
  return [];
}

function extractDealId(payload) {
  const direct = toPositiveInt(payload);
  if (direct) return direct;

  if (!payload || typeof payload !== "object") return null;

  const candidates = [
    payload.DEAL_ID,
    payload.dealId,
    payload.DEAL,
    payload.deal,
    payload.ID,
    payload.id,
    payload.result,
  ];

  for (const item of candidates) {
    const id = toPositiveInt(item);
    if (id) return id;

    if (item && typeof item === "object") {
      const nested = extractDealId(item);
      if (nested) return nested;
    }
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = extractDealId(item);
      if (nested) return nested;
    }
  }

  return null;
}

function isLeadConverted(lead) {
  const convertedFlags = [lead?.CONVERT, lead?.IS_CONVERTED, lead?.CONVERTED]
    .map((x) =>
      String(x || "")
        .trim()
        .toUpperCase(),
    )
    .filter(Boolean);

  if (convertedFlags.includes("Y")) return true;
  return (
    String(lead?.STATUS_ID || "")
      .trim()
      .toUpperCase() === "CONVERTED"
  );
}

function buildDealTitle({ leadId, orderNumbers }) {
  const primaryOrderNumber = getPrimaryOrderNumber(orderNumbers);
  if (primaryOrderNumber) return primaryOrderNumber;
  return `Лид #${leadId}`;
}

function buildDealFields({ lead, leadId, orderNumbers, dialogId }) {
  const normalizedOrders = normalizeOrderNumbers(orderNumbers);
  const primaryOrderNumber = getPrimaryOrderNumber(normalizedOrders);
  const orderFieldCode = crmSettings?.dealFields?.ORDER_NUMBER || null;

  const fields = {
    TITLE: buildDealTitle({
      leadId,
      orderNumbers: normalizedOrders,
    }),
    COMMENTS:
      `Создано автоматически после заказа в ABCP. Лид #${leadId}.` +
      (normalizedOrders.length > 0 ? ` Заказ ABCP: №${normalizedOrders.join(", ")}.` : "") +
      (dialogId ? ` Диалог: ${dialogId}.` : ""),
    LEAD_ID: Number(leadId),
  };

  if (primaryOrderNumber) {
    fields.ORIGIN_ID = primaryOrderNumber;
    if (orderFieldCode) {
      const numericOrder = toFiniteNumberOrNull(primaryOrderNumber);
      fields[orderFieldCode] = numericOrder !== null ? numericOrder : primaryOrderNumber;
    }
  }

  const assignedBy = toPositiveInt(lead?.ASSIGNED_BY_ID);
  if (assignedBy) fields.ASSIGNED_BY_ID = assignedBy;

  const companyId = toPositiveInt(lead?.COMPANY_ID);
  if (companyId) fields.COMPANY_ID = companyId;

  const contactId = toPositiveInt(lead?.CONTACT_ID);
  if (contactId) {
    fields.CONTACT_ID = contactId;
    fields.CONTACT_IDS = [contactId];
  }

  const sourceId = String(lead?.SOURCE_ID || "").trim();
  if (sourceId) fields.SOURCE_ID = sourceId;

  const sourceDescription = String(lead?.SOURCE_DESCRIPTION || "").trim();
  if (sourceDescription) fields.SOURCE_DESCRIPTION = sourceDescription;

  return fields;
}

async function addLeadComment(api, leadId, text) {
  try {
    await api.call("crm.timeline.comment.add", {
      fields: {
        ENTITY_TYPE_ID: 1,
        ENTITY_ID: Number(leadId),
        COMMENT: text,
      },
    });
  } catch (err) {
    logger.warn(
      { ctx: CTX, leadId, err: err?.message || String(err) },
      "Failed to add lead timeline comment",
    );
  }
}

async function tryLeadConvert(api, leadId, dealFields) {
  const payloads = [
    {
      id: Number(leadId),
      fields: {
        DEAL_TITLE: dealFields.TITLE,
      },
    },
    { ID: Number(leadId) },
    { id: Number(leadId) },
  ];

  let lastErr = null;
  for (const payload of payloads) {
    try {
      const res = await api.call("crm.lead.convert", payload);
      const dealId = extractDealId(res);
      return { ok: true, dealId, raw: res };
    } catch (err) {
      lastErr = err;
    }
  }

  return {
    ok: false,
    dealId: null,
    error: lastErr ? String(lastErr?.message || lastErr) : "convert_failed",
  };
}

async function updateDealAfterConvert(api, dealId, dealFields) {
  const dealIdNum = toPositiveInt(dealId);
  if (!dealIdNum || !dealFields || typeof dealFields !== "object") return;

  const fields = {};
  const orderFieldCode = crmSettings?.dealFields?.ORDER_NUMBER || null;

  const copyIfFilled = (key) => {
    if (!Object.prototype.hasOwnProperty.call(dealFields, key)) return;
    const value = dealFields[key];
    if (value === null || value === undefined) return;
    if (typeof value === "string" && !value.trim()) return;
    fields[key] = value;
  };

  copyIfFilled("TITLE");
  copyIfFilled("COMMENTS");
  copyIfFilled("LEAD_ID");
  copyIfFilled("ASSIGNED_BY_ID");
  copyIfFilled("COMPANY_ID");
  copyIfFilled("CONTACT_ID");
  copyIfFilled("CONTACT_IDS");
  copyIfFilled("SOURCE_ID");
  copyIfFilled("SOURCE_DESCRIPTION");
  copyIfFilled("ORIGIN_ID");
  if (orderFieldCode) copyIfFilled(orderFieldCode);

  if (Object.keys(fields).length === 0) return;

  try {
    await api.call("crm.deal.update", {
      id: dealIdNum,
      fields,
    });
  } catch (err) {
    logger.warn(
      {
        ctx: CTX,
        dealId: dealIdNum,
        err: err?.message || String(err),
      },
      "Failed to update converted deal with ABCP order binding fields",
    );
  }
}

async function setLeadSuccessStatus(api, leadId) {
  const successStatus = crmSettings?.stageToStatusId?.SUCCESS || null;
  if (!successStatus) return;

  try {
    await api.call("crm.lead.update", {
      id: Number(leadId),
      fields: {
        STATUS_ID: successStatus,
      },
    });
  } catch (err) {
    logger.warn(
      { ctx: CTX, leadId, successStatus, err: err?.message || String(err) },
      "Failed to move lead to success status after deal creation",
    );
  }
}

async function findExistingDealId(api, { leadId, orderNumbers = [] } = {}) {
  const leadIdNum = toPositiveInt(leadId);
  const normalizedOrders = normalizeOrderNumbers(orderNumbers);
  const orderFieldCode = crmSettings?.dealFields?.ORDER_NUMBER || null;

  const select = ["ID", "LEAD_ID", "ORIGIN_ID"];
  if (orderFieldCode) select.push(orderFieldCode);

  const filters = [];

  if (leadIdNum) {
    filters.push({ LEAD_ID: leadIdNum });
  }

  for (const orderNumber of normalizedOrders) {
    filters.push({ ORIGIN_ID: orderNumber });

    if (orderFieldCode) {
      const asNumber = toFiniteNumberOrNull(orderNumber);
      if (asNumber !== null) {
        filters.push({ [orderFieldCode]: asNumber });
      } else {
        filters.push({ [orderFieldCode]: orderNumber });
      }
    }
  }

  for (const filter of filters) {
    try {
      const raw = await api.call("crm.deal.list", {
        filter,
        select,
        order: { ID: "DESC" },
        start: 0,
      });
      const list = listFromBitrixListResult(raw);
      const found = list.find((x) => toPositiveInt(x?.ID || x?.id));
      const dealId = toPositiveInt(found?.ID || found?.id);
      if (dealId) return dealId;
    } catch (err) {
      logger.warn(
        { ctx: CTX, filter, err: err?.message || String(err) },
        "Failed to lookup existing deal before fallback create",
      );
    }
  }

  return null;
}

export async function convertLeadToDealAfterAbcpOrder({
  portal,
  leadId,
  orderNumbers = [],
  dialogId = null,
  api: apiInjected = null,
}) {
  const leadIdNum = toPositiveInt(leadId);
  const normalizedOrderNumbers = normalizeOrderNumbers(orderNumbers);
  if (!portal) return { ok: false, reason: "NO_PORTAL", dealId: null };
  if (!leadIdNum) return { ok: false, reason: "NO_LEAD_ID", dealId: null };

  let api = apiInjected;
  if (!api) {
    const portalCfg = await getPortalAsync(portal);
    if (!portalCfg?.baseUrl || !portalCfg?.accessToken) {
      return { ok: false, reason: "NO_PORTAL_AUTH", dealId: null };
    }
    api = makeBitrixClient({
      domain: portal,
      baseUrl: portalCfg.baseUrl,
      accessToken: portalCfg.accessToken,
    });
  }

  let lead = null;
  try {
    lead = await api.call("crm.lead.get", { id: leadIdNum });
  } catch (err) {
    logger.error(
      { ctx: CTX, portal, leadId: leadIdNum, err: err?.message || String(err) },
      "Failed to read lead before conversion",
    );
    return { ok: false, reason: "LEAD_GET_FAILED", dealId: null };
  }

  if (isLeadConverted(lead)) {
    const existingDealId = await findExistingDealId(api, {
      leadId: leadIdNum,
      orderNumbers: normalizedOrderNumbers,
    });
    return { ok: true, reason: "LEAD_ALREADY_CONVERTED", dealId: existingDealId };
  }

  const dealFields = buildDealFields({
    lead,
    leadId: leadIdNum,
    orderNumbers: normalizedOrderNumbers,
    dialogId,
  });

  // Primary path: native lead conversion.
  const converted = await tryLeadConvert(api, leadIdNum, dealFields);
  if (converted.ok) {
    if (converted.dealId) {
      await updateDealAfterConvert(api, converted.dealId, dealFields);
    }

    await addLeadComment(
      api,
      leadIdNum,
      converted.dealId
        ? `Лид автоматически сконвертирован в сделку #${converted.dealId}.`
        : "Лид автоматически сконвертирован в сделку (ID сделки не вернулся в ответе API).",
    );

    return {
      ok: true,
      reason: converted.dealId ? "LEAD_CONVERTED_TO_DEAL" : "LEAD_CONVERTED_NO_DEAL_ID",
      dealId: converted.dealId,
    };
  }

  // Fallback path: create deal directly, then move lead to success stage.
  try {
    const existingDealId = await findExistingDealId(api, {
      leadId: leadIdNum,
      orderNumbers: normalizedOrderNumbers,
    });
    if (existingDealId) {
      await updateDealAfterConvert(api, existingDealId, dealFields);
      await setLeadSuccessStatus(api, leadIdNum);

      logger.info(
        { ctx: CTX, leadId: leadIdNum, dealId: existingDealId },
        "Found existing deal before fallback create, duplicate prevented",
      );

      return {
        ok: true,
        reason: "DEAL_ALREADY_EXISTS",
        dealId: existingDealId,
      };
    }

    const addRes = await api.call("crm.deal.add", {
      fields: dealFields,
      params: {
        REGISTER_SONET_EVENT: "Y",
      },
    });

    const dealId = extractDealId(addRes);
    if (!dealId) {
      logger.error(
        { ctx: CTX, portal, leadId: leadIdNum, addRes },
        "Deal created by fallback but deal ID was not found",
      );
      return { ok: false, reason: "DEAL_ID_NOT_FOUND", dealId: null };
    }

    await updateDealAfterConvert(api, dealId, dealFields);
    await setLeadSuccessStatus(api, leadIdNum);
    await addLeadComment(api, leadIdNum, `Создана сделка #${dealId} после заказа в ABCP.`);

    return {
      ok: true,
      reason: "DEAL_CREATED_BY_FALLBACK",
      dealId,
    };
  } catch (err) {
    logger.error(
      {
        ctx: CTX,
        portal,
        leadId: leadIdNum,
        convertError: converted.error,
        err: err?.message || String(err),
      },
      "Failed to convert lead to deal",
    );

    return {
      ok: false,
      reason: "CONVERT_AND_FALLBACK_FAILED",
      dealId: null,
    };
  }
}

export default { convertLeadToDealAfterAbcpOrder };
