import "./core/env.js";
import { buildServer } from "./core/app.js";
import { logger } from "./core/logger.js";

const start = async () => {
  const app = await buildServer();
  const port = Number(process.env.PORT || 8080);
  try {
    await app.listen({ port, host: "0.0.0.0" });
    logger.info({ port }, "Server started");
  } catch (err) {
    logger.error({ err }, "Server start failed");
    process.exit(1);
  }
};
start();
