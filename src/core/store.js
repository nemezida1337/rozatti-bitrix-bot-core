import fs from "fs";
import path from "path";

import { logger } from "./logger.js";

const tokensFile = process.env.TOKENS_FILE || "./data/portals.json";
const filePath = path.resolve(process.cwd(), tokensFile);

export function loadStore() {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    logger.error({ e }, "Failed to load token store");
    return {};
  }
}

export function saveStore(obj) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    logger.error({ e }, "Failed to save token store");
  }
}

export function upsertPortal(domain, data) {
  const store = loadStore();
  store[domain] = { ...(store[domain] || {}), ...data, updatedAt: new Date().toISOString() };
  saveStore(store);
  return store[domain];
}

export function getPortal(domain) {
  const store = loadStore();
  return store[domain];
}
