// src/modules/crm/leads.js
// Единая обёртка над CRM Bitrix24 для работы с лидами.
//
// Ожидаем клиент вида:
//   const rest = makeBitrixClient(...);
//   rest.call(method, params) -> Promise<any>
//
// Используется из handler_llm_manager.js через createLeadsApi(rest).

/**
 * Маппинг наших внутренних стадий в STATUS_ID Bitrix.
 * Подкорректируешь под свою воронку (или вынесем в config/settings.json).
 *
 * Стандартные статусы по умолчанию:
 *   NEW        — новый лид
 *   IN_PROCESS — в работе
 *   CONVERTED  — успешно сконвертирован
 *   JUNK       — некачественный (мусор)
 */
const STAGE_TO_STATUS_ID = {
  NEW: "NEW",               // только пришёл
  QUALIFY: "IN_PROCESS",    // квалификация
  PRICING: "IN_PROCESS",    // отправлен подбор/цены
  WAITING_CUSTOMER: "IN_PROCESS",
  WON: "CONVERTED",         // успешно (можно конвертировать в сделку)
  LOST: "JUNK",             // отказ/мусор
};

/**
 * Сбор стандартных полей лида из данных сессии бота.
 *
 * session:
 *   {
 *     name: "Иван",
 *     phone: "+79990001122",
 *     email: "user@example.com",
 *     lastQuery: "Нужны передние тормозные колодки на BMW",
 *     // ...
 *   }
 *
 * dialogMeta:
 *   {
 *     dialogId: "chat123",
 *     chatId: 123,
 *     source: "OPENLINES",
 *   }
 */
function buildLeadFieldsFromSession(session, dialogMeta = {}) {
  const { name, phone, email, lastQuery } = session || {};
  const { dialogId, source } = dialogMeta;

  const commentsParts = [];

  if (lastQuery) commentsParts.push(`Запрос клиента: ${lastQuery}`);
  if (dialogId) commentsParts.push(`Диалог: ${dialogId}`);
  if (source) commentsParts.push(`Источник: ${source}`);

  const COMMENTS = commentsParts.join("\n");

  const fields = {
    TITLE: name
      ? `Запрос запчастей: ${name}`
      : "Запрос запчастей (бот)",
    NAME: name || "",
    SOURCE_ID: source || "OPENLINES",
  };

  if (COMMENTS) {
    fields.COMMENTS = COMMENTS;
  }

  if (phone) {
    // Bitrix ожидает массив мультиполей PHONE
    fields.PHONE = [
      {
        VALUE: phone,
        VALUE_TYPE: "WORK",
      },
    ];
  }

  if (email) {
    fields.EMAIL = [
      {
        VALUE: email,
        VALUE_TYPE: "WORK",
      },
    ];
  }

  return fields;
}

/**
 * Построить product rows для crm.lead.productrows.set из picks ABCP.
 *
 * picks — массив объектов формата:
 *   { idx, qty, item: { oem, offer, days, daysText, brand, name, priceNum } }
 */
function buildProductRowsFromSelection(picks = []) {
  const rows = [];

  for (const p of picks) {
    if (!p || !p.item) continue;

    const { oem, offer, brand, name, priceNum } = p.item;

    let price = typeof priceNum === "number" && Number.isFinite(priceNum)
      ? priceNum
      : Number(String((offer && offer.price) ?? "").replace(",", "."));

    if (!Number.isFinite(price) || price <= 0) {
      continue;
    }

    const brandTitle =
      brand ||
      (offer && (offer.brand || offer.maker || offer.manufacturer || offer.vendor)) ||
      "";
    const nameTitle =
      name ||
      (offer &&
        (offer.name ||
          offer.detailName ||
          offer.description ||
          offer.displayName ||
          offer.goodName)) ||
      "";

    const productNameParts = [];
    if (oem) productNameParts.push(String(oem).trim());
    if (brandTitle) productNameParts.push(String(brandTitle).trim());
    if (nameTitle) productNameParts.push(String(nameTitle).trim());

    const PRODUCT_NAME =
      productNameParts.join(" ").trim() || String(oem || "Запчасть").trim();

    const qty = Number(p.qty) > 0 ? Number(p.qty) : 1;

    rows.push({
      PRODUCT_NAME,
      PRICE: Math.round(price),
      QUANTITY: qty,
    });
  }

  return rows;
}

/**
 * Фабрика API для работы с лидами.
 *
 * @param {object} rest - клиент, у которого есть method call(method, params)
 */
