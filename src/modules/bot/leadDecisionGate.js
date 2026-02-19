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

  // Статусы, где бот должен молчать (ручные)
  manualStatuses = [],

  // OEM, уже записанный в лид (UF поле)
  oemInLead = null,

  // Флаги сессии
  sessionMode, // "auto" | "manual"
  manualAckSent = false,
}) {
  const oemCount = Array.isArray(detectedOems) ? detectedOems.length : 0;
  const oemInMessage = oemCount > 0;

  const manualByStatus =
    !!leadStatusId && Array.isArray(manualStatuses) && manualStatuses.includes(leadStatusId);

  const manualByAuthor = authorType === "manager";
  const manualBySession = sessionMode === "manual";

  const manualLock = manualByStatus || manualByAuthor || manualBySession;

  const isComplexBySignal = requestType === "VIN" || requestType === "COMPLEX" || hasImage;

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
  //    Единственный триггер выхода — OEM в поле лида.
  // -----------------------------
  if (manualLock) {
    // Даже если клиент прислал OEM в тексте — молчим.
    // Ждём, пока менеджер зафиксирует OEM в UF-поле.
    if (!oemInLead) {
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

    // OEM уже в лиде → можно включать AUTO
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
  // - PRICING: выбор варианта / уточнения (но только если есть offers)
  // - CONTACT/FINAL: сбор данных / подтверждение
  if (requestType === "TEXT") {
    const stage = String(leadStageKey || "");
    const allowByStage =
      stage === "NEW" ||
      stage === "" ||
      stage === "CONTACT" ||
      stage === "FINAL" ||
      stage === "ABCP_CREATE" ||
      (stage === "PRICING" && hasOffers);

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
