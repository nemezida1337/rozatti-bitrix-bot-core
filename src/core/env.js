// @ts-check

// src/core/env.js
// Загрузка .env и удобные константы окружения.

import fs from "fs";
import path from "path";

import dotenv from "dotenv";

// 1) Подхватываем .env (если есть), иначе .env.example
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  const examplePath = path.resolve(process.cwd(), ".env.example");
  if (fs.existsSync(examplePath)) {
    dotenv.config({ path: examplePath });
  } else {
    // fallback: просто dotenv.config() без пути
    dotenv.config();
  }
}

// 2) Удобные экспортируемые константы (на будущее и для логгера/LLM)

export const NODE_ENV = process.env.NODE_ENV || "development";
export const isDev = NODE_ENV !== "production";

export const PORT = Number(process.env.PORT || 8080);

// Уровень логирования: error < warn < info < debug
/** @type {"error"|"warn"|"info"|"debug"|string} */
export const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

// Базовый публичный URL (туннель)
export const BASE_URL = process.env.BASE_URL || null;

// Ключ для LLM (OpenAI и пр.)
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
