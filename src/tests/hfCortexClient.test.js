import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { callCortexLeadSales } from "../core/hfCortexClient.js";

function withEnv(nextEnv, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(nextEnv)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

test("hfCortexClient: returns null when cortex is disabled", async () => {
  await withEnv(
    {
      HF_CORTEX_ENABLED: "false",
      HF_CORTEX_URL: "http://example.invalid/cortex",
    },
    async () => {
      const data = await callCortexLeadSales({ msg: { dialogId: "chat-1" } });
      assert.equal(data, null);
    },
  );
});

test("hfCortexClient: successful call sends auth headers and parses response", async () => {
  await withEnv(
    {
      HF_CORTEX_ENABLED: "true",
      HF_CORTEX_URL: "http://cortex.local/lead-sales",
      HF_CORTEX_TIMEOUT_MS: "5000",
      HF_CORTEX_API_KEY: "secret-key",
      HF_CORTEX_DUMP: "0",
    },
    async () => {
      const originalFetch = global.fetch;
      const calls = [];
      global.fetch = async (url, options) => {
        calls.push({ url, options });
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              ok: true,
              flow: "lead_sales",
              stage: "CONTACT",
            }),
        };
      };

      try {
        const payload = { msg: { dialogId: "chat-2" } };
        const data = await callCortexLeadSales(payload);
        assert.equal(data?.ok, true);
        assert.equal(data?.stage, "CONTACT");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "http://cortex.local/lead-sales");
        assert.equal(calls[0].options?.method, "POST");
        assert.equal(
          calls[0].options?.headers?.["X-HF-CORTEX-TOKEN"],
          "secret-key",
        );
        assert.equal(
          calls[0].options?.headers?.Authorization,
          "Bearer secret-key",
        );
      } finally {
        global.fetch = originalFetch;
      }
    },
  );
});

test("hfCortexClient: returns null on non-OK HTTP status", async () => {
  await withEnv(
    {
      HF_CORTEX_ENABLED: "true",
      HF_CORTEX_URL: "http://cortex.local/http-error",
      HF_CORTEX_DUMP: "0",
    },
    async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: async () => "temporary error",
      });

      try {
        const data = await callCortexLeadSales({ msg: { dialogId: "chat-3" } });
        assert.equal(data, null);
      } finally {
        global.fetch = originalFetch;
      }
    },
  );
});

test("hfCortexClient: returns null when response JSON is invalid", async () => {
  await withEnv(
    {
      HF_CORTEX_ENABLED: "true",
      HF_CORTEX_URL: "http://cortex.local/bad-json",
      HF_CORTEX_DUMP: "0",
    },
    async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "{this-is-not-json",
      });

      try {
        const data = await callCortexLeadSales({ msg: { dialogId: "chat-4" } });
        assert.equal(data, null);
      } finally {
        global.fetch = originalFetch;
      }
    },
  );
});

test("hfCortexClient: writes request/response dumps when enabled", async () => {
  const dumpDir = path.resolve(
    process.cwd(),
    `data/cortex-test-${process.pid}-${Date.now()}`,
  );

  await withEnv(
    {
      HF_CORTEX_ENABLED: "true",
      HF_CORTEX_URL: "http://cortex.local/dump",
      HF_CORTEX_DUMP: "1",
      HF_CORTEX_DUMP_DIR: dumpDir,
    },
    async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ ok: true, flow: "lead_sales" }),
      });

      try {
        const data = await callCortexLeadSales({
          msg: { dialogId: "chat-dump-1" },
        });
        assert.equal(data?.ok, true);

        const files = fs.readdirSync(dumpDir);
        assert.ok(files.some((f) => f.endsWith("__request.json")));
        assert.ok(files.some((f) => f.endsWith("__response.json")));
      } finally {
        global.fetch = originalFetch;
        fs.rmSync(dumpDir, { recursive: true, force: true });
      }
    },
  );
});
