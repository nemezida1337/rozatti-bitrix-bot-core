import Fastify from "fastify";
import fastifyRawBody from "fastify-raw-body";

import { registerRoutes } from "../http/routes/bitrix.js";

import { logger } from "./logger.js";

export async function buildServer() {
  const app = Fastify({ logger: false });

  await app.register(fastifyRawBody, { field: "rawBody", global: false, encoding: "utf8" });

  // Поддержка application/x-www-form-urlencoded (как шлёт Bitrix для ONAPPINSTALL и др.)
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (req, body, done) => {
    try {
      const params = new URLSearchParams(body);
      const out = {};
      // Преобразуем php-style ключи вида a[b][c] -> out.a.b.c
      for (const [k, v] of params) {
        const keys = k.replace(/\]/g, "").split("["); // "auth[access_token]" -> ["auth","access_token"]
        let cur = out;
        for (let i = 0; i < keys.length - 1; i++) {
          const key = keys[i];
          if (!(key in cur)) cur[key] = {};
          cur = cur[key];
        }
        cur[keys[keys.length - 1]] = v;
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
