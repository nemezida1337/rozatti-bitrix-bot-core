// src/scripts/buildDialogCases.js
//
// Строит тест-кейсы из дампа dialog_turns.jsonl:
// - high-confidence (для автопрогона)
// - review (на ручной разбор)
//
// Примеры:
//   node src/scripts/buildDialogCases.js
//   node src/scripts/buildDialogCases.js --input-dir data/tmp/bitrix-dialogs/2026-02-20T11-00-00-000Z
//   node src/scripts/buildDialogCases.js --max-per-kind 200

import "../core/env.js";

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { logger } from "../core/logger.js";
import { resolveSmallTalk } from "../modules/bot/handler/shared/smallTalk.js";
import { detectOemsFromText } from "../modules/bot/oemDetector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

const VIN_KEYWORD_REGEX = /(?:^|[^A-ZА-ЯЁ0-9_])(VIN|ВИН)(?=$|[^A-ZА-ЯЁ0-9_])/i;
const VIN_ALLOWED_17_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/i;
const VIN_HAS_LETTER_REGEX = /[A-HJ-NPR-Z]/i;
const VIN_CONTIGUOUS_17_REGEX = /[A-HJ-NPR-Z0-9]{17}/gi;
const VIN_TOKEN_WITH_SEPARATORS_REGEX = /[A-HJ-NPR-Z0-9-]{17,30}/gi;
const VIN_AFTER_KEYWORD_REGEX =
  /(?:^|[^A-ZА-ЯЁ0-9_])(?:VIN|ВИН)\s*[:#]?\s*([A-HJ-NPR-Z0-9][A-HJ-NPR-Z0-9\s-]{14,60})/giu;
const SERVICE_ACK_REGEX =
  /(приветствуем|добро пожаловать|уже работает над запросом|даст ответ|отправил запрос дилеру|передаю менеджеру|передал менеджеру|принял запрос|в работе|взяли в работу|запрос дилеру|передаю в работу)/i;
const NO_STOCK_REGEX =
  /(снят с производства|недоступен|не сможем помочь|нет в наличии|не поставляется|не поставляет|к сожалению.*нет|не найд[её]н|не можем заказать)/i;
const STATUS_QUESTION_REGEX =
  /(статус|где заказ|где мой заказ|номер заказа|заказ\s*[№#]|трек|накладн|когда отправ|когда будет отправк|отслеживат|отслеживан)/i;
const STATUS_REPLY_REGEX =
  /(заказ\s*[№#]|успешно оформлен|обновлени[ея]\s+по\s+статусу|обновление по статусу|передали в доставку|выкуп|трек|накладн|в работе|в обработке|ожидает)/i;
const FOLLOWUP_CLIENT_REGEX =
  /(ну что|что там|есть новости|какие новости|ап\b|up\b|жду ответ|когда ответ|когда будет|напом|подскажите|что по заказу|статус)/i;
const TG_REDIRECT_REGEX = /(ответили вам в телеграм|в телеграм|в whatsapp|в ватсап|в вотсап)/i;

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (!token.startsWith("--")) continue;

    const eq = token.indexOf("=");
    if (eq > 2) {
      const k = token.slice(2, eq);
      const v = token.slice(eq + 1);
      out[k] = v;
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !String(next).startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "1";
    }
  }
  return out;
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

function clip(text, max = 220) {
  const t = String(text || "").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function normalizeForRepeat(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactAlnum(text) {
  return String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function isValidVinCandidate(value) {
  const candidate = compactAlnum(value);
  return (
    candidate.length === 17 &&
    VIN_ALLOWED_17_REGEX.test(candidate) &&
    VIN_HAS_LETTER_REGEX.test(candidate)
  );
}

function hasValidContiguousVin(text) {
  const matches = String(text || "")
    .toUpperCase()
    .match(VIN_CONTIGUOUS_17_REGEX);
  if (!matches || matches.length === 0) return false;
  return matches.some((candidate) => isValidVinCandidate(candidate));
}

function hasValidVinTokenWithSeparators(text) {
  const tokens = String(text || "")
    .toUpperCase()
    .match(VIN_TOKEN_WITH_SEPARATORS_REGEX);
  if (!tokens || tokens.length === 0) return false;

  return tokens.some((token) => isValidVinCandidate(token));
}

function hasValidVinAfterKeyword(text) {
  const upper = String(text || "").toUpperCase();
  const matches = upper.matchAll(VIN_AFTER_KEYWORD_REGEX);
  for (const match of matches) {
    const candidate = compactAlnum(match?.[1] || "");
    if (candidate.length < 17) continue;
    if (isValidVinCandidate(candidate.slice(0, 17))) return true;
  }
  return false;
}

function isServiceAckReply(text) {
  return SERVICE_ACK_REGEX.test(String(text || ""));
}

function isNoStockReply(text) {
  return NO_STOCK_REGEX.test(String(text || ""));
}

function isStatusQuestion(text) {
  return STATUS_QUESTION_REGEX.test(String(text || ""));
}

function isStatusReply(text) {
  return STATUS_REPLY_REGEX.test(String(text || ""));
}

function isFollowupPrompt(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 100) return false;
  return FOLLOWUP_CLIENT_REGEX.test(t);
}

function hasTgRedirect(text) {
  return TG_REDIRECT_REGEX.test(String(text || ""));
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function* readJsonl(filePath) {
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const raw = String(line || "").trim();
    if (!raw) continue;
    try {
      yield JSON.parse(raw);
    } catch {
      // skip broken line
    }
  }
}

async function resolveInputDir(explicitDir = null) {
  if (explicitDir) return path.resolve(process.cwd(), explicitDir);

  const latestTxt = path.join(ROOT, "data", "tmp", "bitrix-dialogs", "LATEST.txt");
  try {
    const raw = await fs.readFile(latestTxt, "utf8");
    const dir = String(raw || "").trim();
    if (dir) return path.resolve(dir);
  } catch {
    // ignore
  }

  const base = path.join(ROOT, "data", "tmp", "bitrix-dialogs");
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (!dirs.length) {
    throw new Error("Не найдено дампов в data/tmp/bitrix-dialogs");
  }
  return path.join(base, dirs[dirs.length - 1]);
}

function classifyManagerReply(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return "UNKNOWN";

  if (isNoStockReply(t)) return "NO_STOCK";
  if (hasTgRedirect(t)) return "TG_REDIRECT";
  if (isStatusReply(t)) return "STATUS";

  if (
    /(переда(ю|ем|л)|передам|передан|менеджер|сложн(ый|ого)?\s+подбор|подбор.*вин|по\s*вин)/i.test(
      t,
    )
  ) {
    return "HANDOVER";
  }
  if (isServiceAckReply(t)) return "SERVICE_ACK";
  if (/(фио|телефон|номер\s*телеф|как\s+к\s+вам\s+обращаться|контакт)/i.test(t)) {
    return "CONTACT";
  }
  if (/(адрес|самовывоз|доставк)/i.test(t)) {
    return "ADDRESS";
  }
  if (/(вариант|цена|стоимост|руб|₽|срок|дн\.|дней|налич|поставка)/i.test(t)) {
    return "PRICING";
  }
  if (/(оформ|созда(м|ю)\s+заказ|заказ\s+оформ)/i.test(t)) {
    return "ORDER";
  }
  return "INFO";
}

function isMediaOnlyClientText(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;

  const hasUrlMarker = /\[\/?URL\]/i.test(raw) || /https?:\/\/\S+/i.test(raw);
  const hasIconMarker = /\[icon=[^\]]+\]/i.test(raw);
  if (!hasUrlMarker && !hasIconMarker) return false;

  const withoutUrls = raw
    .replace(/\[\/?URL\]/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\[icon=[^\]]+\]/gi, " ")
    .replace(/\bsize=\d+\b/gi, " ")
    .replace(/\btitle=[^\]\s]*\b/gi, " ")
    .replace(/[\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Если после удаления URL не осталось букв/цифр — это чистое медиа-сообщение.
  if (!withoutUrls) return true;

  // Разрешаем короткие служебные хвосты вроде "jpg"/"png" без смыслового текста.
  const signalText = withoutUrls
    .replace(/\b(?:jpe?g|png|gif|webp|bmp|heic|mp4|mov|avi|mkv)\b/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  return !signalText;
}

function isVinLikeText(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const upper = t.toUpperCase();

  if (hasValidContiguousVin(upper)) return true;
  if (VIN_KEYWORD_REGEX.test(upper)) {
    if (hasValidVinAfterKeyword(upper)) return true;
    if (hasValidVinTokenWithSeparators(upper)) return true;
  }

  // Если источник уже дал VIN-флаг, но текст не подтверждает VIN-код,
  // не форсируем VIN-кейс, чтобы избежать ложной разметки.
  return false;
}

function isRepeatFollowupByHistory({
  text,
  prevClientTurn,
  prevManagerTurn,
  oemsCount = 0,
  isVinLike = false,
}) {
  if (!isFollowupPrompt(text)) return false;
  if (oemsCount > 0 || isVinLike) return false;
  if (!prevClientTurn?.text) return false;

  const prevClientText = String(prevClientTurn.text || "").trim();
  if (!prevClientText) return false;
  const prevClientNorm = normalizeForRepeat(prevClientText);
  const currNorm = normalizeForRepeat(text);
  const sameAsPrev = !!currNorm && currNorm === prevClientNorm;

  const prevManagerText = String(prevManagerTurn?.text || "").trim();
  const prevManagerHelpful =
    !!prevManagerText &&
    (isServiceAckReply(prevManagerText) ||
      isStatusReply(prevManagerText) ||
      classifyManagerReply(prevManagerText) !== "UNKNOWN");

  const prevSubstantive =
    detectOemsFromText(prevClientText).length > 0 ||
    isVinLikeText(prevClientText) ||
    prevClientText.length >= 18;

  return sameAsPrev || prevManagerHelpful || prevSubstantive;
}

function isContextFollowupCandidate({
  text,
  prevClientTurn,
  oemsCount = 0,
  isVinLike = false,
  managerKind = "UNKNOWN",
}) {
  if (oemsCount > 0 || isVinLike) return false;
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (!prevClientTurn?.text) return false;

  const len = raw.length;
  if (len > 80) return false;

  if (["CONTACT", "ADDRESS", "PRICING", "ORDER", "STATUS"].includes(managerKind)) return true;
  if (managerKind === "INFO" && len <= 40) return true;

  return false;
}

function classifyCase({ clientTurn, managerTurn, prevClientTurn, prevManagerTurn }) {
  const text = String(clientTurn?.text || "").trim();
  if (!text) return { kind: null, confidence: 0, reason: "empty_client_text" };
  if (isMediaOnlyClientText(text)) {
    return { kind: null, confidence: 0, reason: "media_only_client_message" };
  }

  const managerKind = classifyManagerReply(managerTurn?.text || "");
  const oems = detectOemsFromText(text);
  const isVinLike = isVinLikeText(text, clientTurn);

  const smallTalk =
    clientTurn?.smalltalk && typeof clientTurn.smalltalk === "object"
      ? clientTurn.smalltalk
      : resolveSmallTalk(text);

  const repeatFollowup = isRepeatFollowupByHistory({
    text,
    prevClientTurn,
    prevManagerTurn,
    oemsCount: oems.length,
    isVinLike,
  });

  const managerText = String(managerTurn?.text || "").trim();

  if (oems.length > 0 && managerKind === "NO_STOCK") {
    return {
      kind: "NO_STOCK_REPLY",
      confidence: 0.95,
      reason: "oem_message_followed_by_no_stock_reply",
      signals: {
        managerKind,
        oemsCount: oems.length,
        smallTalkIntent: smallTalk?.intent || null,
        isVinLike,
      },
    };
  }

  if (isStatusQuestion(text) && (managerKind === "STATUS" || isStatusReply(managerText))) {
    return {
      kind: "STATUS_TRACKING",
      confidence: 0.93,
      reason: "status_question_followed_by_status_reply",
      signals: {
        managerKind,
        oemsCount: oems.length,
        smallTalkIntent: smallTalk?.intent || null,
        smallTalkTopic: smallTalk?.topic || null,
        isVinLike,
      },
    };
  }

  if (repeatFollowup) {
    return {
      kind: "REPEAT_FOLLOWUP",
      confidence: 0.9,
      reason: "short_followup_with_previous_context",
      signals: {
        managerKind,
        oemsCount: oems.length,
        smallTalkIntent: smallTalk?.intent || null,
        smallTalkTopic: smallTalk?.topic || null,
        isVinLike,
      },
    };
  }

  if (isVinLike && oems.length === 0 && managerKind === "HANDOVER") {
    return {
      kind: "VIN_HANDOVER",
      confidence: 0.96,
      reason: "vin_message_followed_by_manager_handover",
      signals: { managerKind, oemsCount: oems.length, smallTalkIntent: smallTalk?.intent || null },
    };
  }

  if (isVinLike && oems.length === 0 && (managerKind === "SERVICE_ACK" || managerKind === "INFO")) {
    if (isServiceAckReply(managerText)) {
      return {
        kind: "VIN_SERVICE_ACK",
        confidence: 0.86,
        reason: "vin_message_followed_by_service_ack",
        signals: {
          managerKind,
          oemsCount: oems.length,
          smallTalkIntent: smallTalk?.intent || null,
          isVinLike,
        },
      };
    }
  }

  if (isServiceAckReply(managerText)) {
    return {
      kind: "SERVICE_ACK",
      confidence: 0.88,
      reason: "request_followed_by_service_ack",
      signals: {
        managerKind,
        oemsCount: oems.length,
        smallTalkIntent: smallTalk?.intent || null,
        smallTalkTopic: smallTalk?.topic || null,
        isVinLike,
      },
    };
  }

  if (oems.length > 0 && ["PRICING", "CONTACT", "ADDRESS", "ORDER", "STATUS"].includes(managerKind)) {
    return {
      kind: "OEM_FLOW",
      confidence: 0.93,
      reason: "oem_message_followed_by_sales_progress_reply",
      signals: {
        managerKind,
        oemsCount: oems.length,
        smallTalkIntent: smallTalk?.intent || null,
        smallTalkTopic: smallTalk?.topic || null,
        isVinLike,
      },
    };
  }

  if (smallTalk?.intent === "HOWTO" && ["INFO", "STATUS", "SERVICE_ACK"].includes(managerKind)) {
    return {
      kind: "SMALLTALK_HOWTO",
      confidence: 0.84,
      reason: "howto_smalltalk_with_info_reply",
      signals: {
        managerKind,
        oemsCount: oems.length,
        smallTalkIntent: "HOWTO",
        smallTalkTopic: smallTalk.topic || null,
        isVinLike,
      },
    };
  }

  if (smallTalk?.intent === "OFFTOPIC" && managerKind === "INFO") {
    return {
      kind: "SMALLTALK_OFFTOPIC",
      confidence: 0.82,
      reason: "offtopic_smalltalk_with_info_reply",
      signals: {
        managerKind,
        oemsCount: oems.length,
        smallTalkIntent: "OFFTOPIC",
        smallTalkTopic: null,
        isVinLike,
      },
    };
  }

  if (
    isContextFollowupCandidate({
      text,
      prevClientTurn,
      oemsCount: oems.length,
      isVinLike,
      managerKind,
    })
  ) {
    return {
      kind: "TEXT_CONTEXT_FOLLOWUP",
      confidence: 0.84,
      reason: "short_contextual_followup_without_oem_or_vin",
      signals: {
        managerKind,
        oemsCount: oems.length,
        smallTalkIntent: smallTalk?.intent || null,
        smallTalkTopic: smallTalk?.topic || null,
        isVinLike,
      },
    };
  }

  return {
    kind: null,
    confidence: 0,
    reason: "no_high_confidence_mapping",
    signals: {
      managerKind,
      oemsCount: oems.length,
      smallTalkIntent: smallTalk?.intent || null,
      smallTalkTopic: smallTalk?.topic || null,
      isVinLike,
    },
  };
}

function pickNextManagerTurn(turns, startIdx) {
  for (let i = startIdx + 1; i < turns.length; i += 1) {
    const t = turns[i];
    if (t.author_type === "client") break;
    if (t.author_type === "manager") return t;
  }
  return null;
}

function pickPrevClientTurn(turns, startIdx) {
  for (let i = startIdx - 1; i >= 0; i -= 1) {
    const t = turns[i];
    if (t.author_type === "client") return t;
  }
  return null;
}

function pickPrevManagerTurn(turns, startIdx) {
  for (let i = startIdx - 1; i >= 0; i -= 1) {
    const t = turns[i];
    if (t.author_type === "manager") return t;
  }
  return null;
}

function sortTurns(turns = []) {
  return turns.slice().sort((a, b) => {
    const sa = Number(a?.seq || 0);
    const sb = Number(b?.seq || 0);
    if (sa !== sb) return sa - sb;
    const da = new Date(String(a?.message_date || "")).getTime() || 0;
    const db = new Date(String(b?.message_date || "")).getTime() || 0;
    return da - db;
  });
}

async function main() {
  const args = parseArgs();
  const inputDir = await resolveInputDir(args["input-dir"] || args.input_dir || args.inputDir);
  const turnsFile = path.join(inputDir, "normalized", "dialog_turns.jsonl");

  const maxPerKind = toPositiveInt(
    args["max-per-kind"] ?? args.max_per_kind ?? args.maxPerKind,
    250,
  );
  const minConfidence = Number(args["min-confidence"] ?? args.min_confidence ?? 0.8);

  const outTs = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = args["out-dir"]
    ? path.resolve(process.cwd(), args["out-dir"])
    : path.join(ROOT, "data", "tmp", "dialog-tests", outTs);
  await fs.mkdir(outDir, { recursive: true });

  const dialogMap = new Map();
  let rowsRead = 0;

  for await (const row of readJsonl(turnsFile)) {
    rowsRead += 1;
    const key = String(row?.dialog_key || "").trim();
    if (!key) continue;
    if (!dialogMap.has(key)) dialogMap.set(key, []);
    dialogMap.get(key).push(row);
  }

  const high = [];
  const review = [];
  const countByKind = {};
  const reviewReasonCount = {};

  for (const [dialogKey, rawTurns] of dialogMap.entries()) {
    const turns = sortTurns(rawTurns);
    for (let i = 0; i < turns.length; i += 1) {
      const clientTurn = turns[i];
      if (clientTurn.author_type !== "client") continue;

      const managerTurn = pickNextManagerTurn(turns, i);
      if (!managerTurn) continue;
      const prevClientTurn = pickPrevClientTurn(turns, i);
      const prevManagerTurn = pickPrevManagerTurn(turns, i);

      const mapped = classifyCase({
        clientTurn,
        managerTurn,
        prevClientTurn,
        prevManagerTurn,
      });
      const baseCase = {
        case_id: `${dialogKey}::${clientTurn.message_id || i}`,
        dialog_key: dialogKey,
        entity_type: clientTurn.entity_type,
        entity_id: clientTurn.entity_id,
        chat_id: clientTurn.chat_id,
        client_message_id: clientTurn.message_id,
        manager_message_id: managerTurn.message_id,
        client_text: clientTurn.text,
        manager_reply_excerpt: clip(managerTurn.text, 260),
        history_prev_client_message_id: prevClientTurn?.message_id || null,
        history_prev_client_text: prevClientTurn ? clip(prevClientTurn.text, 260) : null,
        history_prev_manager_message_id: prevManagerTurn?.message_id || null,
        history_prev_manager_text: prevManagerTurn ? clip(prevManagerTurn.text, 260) : null,
        history_turn_gap:
          prevClientTurn?.seq && clientTurn?.seq
            ? Math.max(0, Number(clientTurn.seq) - Number(prevClientTurn.seq))
            : null,
        mapped_kind: mapped.kind,
        confidence: mapped.confidence,
        reason: mapped.reason,
        signals: mapped.signals || {},
      };

      if (!mapped.kind || mapped.confidence < minConfidence) {
        const reasonKey = String(mapped.reason || "unknown");
        reviewReasonCount[reasonKey] = (reviewReasonCount[reasonKey] || 0) + 1;
        review.push(baseCase);
        continue;
      }

      const prev = countByKind[mapped.kind] || 0;
      if (prev >= maxPerKind) continue;
      countByKind[mapped.kind] = prev + 1;

      high.push({
        ...baseCase,
        assertion_kind: mapped.kind,
      });
    }
  }

  const summary = {
    created_at: new Date().toISOString(),
    input_dir: inputDir,
    input_rows: rowsRead,
    dialogs_total: dialogMap.size,
    high_confidence_total: high.length,
    review_total: review.length,
    min_confidence: minConfidence,
    max_per_kind: maxPerKind,
    by_kind: countByKind,
    review_reason_top: Object.entries(reviewReasonCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25),
  };

  await writeJson(path.join(outDir, "high_confidence_cases.json"), high);
  await writeJson(path.join(outDir, "review_cases.json"), review);
  await writeJson(path.join(outDir, "summary.json"), summary);

  const md = [
    "# Summary",
    `- Input: \`${inputDir}\``,
    `- Dialogs: ${summary.dialogs_total}`,
    `- Rows read: ${summary.input_rows}`,
    `- High confidence: ${summary.high_confidence_total}`,
    `- Review queue: ${summary.review_total}`,
    "",
    "## By Kind",
    ...Object.entries(countByKind).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## Review Reasons (Top)",
    ...summary.review_reason_top.map(([k, v]) => `- ${k}: ${v}`),
    "",
  ].join("\n");
  await fs.writeFile(path.join(outDir, "summary.md"), md, "utf8");

  const pointerDir = path.join(ROOT, "data", "tmp", "dialog-tests");
  await fs.mkdir(pointerDir, { recursive: true });
  await fs.writeFile(path.join(pointerDir, "LATEST.txt"), outDir, "utf8");

  logger.info(
    {
      inputDir,
      outDir,
      rowsRead,
      dialogs: dialogMap.size,
      highCases: high.length,
      reviewCases: review.length,
      countByKind,
    },
    "Dialog cases built",
  );

  process.stdout.write(
    `DIALOG_CASES_READY ${outDir} high=${high.length} review=${review.length}\n`,
  );
}

main().catch((err) => {
  logger.error({ err: String(err) }, "buildDialogCases failed");
  process.exitCode = 1;
});
