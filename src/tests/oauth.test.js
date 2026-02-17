import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { refreshTokens } from "../core/oauth.js";
import { getPortal, upsertPortal } from "../core/store.js";

const TOKENS_FILE = "./data/portals.oauth.test.json";

const STORE_PATH = path.resolve(process.cwd(), TOKENS_FILE);
const STORE_DIR = path.dirname(STORE_PATH);

function backupStoreFile() {
  const exists = fs.existsSync(STORE_PATH);
  const content = exists ? fs.readFileSync(STORE_PATH, "utf8") : null;
  return { exists, content };
}

function restoreStoreFile(backup) {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
  if (backup.exists) {
    fs.writeFileSync(STORE_PATH, backup.content ?? "{}", "utf8");
  } else if (fs.existsSync(STORE_PATH)) {
    fs.rmSync(STORE_PATH, { force: true });
  }
}

function clearStore() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, "{}", "utf8");
}

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

function withStoreEnv(fn) {
  return withEnv({ TOKENS_FILE }, fn);
}

test("oauth: throws when portal has no refresh token", async () => {
  const backup = backupStoreFile();
  try {
    await withStoreEnv(async () => {
      clearStore();
      const domain = "oauth-no-refresh.bitrix24.ru";
      upsertPortal(domain, {
        domain,
        baseUrl: "https://example.bitrix24.ru/rest/",
        accessToken: "old-access",
      });

      await assert.rejects(
        () => refreshTokens(domain),
        /No refresh_token saved for domain/,
      );
    });
  } finally {
    restoreStoreFile(backup);
  }
});

test("oauth: throws when BITRIX client credentials are missing", async () => {
  const backup = backupStoreFile();
  try {
    await withStoreEnv(async () => {
      clearStore();
      const domain = "oauth-missing-creds.bitrix24.ru";
      upsertPortal(domain, {
        domain,
        baseUrl: "https://example.bitrix24.ru/rest/",
        accessToken: "old-access",
        refreshToken: "old-refresh",
      });

      await withEnv(
        {
          BITRIX_CLIENT_ID: undefined,
          BITRIX_CLIENT_SECRET: undefined,
        },
        async () => {
          await assert.rejects(
            () => refreshTokens(domain),
            /BITRIX_CLIENT_ID \/ BITRIX_CLIENT_SECRET are required/,
          );
        },
      );
    });
  } finally {
    restoreStoreFile(backup);
  }
});

test("oauth: refreshes token and updates portal store", async () => {
  const backup = backupStoreFile();
  const originalFetch = global.fetch;
  try {
    await withStoreEnv(async () => {
      clearStore();
      const domain = "oauth-success.bitrix24.ru";
      upsertPortal(domain, {
        domain,
        baseUrl: "https://old-endpoint.bitrix24.ru/rest/",
        accessToken: "old-access",
        refreshToken: "old-refresh",
      });

      global.fetch = async () => ({
        ok: true,
        json: async () => ({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 1200,
          client_endpoint: "https://new-endpoint.bitrix24.ru/rest/",
        }),
      });

      await withEnv(
        {
          BITRIX_CLIENT_ID: "client-id",
          BITRIX_CLIENT_SECRET: "client-secret",
          BITRIX_OAUTH_URL: "https://oauth.bitrix.info/oauth/token/",
        },
        async () => {
          const token = await refreshTokens(domain);
          assert.equal(token, "new-access");

          const portal = getPortal(domain);
          assert.equal(portal.accessToken, "new-access");
          assert.equal(portal.refreshToken, "new-refresh");
          assert.equal(portal.baseUrl, "https://new-endpoint.bitrix24.ru/rest/");
          assert.ok(Number(portal.expiresAt) > Date.now());
        },
      );
    });
  } finally {
    global.fetch = originalFetch;
    restoreStoreFile(backup);
  }
});

test("oauth: concurrent refresh for same domain performs single fetch", async () => {
  const backup = backupStoreFile();
  const originalFetch = global.fetch;
  try {
    await withStoreEnv(async () => {
      clearStore();
      const domain = "oauth-concurrent.bitrix24.ru";
      upsertPortal(domain, {
        domain,
        baseUrl: "https://old-endpoint.bitrix24.ru/rest/",
        accessToken: "old-access",
        refreshToken: "old-refresh",
      });

      let fetchCalls = 0;
      global.fetch = async () => {
        fetchCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          ok: true,
          json: async () => ({
            access_token: "new-access-2",
            refresh_token: "new-refresh-2",
            expires_in: 3600,
            client_endpoint: "https://new-endpoint-2.bitrix24.ru/rest/",
          }),
        };
      };

      await withEnv(
        {
          BITRIX_CLIENT_ID: "client-id",
          BITRIX_CLIENT_SECRET: "client-secret",
        },
        async () => {
          const [t1, t2] = await Promise.all([
            refreshTokens(domain),
            refreshTokens(domain),
          ]);
          assert.equal(t1, "new-access-2");
          assert.equal(t2, "new-access-2");
          assert.equal(fetchCalls, 1);
        },
      );
    });
  } finally {
    global.fetch = originalFetch;
    restoreStoreFile(backup);
  }
});

test("oauth: throws bitrix error message when refresh fails", async () => {
  const backup = backupStoreFile();
  const originalFetch = global.fetch;
  try {
    await withStoreEnv(async () => {
      clearStore();
      const domain = "oauth-fail.bitrix24.ru";
      upsertPortal(domain, {
        domain,
        baseUrl: "https://old-endpoint.bitrix24.ru/rest/",
        accessToken: "old-access",
        refreshToken: "old-refresh",
      });

      global.fetch = async () => ({
        ok: false,
        json: async () => ({
          error: "invalid_grant",
          error_description: "refresh token expired",
        }),
      });

      await withEnv(
        {
          BITRIX_CLIENT_ID: "client-id",
          BITRIX_CLIENT_SECRET: "client-secret",
        },
        async () => {
          await assert.rejects(
            () => refreshTokens(domain),
            /refresh token expired/,
          );
        },
      );
    });
  } finally {
    global.fetch = originalFetch;
    restoreStoreFile(backup);
  }
});
