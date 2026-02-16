// config/settings.crm.js
// Настройки CRM для Rozatti Bot (лиды Bitrix24)

export const crmSettings = {
  // Источник лида
  sourceId: "OPENLINES",

  // Кастомные поля лида
  leadFields: {
    OEM: "UF_CRM_1762873310878",
    // Адрес доставки (поле лида)
    DELIVERY_ADDRESS: "UF_CRM_1765564522",
    HF_CORTEX_LOG: "UF_CRM_1764615831",
  },

  /**
   * Маппинг стадий HF-CORTEX → CRM STATUS_ID (воронка лидов Bitrix24)
   *
   * Твои стадии в Bitrix (LEAD STATUS_ID):
   * - NEW        = "Новое обращение"
   * - UC_ZA04R1  = "Взять в работу!"
   * - UC_UAO7E9  = "VIN подбор"
   * - UC_5SCNOB  = "Дали цену (ДУМАЕТ)"
   * - PROCESSED  = "Ожидает ФИО(НАДУМАЛ)"
   * - UC_G4O6PE  = "Ожидает Адрес"
   * - UC_T710VD  = "Создать в ABCP"
   *
   * Важно:
   * - Stage SUCCESS в лидах больше не используем (переезд в сделки).
   * - Финальная стадия лида для бота: FINAL/ABCP_CREATE → "Создать в ABCP".
   */
  stageToStatusId: {
    // 1) Новое обращение
    NEW: "NEW",

    // 2) Взять в работу (ручная обработка менеджером)
    IN_WORK: "UC_ZA04R1",

    // 3) VIN подбор (ручная/полуручная стадия)
    VIN_PICK: "UC_UAO7E9",

    // 4) Дали цену (думает)
    PRICING: "UC_5SCNOB",

    // 5) Ожидает ФИО/телефон (контактные данные)
    CONTACT: "PROCESSED",

    // 6) Ожидает адрес
    ADDRESS: "UC_G4O6PE",

    // 7) Создать в ABCP (шлюз на оформление заказа / дальше уйдём в сделки)
    FINAL: "UC_T710VD",
    ABCP_CREATE: "UC_T710VD",
  },

  /**
   * Статусы, в которых бот НЕ должен писать в чат, а должен тихо обогащать CRM.
   * (Следующий шаг: silent enrichment)
   */
  manualStatuses: [
    "UC_ZA04R1", // Взять в работу!
    "UC_UAO7E9", // VIN подбор
  ],

  /**
   * (Опционально) Статусы "потерь/мусора" для маппинга LOST/BAD_LEAD, если решишь включить.
   */
  lossStatusId: {
    BAD_LEAD: "JUNK",
    // LOST_IGNORES_3D: "1",
    // LOST_NO_DEALER: "2",
    // LOST_WANTED_STOCK: "3",
    // LOST_TOO_EXPENSIVE: "UC_B3BNIC",
  },
};
