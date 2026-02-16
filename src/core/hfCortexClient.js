// src/core/hfCortexClient.js
// HTTP-клиент для HF-CORTEX (flow lead_sales)
// В Node 18+ fetch и AbortController доступны глобально, без node-fetch.

import fs from "node:fs/promises";
import path from "node:path";

function makeDumpId(payload) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  const dialogId =
    payload?.msg?.dialogId ||
    payload?.sessionSnapshot?.dialogId ||
    payload?.context?.dialogId ||
    payload?.leadId;

  const safeDialog = dialogId
    ? String(dialogId).replace(/[^\w-]+/g, "_").slice(0, 64)
    : "nochat";

  const rand = Math.random().toString(16).slice(2, 8);
  return `${ts}__${safeDialog}__${rand}`;
}

async function dumpCortexToFile(dumpId, kind, obj) {
  if (process.env.HF_CORTEX_DUMP !== "1") return;

  const dir = process.env.HF_CORTEX_DUMP_DIR || "./data/cortex";
  await fs.mkdir(dir, { recursive: true });

  const filename = `${dumpId}__${kind}.json`;
  await fs.writeFile(
    path.join(dir, filename),
    JSON.stringify(obj, null, 2),
    "utf-8",
  );
}

export async function callCortexLeadSales(payload, logger) {
  const {
    HF_CORTEX_ENABLED,
    HF_CORTEX_URL,
    HF_CORTEX_TIMEOUT_MS,
    HF_CORTEX_API_KEY,
  } = process.env;

  // Если Cortex выключен — сразу выходим
  if (HF_CORTEX_ENABLED !== "true") {
    return null;
  }

  if (!HF_CORTEX_URL) {
    logger?.error({ HF_CORTEX_URL }, "[HF-CORTEX] HF_CORTEX_URL is not set");
    return null;
  }

  const timeoutMs = Number(HF_CORTEX_TIMEOUT_MS || 20000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    logger?.debug(
      {
        url: HF_CORTEX_URL,
        timeoutMs,
      },
      "[HF-CORTEX] sending request",
    );

    const requestBody = {
      app: "hf-rozatti-py",
      flow: "lead_sales",
      payload, // текст клиента + снимок сессии/контекста
    };

    const dumpId = makeDumpId(payload);
    await dumpCortexToFile(dumpId, "request", requestBody);

    const res = await fetch(HF_CORTEX_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(HF_CORTEX_API_KEY
          ? {
              // Единый режим авторизации Node → HF-CORTEX (рекомендуемый)
              "X-HF-CORTEX-TOKEN": HF_CORTEX_API_KEY,
              // Совместимость со старым режимом
              Authorization: `Bearer ${HF_CORTEX_API_KEY}`,
            }
          : {}),
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => undefined);

      await dumpCortexToFile(dumpId, "response_http_error", {
        ok: false,
        status: res.status,
        statusText: res.statusText,
        text,
      });

      const err = new Error(`[HF-CORTEX] HTTP ${res.status} ${res.statusText}`);
      logger?.error(
        { status: res.status, statusText: res.statusText, text },
        "[HF-CORTEX] bad status",
      );
      throw err;
    }

    const rawText = await res.text().catch(() => "");
    let data;

    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch (e) {
      const err = new Error("[HF-CORTEX] invalid JSON in response");
      err.cause = e;

      logger?.error({ err, rawText }, "[HF-CORTEX] invalid JSON in response");
      await dumpCortexToFile(dumpId, "response_invalid_json", {
        ok: false,
        status: res.status,
        statusText: res.statusText,
        rawText,
      });

      throw err;
    }

    await dumpCortexToFile(dumpId, "response", data);

    logger?.debug(
      { ok: data?.ok, flow: data?.flow, stage: data?.stage },
      "[HF-CORTEX] response parsed",
    );

    return data; // CortexResponse
  } catch (err) {
    logger?.error({ err }, "[HF-CORTEX] call error");
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
