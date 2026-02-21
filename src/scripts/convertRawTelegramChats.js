// src/scripts/convertRawTelegramChats.js
//
// Конвертирует Telegram HTML export из папки "сырые чаты/chats/*/messages.html"
// в формат normalized/dialog_turns.jsonl, совместимый с buildDialogCases.js.
//
// Примеры:
//   node src/scripts/convertRawTelegramChats.js
//   node src/scripts/convertRawTelegramChats.js --input-dir "сырые чаты/chats"
//   node src/scripts/convertRawTelegramChats.js --allow-multi-author 1
//   node src/scripts/convertRawTelegramChats.js --manager-name "Rozatti"

import "../core/env.js";

import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "../core/logger.js";
import { resolveSmallTalk } from "../modules/bot/handler/shared/smallTalk.js";
import { detectOemsFromText } from "../modules/bot/oemDetector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

const FROM_NAME_RE = /<div class="from_name">\s*([\s\S]*?)\s*<\/div>/i;
const TEXT_RE = /<div class="text">\s*([\s\S]*?)\s*<\/div>/gi;
const DATE_TITLE_RE = /<div class="pull_right date details" title="([^"]+)"/i;
const MESSAGE_ID_RE = /id="message(\d+)"/i;
const MESSAGE_BLOCK_SPLIT = '<div class="message default clearfix';
const DATE_IN_NAME_TAIL_RE = /\s+\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2}\s*$/;

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

