// src/modules/bot/handler/shared/serviceNotifications.js
//
// Детекторы сервисных уведомлений, которые не должны идти в OEM/Cortex сценарий.

const FARPOST_HOST_RE = /(?:https?:\/\/)?(?:www\.)?farpost\.ru/i;
const PRICE_STALE_RE =
  /(ваш\s+прайс|прайс[^\n]{0,120}не\s+обновлял|не\s+обновлял(?:ся|ось))/i;
const MARKETPLACE_HINT_RE = /(packetdated|tg\.good\.packet|farpost)/i;

export const MARKETPLACE_PRICE_SYNC_REPLY =
  "Спасибо за уведомление, проверим обновление прайса.";

export function isMarketplacePriceSyncNotification({
  text,
  chatEntityType,
  userFlags,
  isSystemLike = false,
  isForwarded = false,
}) {
  const rawText = String(text || "").trim();
  if (!rawText) return false;
  if (isSystemLike || isForwarded) return false;

  const isLines = String(chatEntityType || "").toUpperCase() === "LINES";
  const isConnector = String(userFlags?.isConnector || "").toUpperCase() === "Y";
  if (!(isLines && isConnector)) return false;

  const hasPriceStaleSignal = PRICE_STALE_RE.test(rawText);
  const hasMarketplaceSignal =
    FARPOST_HOST_RE.test(rawText) || MARKETPLACE_HINT_RE.test(rawText);

  return hasPriceStaleSignal && hasMarketplaceSignal;
}

export default {
  isMarketplacePriceSyncNotification,
  MARKETPLACE_PRICE_SYNC_REPLY,
};
