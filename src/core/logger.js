import pino from "pino";
import fs from "fs";
import path from "path";

const logDir = process.env.LOG_DIR || "./logs";
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const filePath = path.join(logDir, `app_${date}.log`);

const transport = pino.transport({
  targets: [
    { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } },
    { target: "pino/file", options: { destination: filePath } }
  ]
});
export const logger = pino({ level: process.env.LOG_LEVEL || "info" }, transport);
