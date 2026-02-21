import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETPLACE_PRICE_SYNC_REPLY,
  isMarketplacePriceSyncNotification,
} from "../modules/bot/handler/shared/serviceNotifications.js";

test("serviceNotifications: detects Farpost stale-price notice in client openline", () => {
  const detected = isMarketplacePriceSyncNotification({
    text:
      "Ваш прайс [URL=https://www.farpost.ru/personal/goods/packet/128350/view?from=tg.good.packetDated]«1 BMW»[/URL] не обновлялся уже 2 недели.",
    chatEntityType: "LINES",
    userFlags: { isConnector: "Y" },
    isSystemLike: false,
    isForwarded: false,
  });

  assert.equal(detected, true);
});

test("serviceNotifications: ignores non-connector author", () => {
  const detected = isMarketplacePriceSyncNotification({
    text: "Ваш прайс не обновлялся уже 2 недели. farpost.ru",
    chatEntityType: "LINES",
    userFlags: { isConnector: "N" },
    isSystemLike: false,
    isForwarded: false,
  });

  assert.equal(detected, false);
});

test("serviceNotifications: ignores regular sales text with oem", () => {
  const detected = isMarketplacePriceSyncNotification({
    text: "Добрый день, нужен A2742001507",
    chatEntityType: "LINES",
    userFlags: { isConnector: "Y" },
    isSystemLike: false,
    isForwarded: false,
  });

  assert.equal(detected, false);
});

test("serviceNotifications: reply text is stable", () => {
  assert.equal(
    MARKETPLACE_PRICE_SYNC_REPLY,
    "Спасибо за уведомление, проверим обновление прайса.",
  );
});
