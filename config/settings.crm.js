// config/settings.crm.js
// Настройки CRM для Rozatti Bot (лиды Bitrix24)

export const crmSettings = {
  // Источник лида (можно поменять на свой, если заведёшь справочник)
  sourceId: "OPENLINES",

  // Кастомные поля лида (UF_CRM_...)
  leadFields: {
    // Поле OEM (множественное), из твоего скрина:
    // /crm/configs/fields/CRM_LEAD/edit/UF_CRM_1762873310878/
    OEM: "UF_CRM_1762873310878",
  },

  // Маппинг стадий LLM-воронки в STATUS_ID Bitrix.
  // При желании можно поменять на свои статусы/воронки.
  stageToStatusId: {
    NEW: "NEW",          // новый лид
    PRICING: "IN_PROCESS",
    CONTACT: "IN_PROCESS",
    FINAL: "IN_PROCESS",
  },

  // На будущее: сюда можно добавить коды полей "Причина отказа", и т.п.
  // leadFields: {
  //   OEM: "UF_CRM_1762873310878",
  //   REJECT_REASON: "UF_CRM_XXXXXXXXXXXX",
  //   REJECT_REASON_TEXT: "UF_CRM_YYYYYYYYYYYY",
  //   CANCEL_REASON: "UF_CRM_ZZZZZZZZZZZZ",
  // },
};
