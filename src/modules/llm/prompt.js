/**
 * Конфиг промптов: читаем из prompts/*.md, при наличии переменных окружения
 * LLM_SYSTEM_BASE_PATH / LLM_ABCP_REWRITE_PATH — берём оттуда.
 * Если файлов нет — используем дефолт.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.resolve(__dirname, "../../../prompts");

function readTextSafe(p) {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

function getByEnvPath(varName) {
  const p = process.env[varName];
  if (p && existsSync(p)) return readTextSafe(p);
  return "";
}

function getPrompt(name, fallback, envPathVar) {
  // 1) путь из .env (например LLM_SYSTEM_BASE_PATH)
  const fromEnvPath = getByEnvPath(envPathVar);
  if (fromEnvPath.trim()) return fromEnvPath.trim();

  // 2) prompts/<name>.md
  const fromFile = readTextSafe(path.join(promptsDir, `${name}.md`));
  if (fromFile.trim()) return fromFile.trim();

  // 3) дефолт
  return (fallback ?? "").trim();
}

// ===== дефолты (используются, если файл/путь не заданы)
const DEFAULT_SYSTEM = [
  "Ты ассистент автозапчастей для Open Lines Bitrix24.",
  "Отвечай кратко, по делу и вежливо, на русском.",
  "Если в сообщении есть OEM — предлагай варианты из предоставленных данных (не выдумывай).",
  "VIN/нестандарт — сообщи, что подключишь оператора и попроси контакт.",
  "Не придумывай цены/сроки — используй только те, что даны в данных."
].join(" ");

const DEFAULT_ABCP_REWRITE = [
  "Сформируй одно короткое сообщение менеджера.",
  "• Скажи, что нашлись позиции по указанным OEM.",
  "• Дай НУМЕРОВАННЫЙ список 1..N: бренд, код/артикул, ориентир. цену и срок.",
  "• Используй только данные из текста (ничего не выдумывай).",
  "• В конце спроси: «Какой номер и сколько штук оформить?»."
].join("\n");

// ===== внешние интерфейсы
export const SYSTEM_PROMPT = getPrompt("system_base", DEFAULT_SYSTEM, "LLM_SYSTEM_BASE_PATH");
export const ABCP_REWRITE_PROMPT = getPrompt("abcp_rewrite", DEFAULT_ABCP_REWRITE, "LLM_ABCP_REWRITE_PATH");

// вспомогательный билдер (по желанию)
export function buildSystem(...parts) {
  return parts.filter(Boolean).map(s => s.trim()).join("\n");
}
