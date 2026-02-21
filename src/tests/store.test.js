import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { logger } from "../core/logger.js";
import { loadStoreAsync, saveStoreAsync } from "../core/store.js";
import { getPortal, loadStore, saveStore, upsertPortal } from "../core/store.legacy.js";

process.env.TOKENS_FILE = "./data/portals.store.test.json";

const STORE_PATH = path.resolve(process.cwd(), process.env.TOKENS_FILE);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("store: upsertPortal recovers from corrupted portals.json", () => {
  const backup = backupStoreFile();
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, "{broken-json", "utf8");

    const domain = "audit-store-recover.bitrix24.ru";
    upsertPortal(domain, {
      domain,
      baseUrl: "http://localhost/rest/",
      accessToken: "t1",
    });

    const portal = getPortal(domain);
    assert.ok(portal);
    assert.equal(portal.domain, domain);
    assert.equal(portal.accessToken, "t1");

    const store = loadStore();
    assert.equal(typeof store, "object");
    assert.ok(store[domain]);
  } finally {
    restoreStoreFile(backup);
  }
});

test("store: saveStore does not leave temporary files", () => {
  const backup = backupStoreFile();
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    saveStore({
      "audit-store-tmp.bitrix24.ru": {
        accessToken: "token",
      },
    });

    const files = fs.readdirSync(STORE_DIR);
    const tmpPrefix = `${path.basename(STORE_PATH)}.tmp.`;
    const tmpFiles = files.filter((f) => f.startsWith(tmpPrefix));
    assert.deepEqual(tmpFiles, []);

    const json = fs.readFileSync(STORE_PATH, "utf8");
    assert.doesNotThrow(() => JSON.parse(json));
  } finally {
    restoreStoreFile(backup);
  }
});

test("store: saveStore fallback rename path handles EEXIST/EPERM/EBUSY", () => {
  const backup = backupStoreFile();
  const originalRename = fs.renameSync;
  const originalRm = fs.rmSync;

  let renameCalls = 0;
  let removedMainFile = false;

  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, "{}", "utf8");

    fs.renameSync = (...args) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        const err = new Error("busy");
        err.code = "EBUSY";
        throw err;
      }
      return originalRename(...args);
    };

    fs.rmSync = (target, opts) => {
      if (path.resolve(String(target)) === STORE_PATH) removedMainFile = true;
      return originalRm(target, opts);
    };

    saveStore({
      "audit-store-fallback.bitrix24.ru": {
        accessToken: "token-fallback",
      },
    });

    const saved = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    assert.ok(saved["audit-store-fallback.bitrix24.ru"]);
    assert.equal(renameCalls, 2);
    assert.equal(removedMainFile, true);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync = originalRm;
    restoreStoreFile(backup);
  }
});

test("store: saveStore logs error when write fails and cleanup error is ignored", () => {
  const backup = backupStoreFile();
  const originalWrite = fs.writeFileSync;
  const originalRm = fs.rmSync;
  const originalError = logger.error;

  let errorLogged = false;

  try {
    fs.writeFileSync = () => {
      throw new Error("write failed");
    };
    fs.rmSync = () => {
      throw new Error("cleanup failed");
    };
    logger.error = (ctxOrObj, msg) => {
      if (msg === "Failed to save token store") errorLogged = true;
      return originalError(ctxOrObj, msg);
    };

    assert.doesNotThrow(() => {
      saveStore({
        "audit-store-write-fail.bitrix24.ru": {
          accessToken: "token",
        },
      });
    });

    assert.equal(errorLogged, true);
  } finally {
    fs.writeFileSync = originalWrite;
    fs.rmSync = originalRm;
    logger.error = originalError;
    restoreStoreFile(backup);
  }
});

test("store: loadStore normalizes snake_case token fields to camelCase", () => {
  const backup = backupStoreFile();
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify(
        {
          "audit-store-normalize.bitrix24.ru": {
            domain: "audit-store-normalize.bitrix24.ru",
            baseUrl: "https://audit-store-normalize.bitrix24.ru/rest/",
            access_token: "snake-access",
            refresh_token: "snake-refresh",
            member_id: "member-1",
            application_token: "app-1",
            user_id: 42,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const store = loadStore();
    const portal = store["audit-store-normalize.bitrix24.ru"];

    assert.ok(portal);
    assert.equal(portal.accessToken, "snake-access");
    assert.equal(portal.refreshToken, "snake-refresh");
    assert.equal(portal.memberId, "member-1");
    assert.equal(portal.applicationToken, "app-1");
    assert.equal(portal.userId, "42");
    assert.equal("access_token" in portal, false);
    assert.equal("refresh_token" in portal, false);
    assert.equal("member_id" in portal, false);
    assert.equal("application_token" in portal, false);
    assert.equal("user_id" in portal, false);
  } finally {
    restoreStoreFile(backup);
  }
});

test("store: upsertPortal persists canonical camelCase keys", () => {
  const backup = backupStoreFile();
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });

    upsertPortal("audit-store-canonical.bitrix24.ru", {
      baseUrl: "https://audit-store-canonical.bitrix24.ru/rest/",
      access_token: "snake-access",
      refresh_token: "snake-refresh",
      member_id: "member-2",
      application_token: "app-2",
      user_id: 77,
    });

    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    const portal = raw["audit-store-canonical.bitrix24.ru"];

    assert.equal(portal.accessToken, "snake-access");
    assert.equal(portal.refreshToken, "snake-refresh");
    assert.equal(portal.memberId, "member-2");
    assert.equal(portal.applicationToken, "app-2");
    assert.equal(portal.userId, "77");
    assert.equal("access_token" in portal, false);
    assert.equal("refresh_token" in portal, false);
    assert.equal("member_id" in portal, false);
    assert.equal("application_token" in portal, false);
    assert.equal("user_id" in portal, false);
  } finally {
    restoreStoreFile(backup);
  }
});

