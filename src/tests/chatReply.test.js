import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { shouldSendChatReply, sendChatReplyIfAllowed } from "../modules/bot/handler/shared/chatReply.js";

function startFakeBitrix(statusId) {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const methodMatch = String(req.url || "").match(/\/rest\/(.+)\.json/);
      const method = methodMatch ? methodMatch[1] : "unknown";

      let payload = { result: true };
      if (method === "profile") {
        payload = { result: { ID: "1", NAME: "Bot", LAST_NAME: "User", EMAIL: "bot@example.test" } };
      } else if (method === "crm.lead.get") {
        payload = { result: { ID: 1001, STATUS_ID: statusId } };
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/rest`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("chatReply.shouldSendChatReply: allows when leadId is missing", async () => {
  const decision = await shouldSendChatReply({
    portalDomain: "audit-chat-no-lead.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
    leadId: null,
    manualStatuses: ["UC_ZA04R1"],
  });

  assert.deepEqual(decision, { canSend: true, reason: "no_leadId" });
});

test("chatReply.shouldSendChatReply: allows when manualStatuses is empty", async () => {
  const decision = await shouldSendChatReply({
    portalDomain: "audit-chat-no-manuals.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
    leadId: 1001,
    manualStatuses: [],
  });

  assert.deepEqual(decision, { canSend: true, reason: "no_manualStatuses" });
});

test("chatReply.shouldSendChatReply: blocks send for manual status", async () => {
  const fake = await startFakeBitrix("UC_ZA04R1");

  try {
    const decision = await shouldSendChatReply({
      portalDomain: "audit-chat-manual.bitrix24.ru",
      portalCfg: { baseUrl: fake.baseUrl, accessToken: "token" },
      leadId: 1001,
      manualStatuses: ["UC_ZA04R1", "UC_UAO7E9"],
    });

    assert.equal(decision.canSend, false);
    assert.equal(decision.reason, "manual_status:UC_ZA04R1");
    assert.equal(decision.statusId, "UC_ZA04R1");
  } finally {
    await fake.close();
  }
});

test("chatReply.shouldSendChatReply: allows for non-manual status", async () => {
  const fake = await startFakeBitrix("PROCESSED");

  try {
    const decision = await shouldSendChatReply({
      portalDomain: "audit-chat-auto.bitrix24.ru",
      portalCfg: { baseUrl: fake.baseUrl, accessToken: "token" },
      leadId: 1001,
      manualStatuses: ["UC_ZA04R1", "UC_UAO7E9"],
    });

    assert.equal(decision.canSend, true);
    assert.equal(decision.reason, "status:PROCESSED");
    assert.equal(decision.statusId, "PROCESSED");
  } finally {
    await fake.close();
  }
});

test("chatReply.shouldSendChatReply: returns lead_get_failed when lead read throws", async () => {
  const decision = await shouldSendChatReply({
    portalDomain: "audit-chat-failed.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:1/rest", accessToken: "token" },
    leadId: 1001,
    manualStatuses: ["UC_ZA04R1"],
  });

  assert.deepEqual(decision, { canSend: true, reason: "lead_get_failed" });
});

test("chatReply.sendChatReplyIfAllowed: sends message for non-manual status", async () => {
  const fake = await startFakeBitrix("PROCESSED");
  const calls = [];
  const api = {
    async call(method, params) {
      calls.push({ method, params });
      return { result: true };
    },
  };

  try {
    const sent = await sendChatReplyIfAllowed({
      api,
      portalDomain: "audit-chat-send-ok.bitrix24.ru",
      portalCfg: { baseUrl: fake.baseUrl, accessToken: "token" },
      dialogId: "chat9001",
      leadId: 1001,
      message: "",
    });

    assert.equal(sent, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "imbot.message.add");
    assert.deepEqual(calls[0].params, {
      DIALOG_ID: "chat9001",
      MESSAGE: "…",
    });
  } finally {
    await fake.close();
  }
});

test("chatReply.sendChatReplyIfAllowed: does not send message for manual status", async () => {
  const fake = await startFakeBitrix("UC_UAO7E9");
  let sendCalled = false;
  const api = {
    async call() {
      sendCalled = true;
    },
  };

  try {
    const sent = await sendChatReplyIfAllowed({
      api,
      portalDomain: "audit-chat-send-block.bitrix24.ru",
      portalCfg: { baseUrl: fake.baseUrl, accessToken: "token" },
      dialogId: "chat9002",
      leadId: 1001,
      message: "hello",
    });

    assert.equal(sent, false);
    assert.equal(sendCalled, false);
  } finally {
    await fake.close();
  }
});

