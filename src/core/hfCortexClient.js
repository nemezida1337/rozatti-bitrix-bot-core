// src/core/hfCortexClient.js
// HTTP-клиент для HF-CORTEX (flow lead_sales)
// В Node 18+ fetch и AbortController доступны глобально, без node-fetch.

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
    logger?.error(
      { HF_CORTEX_URL },
      "[HF-CORTEX] HF_CORTEX_URL is not set",
    );
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

    const res = await fetch(HF_CORTEX_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(HF_CORTEX_API_KEY
          ? { Authorization: `Bearer ${HF_CORTEX_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        app: "hf-rozatti-py",
        flow: "lead_sales",
        payload, // текст клиента + снимок сессии/контекста
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => undefined);
      const err = new Error(
        `[HF-CORTEX] HTTP ${res.status} ${res.statusText}`,
      );
      logger?.error(
        { status: res.status, statusText: res.statusText, text },
        "[HF-CORTEX] bad status",
      );
      throw err;
    }

    const data = await res.json().catch((e) => {
      const err = new Error("[HF-CORTEX] invalid JSON in response");
      err.cause = e;
      throw err;
    });

    logger?.debug(
      { ok: data?.ok, flow: data?.flow, stage: data?.stage },
      "[HF-CORTEX] response parsed",
    );

    return data; // CortexResponse
  } catch (err) {
    logger?.error({ err }, "[HF-CORTEX] call error");
    // Возвращаем null, чтобы оркестратор ушёл в fallback на старый LLM-путь
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
