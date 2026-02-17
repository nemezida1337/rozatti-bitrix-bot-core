import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeBitrixClient } from "../core/bitrixClient.js";
import { upsertPortal } from "../core/store.js";

const TOKENS_FILE = "./data/portals.bitrixClient.test.json";
process.env.TOKENS_FILE = TOKENS_FILE;
const STORE_PATH = path.resolve(process.cwd(), TOKENS_FILE);

const originalFetch = globalThis.fetch;
const originalEnv = {
  BITRIX_CLIENT_ID: process.env.BITRIX_CLIENT_ID,
  BITRIX_CLIENT_SECRET: process.env.BITRIX_CLIENT_SECRET,
  BITRIX_OAUTH_URL: process.env.BITRIX_OAUTH_URL,
};

function resetStore() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, "{}", "utf8");
}

function restoreEnv() {
  if (originalEnv.BITRIX_CLIENT_ID === undefined) delete process.env.BITRIX_CLIENT_ID;
  else process.env.BITRIX_CLIENT_ID = originalEnv.BITRIX_CLIENT_ID;

  if (originalEnv.BITRIX_CLIENT_SECRET === undefined) delete process.env.BITRIX_CLIENT_SECRET;
  else process.env.BITRIX_CLIENT_SECRET = originalEnv.BITRIX_CLIENT_SECRET;

  if (originalEnv.BITRIX_OAUTH_URL === undefined) delete process.env.BITRIX_OAUTH_URL;
  else process.env.BITRIX_OAUTH_URL = originalEnv.BITRIX_OAUTH_URL;
}

test.beforeEach(() => {
  resetStore();
  globalThis.fetch = originalFetch;
  restoreEnv();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

test("bitrixClient: requires domain", () => {
  assert.throws(() => makeBitrixClient({ baseUrl: "https://example.test/rest" }), /domain is required/);
});

test("bitrixClient: retries TOO_MANY_REQUESTS and then succeeds", async () => {
  const domain = "bitrix-client-retry.bitrix24.ru";
  upsertPortal(domain, {
    domain,
    baseUrl: "https://example.test/rest",
    accessToken: "token-1",
    refreshToken: "refresh-1",
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { error: "TOO_MANY_REQUESTS" };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { result: { ok: true } };
      },
    };
  };

  const client = makeBitrixClient({ domain, baseUrl: "https://example.test/rest", accessToken: "token-1" });
  const result = await client.call("profile");
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
});

test("bitrixClient: refreshes token on expired_token and retries request", async () => {
  const domain = "bitrix-client-refresh.bitrix24.ru";
  upsertPortal(domain, {
    domain,
    baseUrl: "https://example.test/rest",
    accessToken: "old-token",
    refreshToken: "refresh-1",
  });
  process.env.BITRIX_CLIENT_ID = "cid";
  process.env.BITRIX_CLIENT_SECRET = "csecret";
  process.env.BITRIX_OAUTH_URL = "https://oauth.example.test/oauth/token/";

  const seenAuth = [];
  globalThis.fetch = async (url, opts = {}) => {
    const asString = String(url);

    if (asString.startsWith("https://oauth.example.test/oauth/token/")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: "new-token",
            refresh_token: "refresh-2",
            expires_in: 3600,
            client_endpoint: "https://example.test/rest",
          };
        },
      };
    }

    const body = String(opts.body || "");
    seenAuth.push(new URLSearchParams(body).get("auth"));

    if (seenAuth.length === 1) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { error: "expired_token" };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { result: { ok: true } };
      },
    };
  };

  const client = makeBitrixClient({ domain, baseUrl: "https://example.test/rest", accessToken: "old-token" });
  const result = await client.call("profile", { a: 1 });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seenAuth, ["old-token", "new-token"]);
});

test("bitrixClient: throws wrapped error when refresh fails after expired_token", async () => {
  const domain = "bitrix-client-refresh-fail.bitrix24.ru";
  upsertPortal(domain, {
    domain,
    baseUrl: "https://example.test/rest",
    accessToken: "old-token",
    refreshToken: "refresh-1",
  });
  process.env.BITRIX_CLIENT_ID = "cid";
  process.env.BITRIX_CLIENT_SECRET = "csecret";
  process.env.BITRIX_OAUTH_URL = "https://oauth.example.test/oauth/token/";

  globalThis.fetch = async (url) => {
    const asString = String(url);
    if (asString.startsWith("https://oauth.example.test/oauth/token/")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { error: "invalid_grant", error_description: "invalid refresh token" };
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return { error: "expired_token" };
      },
    };
  };

  const client = makeBitrixClient({ domain, baseUrl: "https://example.test/rest", accessToken: "old-token" });
  await assert.rejects(
    () => client.call("profile"),
    (err) =>
      /refresh_token failed: invalid refresh token/.test(String(err?.message)) &&
      err.code === "expired_token",
  );
});

