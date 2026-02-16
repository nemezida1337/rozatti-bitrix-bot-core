// src/core/eventBus.js
// Простейший in-memory EventBus для HF-OS.
// Задачи:
//  - централизованная публикация событий (USER_MESSAGE, LLM_RESPONSE, ABCP_RESULT, CRM_UPDATE и т.д.)
//  - подписчики (логгеры, HF-аналитика, метрики, алерты)
//  - готовность к замене на внешнюю шину (Kafka/Rabbit/HF-Store)

import { logger } from "./logger.js";

const CTX = "core/eventBus";

class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.handlers = new Map();
  }

  /**
   * Подписка на событие
   * @param {string} event
   * @param {(payload: any) => void | Promise<void>} handler
   */
  on(event, handler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }

    this.handlers.get(event).add(handler);
  }

  /**
   * Отписка от события
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    if (!this.handlers.has(event)) return;
    this.handlers.get(event).delete(handler);
  }

  /**
   * Публикация события.
   * Все подписчики вызываются последовательно.
   * Если какой-то из них бросает ошибку — логируем и идём дальше.
   * @param {string} event
   * @param {any} payload
   */
  async emit(event, payload) {
    const ctx = `${CTX}.emit`;

    const handlers = this.handlers.get(event);
    if (!handlers || handlers.size === 0) {
      logger.debug({ ctx, event }, "No handlers for event");
      return;
    }

    for (const handler of handlers) {
      try {
        const res = handler(payload);
        if (res && typeof res.then === "function") {
          await res;
        }
      } catch (err) {
        logger.error(
          { ctx, event, payload, err },
          "Error in event handler",
        );
      }
    }
  }
}

export const eventBus = new EventBus();

//
// Базовые подписчики: логгирование ключевых событий
//
eventBus.on("USER_MESSAGE", (p) => {
  logger.info(
    {
      ctx: CTX,
      event: "USER_MESSAGE",
      portal: p.portal,
      dialogId: p.dialogId,
    },
    `User message: ${p.text}`,
  );
});

eventBus.on("LLM_RESPONSE", (p) => {
  logger.info(
    {
      ctx: CTX,
      event: "LLM_RESPONSE",
      portal: p.portal,
      dialogId: p.dialogId,
      pass: p.pass,
      backend: p.backend,
    },
    "LLM response received",
  );
});

eventBus.on("ABCP_RESULT", (p) => {
  logger.info(
    {
      ctx: CTX,
      event: "ABCP_RESULT",
      portal: p.portal,
      dialogId: p.dialogId,
      oems: p.oems,
    },
    "ABCP lookup result",
  );
});

eventBus.on("HF_CORTEX_RESPONSE", (p) => {
  logger.info(
    {
      ctx: CTX,
      event: "HF_CORTEX_RESPONSE",
      portal: p.portal,
      dialogId: p.dialogId,
    },
    "HF-CORTEX response received",
  );
});

eventBus.on("HF_CORTEX_CALLED", (p) => {
  logger.info(
    {
      ctx: CTX,
      event: "HF_CORTEX_CALLED",
      portal: p.portal,
      dialogId: p.dialogId,
      pass: p.pass,
      payloadSummary: p.payloadSummary,
    },
    "HF-CORTEX called",
  );
});

eventBus.on("PRODUCT_ROWS_SET", (p) => {
  logger.info(
    {
      ctx: CTX,
      event: "PRODUCT_ROWS_SET",
      leadId: p.leadId,
      rowsCount: p.rowsCount,
    },
    "Product rows set",
  );
});

eventBus.on("CRM_SAFE_UPDATE_DONE", (p) => {
  logger.info(
    {
      ctx: CTX,
      event: "CRM_SAFE_UPDATE_DONE",
      portal: p.portal,
      dialogId: p.dialogId,
      leadId: p.leadId,
      stage: p.stage,
    },
    "safeUpdateLeadAndContact completed",
  );
});

eventBus.on("BOT_REPLY", (p) => {
  logger.info(
    {
      ctx: CTX,
      event: "BOT_REPLY",
      portal: p.portal,
      dialogId: p.dialogId,
      backend: p.backend,
    },
    `BOT_REPLY: "${p.text}"`,
  );
});
