import fs from "fs";
import path from "path";

import { logger } from "./logger.js";

function getFilePath() {
  const tokensFile = process.env.TOKENS_FILE || "./data/portals.json";
  return path.resolve(process.cwd(), tokensFile);
}

export function loadStore() {
  const filePath = getFilePath();
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    logger.error({ e }, "Failed to load token store");
    return {};
  }
}

export function saveStore(obj) {
  const filePath = getFilePath();
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Атомарная запись: пишем во временный файл и затем делаем rename.
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    const json = JSON.stringify(obj, null, 2);

    fs.writeFileSync(tmpPath, json, "utf8");

    try {
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      // На некоторых системах rename поверх существующего файла может падать.
      // Фоллбек: удаляем старый файл и повторяем rename.
      if (
        e &&
        (e.code === "EEXIST" || e.code === "EPERM" || e.code === "EBUSY")
      ) {
        try {
          fs.rmSync(filePath, { force: true });
          fs.renameSync(tmpPath, filePath);
        } catch (e2) {
          throw e2;
        }
      } else {
        throw e;
      }
    } finally {
      // Если что-то пошло не так — подчистим временный файл.
      if (fs.existsSync(tmpPath)) {
        try {
          fs.rmSync(tmpPath, { force: true });
        } catch {
          // ignore cleanup error
        }
      }
    }
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
