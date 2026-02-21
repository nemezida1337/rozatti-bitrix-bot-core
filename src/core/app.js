// @ts-check

import Fastify from "fastify";
import fastifyRawBody from "fastify-raw-body";

import { registerRoutes } from "../http/routes/bitrix.js";

import { logger } from "./logger.js";

/** @typedef {Record<string, any>} AnyObject */

/** @returns {Promise<import("fastify").FastifyInstance>} */
export async function buildServer() {
  const app = Fastify({ logger: false });

  await app.register(fastifyRawBody, { field: "rawBody", global: false, encoding: "utf8" });

  // Поддержка application/x-www-form-urlencoded (как шлёт Bitrix для ONAPPINSTALL и др.)
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (req, body, done) => {
    try {
      const rawBody = typeof body === "string" ? body : String(body ?? "");
      const params = new URLSearchParams(rawBody);
      const blockedPathKeys = new Set(["__proto__", "prototype", "constructor"]);
      /** @type {AnyObject} */
      const out = {};
      // Преобразуем php-style ключи вида a[b][c] -> out.a.b.c
      for (const [k, v] of params) {
        const keys = k
          .replace(/\]/g, "")
          .split("[")
          .map((x) => String(x || "").trim())
          .filter(Boolean); // "auth[access_token]" -> ["auth","access_token"]
        if (!keys.length) continue;
        if (keys.some((key) => blockedPathKeys.has(key))) continue;

        /** @type {AnyObject} */
        let cur = out;
        for (let i = 0; i < keys.length - 1; i++) {
          const key = keys[i];
          const hasOwn = Object.prototype.hasOwnProperty.call(cur, key);
          if (!hasOwn || typeof cur[key] !== "object" || cur[key] === null || Array.isArray(cur[key])) {
            cur[key] = {};
          }
          cur = /** @type {AnyObject} */ (cur[key]);
        }
        const leafKey = keys[keys.length - 1];
        if (blockedPathKeys.has(leafKey)) continue;
        cur[leafKey] = v;
      }
      done(null, out);
    } catch (e) {
      done(e);
    }
  });

  app.get("/healthz", async () => ({ ok: true }));
  await registerRoutes(app);

  app.setErrorHandler((err, req, reply) => {
    logger.error({ err, url: req.url }, "Unhandled error");
    reply.code(500).send({ error: "internal" });
  });

  return app;
}
