import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { getPortal, loadStore, saveStore, upsertPortal } from "../core/store.js";

const STORE_PATH = path.resolve(process.cwd(), "data", "portals.json");
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
    const tmpFiles = files.filter((f) => f.startsWith("portals.json.tmp."));
    assert.deepEqual(tmpFiles, []);

    const json = fs.readFileSync(STORE_PATH, "utf8");
    assert.doesNotThrow(() => JSON.parse(json));
  } finally {
    restoreStoreFile(backup);
  }
});

