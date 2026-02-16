import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { upsertPortal } from "../core/store.js";
import { processIncomingBitrixMessage } from "../modules/bot/handler/index.js";
import { getSession, saveSession } from "../modules/bot/sessionStore.js";

function makeBody({ domain, dialogId, chatId, messageId, message }) {
  return {
    event: "onimbotmessageadd",
    data: {
      AUTH: { domain },
      PARAMS: {
        DIALOG_ID: dialogId,
        CHAT_ID: chatId,
        MESSAGE_ID: String(messageId),
        MESSAGE: message,
      },
    },
  };
}

async function startFakeBitrixWithFirstDelay(delayMs = 250) {
  let reqCount = 0;
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", async () => {
      reqCount += 1;

      if (reqCount === 1 && delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }

      const methodMatch = String(req.url || "").match(/\/rest\/(.+)\.json/);
      const method = methodMatch ? methodMatch[1] : "unknown";

      let payload = { result: true };
      if (method === "crm.lead.get") {
        payload = { result: { ID: 5001, STATUS_ID: "NEW" } };
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}/rest`;

  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startFakeBitrixWithFixedDelay(delayMs = 180) {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", async () => {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }

      const methodMatch = String(req.url || "").match(/\/rest\/(.+)\.json/);
      const method = methodMatch ? methodMatch[1] : "unknown";
      const payload =
        method === "crm.lead.get" ? { result: { ID: 5001, STATUS_ID: "NEW" } } : { result: true };

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}/rest`;

  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("handler lock: serializes concurrent messages per dialog", async () => {
  const fake = await startFakeBitrixWithFirstDelay(250);
  const domain = "audit-lock.bitrix24.ru";
  const dialogId = "chat4001";
  const chatId = "4001";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-lock",
    refreshToken: "refresh-lock",
  });

  saveSession(domain, dialogId, {
    dialogId,
    leadId: 5001,
    state: { stage: "NEW", offers: [] },
    lastProcessedMessageId: 399,
    mode: "auto",
    manualAckSent: false,
    oem_candidates: [],
    lastSeenLeadOem: null,
  });

  const doneOrder = [];

  const p1 = processIncomingBitrixMessage({
    domain,
    portal: { domain, baseUrl: fake.baseUrl, accessToken: "token-lock" },
    body: makeBody({
      domain,
      dialogId,
      chatId,
      messageId: 400,
      message: "",
    }),
  }).then(() => doneOrder.push("p1"));

  // Стартуем второй обработчик почти сразу, пока первый ещё в работе.
  await new Promise((r) => setTimeout(r, 10));

  const p2 = processIncomingBitrixMessage({
    domain,
    portal: { domain, baseUrl: fake.baseUrl, accessToken: "token-lock" },
    body: makeBody({
      domain,
      dialogId,
      chatId,
      messageId: 401,
      message: "",
    }),
  }).then(() => doneOrder.push("p2"));

  try {
    await Promise.all([p1, p2]);

    assert.deepEqual(doneOrder, ["p1", "p2"]);

    const session = getSession(domain, dialogId);
    assert.ok(session);
    assert.equal(session.lastProcessedMessageId, 401);
  } finally {
    await fake.close();
  }
});

test("handler lock: different dialogs are processed in parallel", async () => {
  const fake = await startFakeBitrixWithFixedDelay(180);
  const domain = "audit-lock-parallel.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-lock-parallel",
    refreshToken: "refresh-lock-parallel",
  });

  saveSession(domain, "chat4101", {
    dialogId: "chat4101",
    leadId: 5101,
    state: { stage: "NEW", offers: [] },
    lastProcessedMessageId: 0,
    mode: "auto",
    manualAckSent: false,
    oem_candidates: [],
    lastSeenLeadOem: null,
  });

  saveSession(domain, "chat4102", {
    dialogId: "chat4102",
    leadId: 5102,
    state: { stage: "NEW", offers: [] },
    lastProcessedMessageId: 0,
    mode: "auto",
    manualAckSent: false,
    oem_candidates: [],
    lastSeenLeadOem: null,
  });

  const t0 = Date.now();

  const p1 = processIncomingBitrixMessage({
    domain,
    portal: { domain, baseUrl: fake.baseUrl, accessToken: "token-lock-parallel" },
    body: makeBody({
      domain,
      dialogId: "chat4101",
      chatId: "4101",
      messageId: 1,
      message: "",
    }),
  });

  const p2 = processIncomingBitrixMessage({
    domain,
    portal: { domain, baseUrl: fake.baseUrl, accessToken: "token-lock-parallel" },
    body: makeBody({
      domain,
      dialogId: "chat4102",
      chatId: "4102",
      messageId: 1,
      message: "",
    }),
  });

  try {
    await Promise.all([p1, p2]);
    const elapsed = Date.now() - t0;

    // При global-lock было бы заметно дольше (~2x).
    assert.equal(elapsed < 650, true);

    const s1 = getSession(domain, "chat4101");
    const s2 = getSession(domain, "chat4102");
    assert.equal(s1?.lastProcessedMessageId, 1);
    assert.equal(s2?.lastProcessedMessageId, 1);
  } finally {
    await fake.close();
  }
});