function toBool(value, fallback = false) {
  if (value == null) return fallback;
  const s = String(value).trim().toLowerCase();
  if (!s) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

function decodeHtmlEntities(input) {
  const text = String(input || "");
  return text
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtml(input) {
  return decodeHtmlEntities(
    String(input || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/[ \u00A0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeAuthorName(rawName) {
  const normalized = stripHtml(rawName).replace(DATE_IN_NAME_TAIL_RE, "").trim();
  return normalized || null;
}

function isManagerName(name, managerName) {
  return String(name || "").trim().toLowerCase() === String(managerName || "").trim().toLowerCase();
}

function parseDateTitle(rawTitle) {
  const title = String(rawTitle || "").trim();
  if (!title) return null;

  const m = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+UTC([+-]\d{2}):(\d{2})$/i.exec(
    title,
  );
  if (!m) return null;

  const [, dd, mm, yyyy, hh, min, ss, tzH, tzM] = m;
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}${tzH}:${tzM}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function extractMessagesFromHtml(html) {
  const chunks = String(html || "").split(MESSAGE_BLOCK_SPLIT);
  if (chunks.length <= 1) return [];

  const out = [];
  let lastSender = null;
  let seqRaw = 0;

  for (let i = 1; i < chunks.length; i += 1) {
    const block = `${MESSAGE_BLOCK_SPLIT}${chunks[i]}`;
    seqRaw += 1;

    const idMatch = block.match(MESSAGE_ID_RE);
    const messageId = idMatch?.[1] || null;

    const fromMatch = block.match(FROM_NAME_RE);
    const explicitSender = fromMatch ? normalizeAuthorName(fromMatch[1]) : null;
    const sender = explicitSender || lastSender || null;
    if (sender) lastSender = sender;

    const dateTitleMatch = block.match(DATE_TITLE_RE);
    const dateTitle = dateTitleMatch?.[1] || null;
    const messageDateIso = parseDateTitle(dateTitle);

    const textParts = [];
    for (const m of block.matchAll(TEXT_RE)) {
      const t = stripHtml(m?.[1] || "");
      if (t) textParts.push(t);
    }
    const text = textParts.join("\n\n").trim();

    const hasMedia =
      /class="media_wrap clearfix"/i.test(block) ||
      /class="media clearfix pull_left/i.test(block);

    out.push({
      seq_raw: seqRaw,
      message_id: messageId,
      sender,
      sender_explicit: explicitSender,
      text,
      has_media: hasMedia,
      date_title: dateTitle,
      message_date: messageDateIso,
    });
  }

  return out;
}

function openJsonlWriter(filePath) {
  return createWriteStream(filePath, { flags: "a", encoding: "utf8" });
}

async function writeJsonlLine(stream, row) {
  const line = `${JSON.stringify(row)}\n`;
  if (stream.write(line)) return;
  await new Promise((resolve) => stream.once("drain", resolve));
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function toChatEntityId(chatDirName) {
  const m = String(chatDirName || "").match(/(\d+)/);
  if (!m) return chatDirName;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : chatDirName;
}

async function main() {
  const args = parseArgs();

  const managerName = String(args["manager-name"] || args.manager_name || "Rozatti").trim();
  const allowMultiAuthor = toBool(args["allow-multi-author"] || args.allow_multi_author, false);

  const inputDir = args["input-dir"]
    ? path.resolve(process.cwd(), String(args["input-dir"]))
    : path.join(ROOT, "сырые чаты", "chats");

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outRoot = args["out-dir"]
    ? path.resolve(process.cwd(), String(args["out-dir"]))
    : path.join(ROOT, "data", "tmp", "telegram-raw-dialogs", ts);

  const rawDir = path.join(outRoot, "raw");
  const normalizedDir = path.join(outRoot, "normalized");
  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(normalizedDir, { recursive: true });

  const rawFile = path.join(rawDir, "dialogs_raw.jsonl");
  const turnsFile = path.join(normalizedDir, "dialog_turns.jsonl");
  const rawWriter = openJsonlWriter(rawFile);
  const turnsWriter = openJsonlWriter(turnsFile);

  const entries = await fs.readdir(inputDir, { withFileTypes: true }).catch(() => []);
  const chatDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();

  const skipped = {
    no_messages_file: 0,
    no_authors: 0,
    no_manager: 0,
    not_two_authors: 0,
    no_text_messages: 0,
  };
  const skipExamples = [];

  const stats = {
    manager_name: managerName,
    allow_multi_author: allowMultiAuthor,
    chats_total_dirs: chatDirs.length,
    chats_scanned: 0,
    chats_included: 0,
    messages_raw_total: 0,
    messages_with_text: 0,
    turns_written: 0,
    client_turns_written: 0,
    manager_turns_written: 0,
    media_without_text_skipped: 0,
  };

  try {
    for (const chatDir of chatDirs) {
      const fp = path.join(inputDir, chatDir, "messages.html");
      if (!(await fs.stat(fp).then(() => true).catch(() => false))) {
        skipped.no_messages_file += 1;
        continue;
      }

      stats.chats_scanned += 1;
      const html = await fs.readFile(fp, "utf8");
      const parsed = extractMessagesFromHtml(html);
      stats.messages_raw_total += parsed.length;

      const authors = Array.from(
        new Set(parsed.map((x) => x.sender).filter(Boolean)),
      );
      const hasManager = authors.some((x) => isManagerName(x, managerName));

      if (!authors.length) {
        skipped.no_authors += 1;
        if (skipExamples.length < 30) skipExamples.push({ chatDir, reason: "no_authors" });
        continue;
      }
      if (!hasManager) {
        skipped.no_manager += 1;
        if (skipExamples.length < 30) skipExamples.push({ chatDir, reason: "no_manager", authors });
        continue;
      }
      if (!allowMultiAuthor && authors.length !== 2) {
        skipped.not_two_authors += 1;
        if (skipExamples.length < 30) {
          skipExamples.push({ chatDir, reason: "not_two_authors", authors });
        }
        continue;
      }

      const clientNames = authors.filter((x) => !isManagerName(x, managerName));
      const defaultClientName = clientNames[0] || null;
      const textMessages = parsed.filter((x) => !!String(x.text || "").trim());
      if (!textMessages.length) {
        skipped.no_text_messages += 1;
        if (skipExamples.length < 30) skipExamples.push({ chatDir, reason: "no_text_messages" });
        continue;
      }

      stats.chats_included += 1;

      await writeJsonlLine(rawWriter, {
        source: "telegram_raw_export",
        chat_dir: chatDir,
        manager_name: managerName,
        authors,
        included: true,
        parsed_messages: parsed.length,
        text_messages: textMessages.length,
      });

      for (const row of parsed) {
        const text = String(row.text || "").trim();
        if (!text) {
          if (row.has_media) stats.media_without_text_skipped += 1;
          continue;
        }

        const sender = row.sender || defaultClientName || "UNKNOWN";
        const authorType = isManagerName(sender, managerName) ? "manager" : "client";
        const detectedOems = authorType === "client" ? detectOemsFromText(text) : [];
        const smallTalk =
          authorType === "client"
            ? resolveSmallTalk(text)
            : null;

        const turn = {
          domain: "telegram.raw.local",
          entity_type: "telegram_chat",
          entity_id: toChatEntityId(chatDir),
          chat_id: chatDir,
          dialog_key: `telegram:${chatDir}`,
          seq: row.seq_raw,
          message_id: row.message_id || `${chatDir}_${row.seq_raw}`,
          message_date: row.message_date || null,
          author_id: sender,
          author_name: sender,
          author_type: authorType,
          manager_id: isManagerName(sender, managerName) ? managerName : null,
          text,
          text_masked: text,
          detected_oems: detectedOems,
          is_vin_like:
            /(?:\bVIN\b|\bВИН\b)/i.test(text) || /[A-HJ-NPR-Z0-9]{17}/i.test(text),
          smalltalk: smallTalk
            ? {
                intent: smallTalk.intent,
                topic: smallTalk.topic || null,
              }
            : null,
          params: {
            source: "telegram_html_export",
            chat_dir: chatDir,
            sender_explicit: row.sender_explicit || null,
            date_title: row.date_title || null,
            has_media: !!row.has_media,
          },
        };

        await writeJsonlLine(turnsWriter, turn);
        stats.turns_written += 1;
        stats.messages_with_text += 1;
        if (authorType === "client") stats.client_turns_written += 1;
        if (authorType === "manager") stats.manager_turns_written += 1;
      }
    }
  } finally {
    await new Promise((resolve) => rawWriter.end(resolve));
    await new Promise((resolve) => turnsWriter.end(resolve));
  }

  const summary = {
    created_at: new Date().toISOString(),
    input_dir: inputDir,
    output_dir: outRoot,
    stats,
    skipped,
    skip_examples: skipExamples,
    files: {
      raw_jsonl: path.relative(outRoot, rawFile).replaceAll("\\", "/"),
      turns_jsonl: path.relative(outRoot, turnsFile).replaceAll("\\", "/"),
    },
  };

  await writeJson(path.join(outRoot, "summary.json"), summary);

  const latestPtrDir = path.join(ROOT, "data", "tmp", "telegram-raw-dialogs");
  await fs.mkdir(latestPtrDir, { recursive: true });
  await fs.writeFile(path.join(latestPtrDir, "LATEST.txt"), outRoot, "utf8");

  logger.info(
    {
      inputDir,
      outRoot,
      chatsScanned: stats.chats_scanned,
      chatsIncluded: stats.chats_included,
      turnsWritten: stats.turns_written,
      skipped,
    },
    "Raw Telegram chats converted",
  );

  process.stdout.write(
    `TELEGRAM_RAW_CONVERT_READY ${outRoot} chats=${stats.chats_included} turns=${stats.turns_written}\n`,
  );
}

main().catch((err) => {
  logger.error({ err: String(err) }, "convertRawTelegramChats failed");
  process.exitCode = 1;
});

