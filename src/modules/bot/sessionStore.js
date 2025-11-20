// src/modules/bot/sessionStore.js
// Простое in-memory хранилище сессий бота по dialogId

const sessions = new Map();

/**
 * Получить (или создать) сессию по ключу dialogId.
 */
export function getSession(sessionKey) {
  let s = sessions.get(sessionKey);
  if (!s) {
    s = {
      history: [],
      name: null,
      phone: null,
      contactPromptSent: false,
      contactConfirmed: false,
      leadCreated: false,
      leadId: null,
      stage: "NEW",
      selectedItems: [], // выбор позиций ABCP (для product rows)
    };
    sessions.set(sessionKey, s);
  }
  return s;
}

/**
 * (опционально) очистить одну сессию — может пригодиться для дебага
 */
export function resetSession(sessionKey) {
  sessions.delete(sessionKey);
}

/**
 * (опционально) полностью очистить все сессии
 */
export function resetAllSessions() {
  sessions.clear();
}
