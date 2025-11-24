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
   * Подписаться на событие.
   * @param {string} event
   * @param {(payload: any) => void | Promise<void>} handler
   */
  on(event, handler) {
    if (!event || typeof handler !== "function") return;
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event).add(handler);
  }

  /**
   * Отписаться от события.
   * @param {string} event
   * @param {(payload: any) => void | Promise<void>} handler
   */
  off(event, handler) {
    const set = this.handlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      this.handlers.delete(event);
    }
  }

  /**
   * Публикация события.
   * Все подписчики вызываются асинхронно, ошибки не роняют основной поток.
   * @param {string} event
   * @param {any} payload
   */
  async emit(event, payload) {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;

    const ctx = `${CTX}.emit`;

    for (const handler of set) {
      try {
        const res = handler(payload);
        if (res && typeof res.then === "function") {
          await res;
        }
      } catch (err) {
        logger.warn(
          {
            ctx,
            event,
            error: err?.message || String(err),
          },
          "EventBus handler threw",
        );
      }
    }
  }
}

// Синглтон для всего приложения
export const eventBus = new EventBus();

// Базовый логгер событий (можно отключить/переопределить позже)
eventBus.on("USER_MESSAGE", (p) => {
  logger.info(
    {
      ctx: CTX,
      event: "USER_MESSAGE",
      portal: p.portal,
      dialogId: p.dialogId,
    },
    `USER: "${p.text}"`,
  );
});

eventBus.on("LLM_RESPONSE", (p) => {
  logger.debug(
    {
      ctx: CTX,
      event: "LLM_RESPONSE",
      portal: p.portal,
      dialogId: p.dialogId,
      pass: p.pass,
      action: p.llm?.action,
      stage: p.llm?.stage,
    },
    "LLM structured response",
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
    "ABCP lookup complete",
  );
});

eventBus.on("OL_SEND", (p) => {
  logger.info(
    {
      ctx: CTX,
      event: "OL_SEND",
      portal: p.portal,
      dialogId: p.dialogId,
    },
    `BOT: "${p.text}"`,
  );
});

eventBus.on("SESSION_UPDATED", (p) => {
  logger.debug(
    {
      ctx: CTX,
      event: "SESSION_UPDATED",
      portal: p.portal,
      dialogId: p.dialogId,
      stage: p.session?.state?.stage,
    },
    "Session updated",
  );
});

eventBus.on("LEAD_CREATED", (p) => {
  logger.info(
    {
      ctx: CTX,
      event: "LEAD_CREATED",
      leadId: p.leadId,
      dialogId: p.dialogId,
    },
    "Lead created",
  );
});

eventBus.on("LEAD_UPDATED", (p) => {
  logger.debug(
    {
      ctx: CTX,
      event: "LEAD_UPDATED",
      leadId: p.leadId,
      fields: Object.keys(p.fields || {}),
    },
    "Lead updated",
  );
});

eventBus.on("LEAD_COMMENT_APPENDED", (p) => {
  logger.debug(
    {
      ctx: CTX,
      event: "LEAD_COMMENT_APPENDED",
      leadId: p.leadId,
    },
    "Comment appended to lead",
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
