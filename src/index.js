import "./core/env.js";
import { buildServer } from "./core/app.js";
import { createGracefulShutdown } from "./core/gracefulShutdown.js";
import { logger } from "./core/logger.js";
import { loadStoreAsync } from "./core/store.js";
import { ensureBotRegistered } from "./modules/bot/register.js";

async function refreshKnownPortalBots() {
  const store = await loadStoreAsync();
  /**
   * @param {string} domain
   * @param {Record<string, any>} portal
   */
  const shouldRebind = (domain, portal) => {
    const hasToken = Boolean(portal.accessToken || portal.access_token);
    const baseUrlRaw = String(portal.baseUrl || portal.client_endpoint || "").trim();
    if (!hasToken || !baseUrlRaw) return false;

    const d = String(domain || "").toLowerCase();
    if (!d || d.startsWith("audit-")) return false;

    try {
      const u = new URL(baseUrlRaw);
      const host = String(u.hostname || "").toLowerCase();
      if (!host || host === "127.0.0.1" || host === "localhost") return false;
      return true;
    } catch {
      return false;
    }
  };

  const domains = Object.entries(store || {})
    .filter(([domainKey, portal]) => {
      const p = /** @type {Record<string, any>} */ (portal || {});
      const domain = String(p.domain || domainKey || "");
      return shouldRebind(domain, p);
    })
    .map(([domainKey, portal]) => String(portal?.domain || domainKey || ""));

  if (!domains.length) return;

  logger.info({ count: domains.length }, "Startup bot rebind started");
  for (const domain of domains) {
    try {
      await ensureBotRegistered(domain);
    } catch (err) {
      logger.error({ domain, err: String(err) }, "Startup bot rebind failed");
    }
  }
  logger.info({ count: domains.length }, "Startup bot rebind finished");
}

const start = async () => {
  const app = await buildServer();
  const port = Number(process.env.PORT || 8080);
  const graceful = createGracefulShutdown({ app, logger });
  graceful.install();

  try {
    await app.listen({ port, host: "0.0.0.0" });
    logger.info({ port }, "Server started");
    await refreshKnownPortalBots();
  } catch (err) {
    logger.error({ err }, "Server start failed");
    try {
      await graceful.shutdown("startup_error");
    } catch (shutdownErr) {
      logger.error({ err: String(shutdownErr) }, "Startup shutdown failed");
    }
    process.exit(1);
  }
};
start();
