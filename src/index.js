import "./core/env.js";
import { buildServer } from "./core/app.js";
import { createGracefulShutdown } from "./core/gracefulShutdown.js";
import { logger } from "./core/logger.js";

const start = async () => {
  const app = await buildServer();
  const port = Number(process.env.PORT || 8080);
  const graceful = createGracefulShutdown({ app, logger });
  graceful.install();

  try {
    await app.listen({ port, host: "0.0.0.0" });
    logger.info({ port }, "Server started");
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