test("store: loadStoreAsync returns cloned snapshot from cache", async () => {
  const backup = backupStoreFile();
  const prevTtl = process.env.STORE_CACHE_TTL_MS;
  try {
    process.env.STORE_CACHE_TTL_MS = "3000";
    await saveStoreAsync({
      "audit-store-async-cache.bitrix24.ru": {
        domain: "audit-store-async-cache.bitrix24.ru",
        accessToken: "token-original",
      },
    });

    const snapshot1 = await loadStoreAsync();
    snapshot1["audit-store-async-cache.bitrix24.ru"].accessToken = "token-mutated";

    const snapshot2 = await loadStoreAsync();
    assert.equal(snapshot2["audit-store-async-cache.bitrix24.ru"].accessToken, "token-original");
  } finally {
    if (prevTtl == null) delete process.env.STORE_CACHE_TTL_MS;
    else process.env.STORE_CACHE_TTL_MS = prevTtl;
    restoreStoreFile(backup);
  }
});

test("store: loadStoreAsync respects TTL and reloads from disk after expiration", async () => {
  const backup = backupStoreFile();
  const prevTtl = process.env.STORE_CACHE_TTL_MS;
  try {
    process.env.STORE_CACHE_TTL_MS = "20";
    await saveStoreAsync({
      "audit-store-async-ttl.bitrix24.ru": {
        domain: "audit-store-async-ttl.bitrix24.ru",
        accessToken: "token-v1",
      },
    });

    const first = await loadStoreAsync();
    assert.equal(first["audit-store-async-ttl.bitrix24.ru"].accessToken, "token-v1");

    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify(
        {
          "audit-store-async-ttl.bitrix24.ru": {
            domain: "audit-store-async-ttl.bitrix24.ru",
            accessToken: "token-v2",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const cached = await loadStoreAsync();
    assert.equal(cached["audit-store-async-ttl.bitrix24.ru"].accessToken, "token-v1");

    await sleep(35);

    const refreshed = await loadStoreAsync();
    assert.equal(refreshed["audit-store-async-ttl.bitrix24.ru"].accessToken, "token-v2");
  } finally {
    if (prevTtl == null) delete process.env.STORE_CACHE_TTL_MS;
    else process.env.STORE_CACHE_TTL_MS = prevTtl;
    restoreStoreFile(backup);
  }
});

test("store: loadStoreAsync uses single-flight for concurrent reads", async () => {
  const backup = backupStoreFile();
  const prevTtl = process.env.STORE_CACHE_TTL_MS;
  const originalReadFile = fsp.readFile;
  let readCalls = 0;
  try {
    process.env.STORE_CACHE_TTL_MS = "1";
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify(
        {
          "audit-store-async-flight.bitrix24.ru": {
            domain: "audit-store-async-flight.bitrix24.ru",
            accessToken: "token-flight",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await sleep(5);

    fsp.readFile = async (...args) => {
      readCalls += 1;
      await sleep(30);
      return originalReadFile(...args);
    };

    const [first, second] = await Promise.all([loadStoreAsync(), loadStoreAsync()]);
    assert.equal(readCalls, 1);
    assert.equal(first["audit-store-async-flight.bitrix24.ru"].accessToken, "token-flight");
    assert.equal(second["audit-store-async-flight.bitrix24.ru"].accessToken, "token-flight");
  } finally {
    fsp.readFile = originalReadFile;
    if (prevTtl == null) delete process.env.STORE_CACHE_TTL_MS;
    else process.env.STORE_CACHE_TTL_MS = prevTtl;
    restoreStoreFile(backup);
  }
});

test("store: saveStoreAsync updates cache for immediate read", async () => {
  const backup = backupStoreFile();
  const prevTtl = process.env.STORE_CACHE_TTL_MS;
  const originalReadFile = fsp.readFile;
  try {
    process.env.STORE_CACHE_TTL_MS = "3000";
    await saveStoreAsync({
      "audit-store-async-save.bitrix24.ru": {
        domain: "audit-store-async-save.bitrix24.ru",
        accessToken: "token-save",
      },
    });

    fsp.readFile = async () => {
      throw new Error("readFile must not be called");
    };

    const store = await loadStoreAsync();
    assert.equal(store["audit-store-async-save.bitrix24.ru"].accessToken, "token-save");
  } finally {
    fsp.readFile = originalReadFile;
    if (prevTtl == null) delete process.env.STORE_CACHE_TTL_MS;
    else process.env.STORE_CACHE_TTL_MS = prevTtl;
    restoreStoreFile(backup);
  }
});