export function createLeadsApi(rest) {
  if (!rest || typeof rest.call !== "function") {
    throw new Error("[crm/leads] createLeadsApi: rest.call is required");
  }

  /**
   * Создать лид по данным сессии.
   * Сейчас используем crm.lead.add (надёжно и просто).
   */
  async function createLeadFromSession(session, dialogMeta = {}) {
    const fields = buildLeadFieldsFromSession(session, dialogMeta);

    const result = await rest.call("crm.lead.add", { fields });
    const leadId = Number(result);

    if (!leadId || Number.isNaN(leadId)) {
      throw new Error(
        `[crm/leads] crm.lead.add returned invalid id: ${JSON.stringify(
          result
        )}`
      );
    }

    console.info("[crm/leads] Lead created:", leadId);
    return leadId;
  }

  /**
   * Обновление лида.
   * fields — объект полей, который пойдёт напрямую в crm.lead.update.
   * ВАЖНО: здесь мы не "домысливаем" структуру полей, ожидаем корректный формат.
   */
  async function updateLead(leadId, fields) {
    if (!leadId) {
      console.warn("[crm/leads] updateLead called without leadId");
      return false;
    }
    if (!fields || Object.keys(fields).length === 0) {
      return true;
    }

    const res = await rest.call("crm.lead.update", {
      id: leadId,
      fields,
    });

    const ok = !!res;
    if (!ok) {
      console.warn(
        "[crm/leads] crm.lead.update returned falsy/zero result:",
        res
      );
    }

    return ok;
  }

  /**
   * Установить стадию лида по нашему stage-коду.
   * stage: "NEW" | "QUALIFY" | "PRICING" | "WAITING_CUSTOMER" | "WON" | "LOST"
   */
  async function setLeadStage(leadId, stage) {
    if (!leadId || !stage) {
      return false;
    }

    const statusId = STAGE_TO_STATUS_ID[stage];
    if (!statusId) {
      console.warn("[crm/leads] Unknown stage, skip setLeadStage:", stage);
      return false;
    }

    return updateLead(leadId, { STATUS_ID: statusId });
  }

  /**
   * Добавить комментарий к лиду (через поле COMMENTS).
   * Для простоты вытаскиваем текущий COMMENTS и дописываем текст.
   */
  async function appendComment(leadId, comment) {
    if (!leadId || !comment) return false;

    let lead;
    try {
      lead = await rest.call("crm.lead.get", { id: leadId });
    } catch (e) {
      console.error("[crm/leads] crm.lead.get failed:", e);
      return false;
    }

    const prev = (lead && lead.COMMENTS) || "";
    const next = prev ? `${prev}\n\n${comment}` : comment;

    return updateLead(leadId, { COMMENTS: next });
  }

  /**
   * Установить product rows для лида (crm.lead.productrows.set).
   * rows — массив объектов вида { PRODUCT_NAME, PRICE, QUANTITY, ... }.
   */
  async function setProductRows(leadId, rows) {
    if (!leadId) {
      console.warn("[crm/leads] setProductRows called without leadId");
      return false;
    }
    if (!rows || rows.length === 0) {
      return true;
    }

    const res = await rest.call("crm.lead.productrows.set", {
      id: leadId,
      rows,
    });

    const ok = !!res;
    if (!ok) {
      console.warn(
        "[crm/leads] crm.lead.productrows.set returned falsy/zero result:",
        res
      );
    }

    return ok;
  }

  /**
   * Установить product rows по результату выбора ABCP.
   * picks — массив из tryHandleSelectionMessage.
   */
  async function setProductRowsFromSelection(leadId, picks) {
    const rows = buildProductRowsFromSelection(picks || []);
    if (!rows.length) {
      console.info(
        "[crm/leads] setProductRowsFromSelection: no rows built from picks"
      );
      return false;
    }
    return setProductRows(leadId, rows);
  }

  /**
   * Гарантировать, что у сессии есть leadId:
   *  - если уже есть -> вернуть его;
   *  - если нет -> создать новый лид и записать в session.leadId.
   *
   * В дальнейшем можно добавить:
   *  - поиск по телефону (чтобы не плодить дубликаты),
   *  - поиск по кастомному UF_ полю (например, по dialogId).
   */
  async function ensureLeadForDialog(session, dialogMeta = {}) {
    if (!session) {
      throw new Error("[crm/leads] ensureLeadForDialog: session is required");
    }

    if (session.leadId) {
      return session.leadId;
    }

    const leadId = await createLeadFromSession(session, dialogMeta);
    session.leadId = leadId;
    session.leadCreated = true;

    return leadId;
  }

  return {
    // вспомогательная (если захочешь использовать вне)
    buildLeadFieldsFromSession,
    // products
    setProductRows,
    setProductRowsFromSelection,
    // базовые операции
    createLeadFromSession,
    updateLead,
    setLeadStage,
    appendComment,
    ensureLeadForDialog,
  };
}
