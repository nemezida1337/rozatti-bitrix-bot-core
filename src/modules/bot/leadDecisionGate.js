/**
 * leadDecisionGate.js
 *
 * Единая точка принятия решений:
 * - отвечать или молчать
 * - звать Cortex или нет
 * - двигать стадию или нет
 * - слать ли одноразовый ACK в ручном режиме
 * - можно ли прямо сейчас писать OEM в UF-поле (только если OEM один)
 *
 * НИЧЕГО не делает сам, только возвращает решение.
 */

import { isLegacyNodeClassificationEnabled } from "./handler/shared/classificationMode.js";

export function leadDecisionGate({
  // Кто написал сообщение
  authorType, // "client" | "manager" | "system"

  // Тип запроса (сигнал из message)
  // "OEM" | "VIN" | "COMPLEX" | "TEXT" | "EMPTY"
  requestType,

  // Есть ли вложения/картинки
  hasImage = false,

  // OEM, детектнутые из текста
  detectedOems = [],

  // Текущий STATUS_ID лида в CRM
  leadStatusId = null,

  // Нормализованная стадия (по stageToStatusId), например: NEW/PRICING/CONTACT/FINAL/IN_WORK/VIN_PICK
  leadStageKey = null,

  // Есть ли уже офферы в сессии (важно для PRICING)
  hasOffers = false,

  // Исходный текст (нужен для развилки в PRICING)
  rawText = "",

  // Статусы, где бот должен молчать (ручные)
  manualStatuses = [],

  // OEM, уже записанный в лид (UF поле)
  oemInLead = null,

  // Флаги сессии
  sessionMode, // "auto" | "manual"
  manualAckSent = false,

  // Явный override для canary/shadow, иначе берём режим из env.
  legacyNodeClassificationOverride = null,
}) {
  const oemCount = Array.isArray(detectedOems) ? detectedOems.length : 0;
  const oemInMessage = oemCount > 0;

  const manualByStatus =
    !!leadStatusId && Array.isArray(manualStatuses) && manualStatuses.includes(leadStatusId);

  const manualByAuthor = authorType === "manager";
  const manualBySession = sessionMode === "manual";

  const manualLock = manualByStatus || manualByAuthor || manualBySession;

  const isComplexBySignal = requestType === "VIN" || requestType === "COMPLEX" || hasImage;
  const normalizedText = String(rawText || "").trim().toLowerCase();

  const offerNumberListRegex = /^\s*\d+(?:\s*[,;/+\-\s]\s*\d+)*\s*$/;
  const offerIndexRegex = /\b\d{1,2}\b/;
  const offerHintRegex = /(вариант|варианта|варианты|позици|предложени|предложение|офер|offer)/i;
  const offerActionRegex =
    /(беру|выбираю|возьму|подходит|подойдет|пойдет|устроит|устраивает|оформля|заказыва|подтверждаю|давайте|ок)/i;
  const offerOrdinalRegex = /(перв|втор|трет|четверт|пят|шест|седьм|восьм|девят|десят)\w*/i;

  const pricingObjectionPriceRegex =
    /(дорог|дорого|дороговато|дешев|скидк|цена|ценник|дороже|дорогая)/i;
  const pricingObjectionDeliveryRegex =
    /(долго|долгий|срок|быстрее|когда|ждать|доставка|дней|дня)/i;
  const pricingFollowupRegex =
    /(ну что|что там|есть новости|ап\b|up\b|статус|напом|жду ответ|когда ответ)/i;

  const isPricingSelectionText = (() => {
    if (!normalizedText) return false;
    if (offerNumberListRegex.test(normalizedText)) return true;

    const hasIndex = offerIndexRegex.test(normalizedText) || offerOrdinalRegex.test(normalizedText);
    const hasHint = offerHintRegex.test(normalizedText);
    const hasAction = offerActionRegex.test(normalizedText);

    if (hasAction && (hasHint || hasIndex)) return true;
    if (hasHint && hasIndex) return true;
    return false;
  })();

  const isPricingObjectionPrice = pricingObjectionPriceRegex.test(normalizedText);
  const isPricingObjectionDelivery = pricingObjectionDeliveryRegex.test(normalizedText);
  const isPricingFollowup = pricingFollowupRegex.test(normalizedText);
  const legacyNodeClassification =
    typeof legacyNodeClassificationOverride === "boolean"
      ? legacyNodeClassificationOverride
      : isLegacyNodeClassificationEnabled();

  // -----------------------------
  // 0) SYSTEM / invalid
  // -----------------------------
  if (authorType === "system") {
    return {
      mode: sessionMode || "auto",
      waitReason: "SYSTEM",
      shouldReply: false,
      replyType: null,
      shouldCallCortex: false,
      shouldMoveStage: false,
      shouldWriteOemToLead: false,
      oemCandidates: [],
    };
  }

  // -----------------------------
  // 1) MANUAL LOCK: менеджер в чате или ручная стадия
  //    В этом режиме бот НЕ отвечает и НЕ действует.
  //    Выход в AUTO допускаем только для клиентского потока на стадии VIN_PICK,
  //    когда OEM уже зафиксирован в поле лида.
  // -----------------------------
  if (manualLock) {
    const isVinPickStage = String(leadStageKey || "").toUpperCase() === "VIN_PICK";
    const canAutoStartFromManual = !!oemInLead && !manualByAuthor && isVinPickStage;

    // Даже если клиент прислал OEM в тексте — молчим.
    // Ждём, пока менеджер зафиксирует OEM в UF-поле на VIN_PICK.
    if (!canAutoStartFromManual) {
      return {
        mode: "manual",
        waitReason: "WAIT_OEM_MANUAL",
        shouldReply: false,
        replyType: null,
        shouldCallCortex: false,
        shouldMoveStage: false,
        shouldWriteOemToLead: false,
        oemCandidates: oemInMessage ? detectedOems : [],
      };
    }

    // OEM уже в лиде на VIN_PICK (без менеджерского текста) → можно включать AUTO
    return {
      mode: "auto",
      waitReason: null,
      shouldReply: true,
      replyType: "AUTO_START",
      shouldCallCortex: true,
      shouldMoveStage: true,
      shouldWriteOemToLead: false, // уже есть в лиде
      oemCandidates: [],
    };
  }

  // -----------------------------
  // 2) Нет manualLock (AUTO разрешён)
  // -----------------------------

  // 2.0) Пустое сообщение — ничего не делаем
  if (requestType === "EMPTY") {
    return {
      mode: sessionMode || "auto",
      waitReason: "EMPTY",
      shouldReply: false,
      replyType: null,
      shouldCallCortex: false,
      shouldMoveStage: false,
      shouldWriteOemToLead: false,
      oemCandidates: [],
    };
  }

  // 2.1) VIN всегда уводим в ручной сценарий (даже если в тексте есть OEM)
  if (requestType === "VIN") {
    return {
      mode: "manual",
      waitReason: "VIN_WAIT_OEM",
      shouldReply: !manualAckSent,
      replyType: !manualAckSent ? "MANUAL_ACK" : null,
      shouldCallCortex: false,
      shouldMoveStage: true,
      shouldWriteOemToLead: false,
      oemCandidates: oemInMessage ? detectedOems : [],
    };
  }

  // 2.1) VIN/COMPLEX/PHOTO → ставим ручную стадию + 1 ACK, дальше ждём OEM в поле
  if (isComplexBySignal && !oemInMessage) {
    return {
      mode: "manual",
      waitReason:
        requestType === "VIN"
          ? "VIN_WAIT_OEM"
          : hasImage
            ? "PHOTO_WAIT_OEM"
            : "COMPLEX_WAIT_OEM",
      shouldReply: !manualAckSent,
      replyType: !manualAckSent ? "MANUAL_ACK" : null,
      shouldCallCortex: false,
      shouldMoveStage: true,
      shouldWriteOemToLead: false,
      oemCandidates: [],
    };
  }

  // 2.2) Есть OEM в сообщении → AUTO старт
  if (oemInMessage) {
    const shouldWriteOemToLead = oemCount === 1 && !oemInLead;

    return {
      mode: "auto",
      waitReason: null,
      shouldReply: true,
      replyType: "AUTO_START",
      shouldCallCortex: true,
      shouldMoveStage: true,
      shouldWriteOemToLead,
      oemCandidates: detectedOems,
    };
  }

  // 2.3) Обычный текст без OEM.
  // Разрешаем Cortex только на "продажных" стадиях, где это реально нужно:
  // - PRICING: выбор варианта (клиент явно выбирает оффер)
  // - CONTACT/FINAL: сбор данных / подтверждение
  if (requestType === "TEXT") {
    const stage = String(leadStageKey || "");

    if (legacyNodeClassification && stage === "PRICING" && hasOffers && !isPricingSelectionText) {
      let replyType = "PRICING_NEED_SELECTION";
      if (isPricingObjectionPrice) replyType = "PRICING_OBJECTION_PRICE";
      else if (isPricingObjectionDelivery) replyType = "PRICING_OBJECTION_DELIVERY";
      else if (isPricingFollowup) replyType = "PRICING_FOLLOWUP";

      return {
        mode: sessionMode || "auto",
        waitReason: replyType,
        shouldReply: true,
        replyType,
        shouldCallCortex: false,
        shouldMoveStage: false,
        shouldWriteOemToLead: false,
        oemCandidates: [],
      };
    }

    const allowByStage =
      stage === "NEW" ||
      stage === "" ||
      stage === "CONTACT" ||
      stage === "ADDRESS" ||
      stage === "FINAL" ||
      stage === "ABCP_CREATE" ||
      (stage === "PRICING" &&
        (legacyNodeClassification ? hasOffers && isPricingSelectionText : true));

    if (allowByStage) {
      return {
        mode: sessionMode || "auto",
        waitReason: null,
        shouldReply: true,
        replyType: null,
        shouldCallCortex: true,
        shouldMoveStage: true,
        shouldWriteOemToLead: false,
        oemCandidates: [],
      };
    }
  }

  // Всё остальное — молчим
  return {
    mode: sessionMode || "auto",
    waitReason: "NO_OEM_TEXT",
    shouldReply: false,
    replyType: null,
    shouldCallCortex: false,
    shouldMoveStage: false,
    shouldWriteOemToLead: false,
    oemCandidates: [],
  };
}
