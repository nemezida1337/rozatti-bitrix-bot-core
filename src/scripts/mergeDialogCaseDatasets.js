// src/scripts/mergeDialogCaseDatasets.js
//
// Объединяет несколько датасетов high_confidence_cases.json
// и балансирует их по классам (assertion_kind) и источникам.
//
// Пример:
// node src/scripts/mergeDialogCaseDatasets.js ^
//   --input-dirs data/tmp/dialog-tests/2026-02-21T14-09-23-850Z,data/tmp/dialog-tests/2026-02-21T14-36-02-795Z ^
//   --source-labels bitrix_human,telegram_raw ^
//   --max-per-kind-source 300 ^
//   --max-per-kind-total 500

import "../core/env.js";

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "../core/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (!token.startsWith("--")) continue;

    const eq = token.indexOf("=");
    if (eq > 2) {
      const key = token.slice(2, eq);
      const val = token.slice(eq + 1);
      out[key] = val;
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

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function hash32(text) {
  const s = String(text || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function stableScore(row, sourceLabel) {
  const key = [
    sourceLabel,
    row?.assertion_kind || "",
    row?.case_id || "",
    row?.dialog_key || "",
    row?.client_message_id || "",
    row?.client_text || "",
  ].join("|");
  return hash32(key);
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function getKind(row) {
  return String(row?.assertion_kind || row?.mapped_kind || "UNKNOWN").trim() || "UNKNOWN";
}

function deriveSourceLabel(inputPath, index) {
  const base = path.basename(path.resolve(inputPath));
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return safe || `source_${index + 1}`;
}

function roundRobinTake(sourceToRows, maxTotal) {
  const labels = Array.from(sourceToRows.keys()).sort();
  if (labels.length === 0) return [];
  if (!Number.isFinite(maxTotal) || maxTotal <= 0) return [];

  const queues = new Map();
  for (const label of labels) {
    queues.set(label, sourceToRows.get(label).slice());
  }

  const out = [];
  let idleRounds = 0;
  let idx = 0;

  while (out.length < maxTotal && idleRounds < labels.length) {
    const label = labels[idx % labels.length];
    const queue = queues.get(label) || [];
    if (queue.length > 0) {
      out.push(queue.shift());
      idleRounds = 0;
    } else {
      idleRounds += 1;
    }
    idx += 1;
  }

  return out;
}

function countByKind(rows = []) {
  const map = {};
  for (const row of rows) {
    const kind = getKind(row);
    map[kind] = (map[kind] || 0) + 1;
  }
  return map;
}

function countByKindSource(rows = []) {
  const out = {};
  for (const row of rows) {
    const kind = getKind(row);
    const source = String(row?.dataset_source || "unknown");
    if (!out[kind]) out[kind] = {};
    out[kind][source] = (out[kind][source] || 0) + 1;
  }
  return out;
}

function buildSummaryMarkdown(summary) {
  const lines = [];
  lines.push("# Merged Dialog Dataset");
  lines.push("");
  lines.push(`- Created: ${summary.created_at}`);
  lines.push(`- Inputs: ${summary.inputs.length}`);
  lines.push(`- High confidence merged: ${summary.high_confidence_total}`);
  lines.push(`- Review merged: ${summary.review_total}`);
  lines.push(
    `- Caps: max_per_kind_source=${summary.caps.max_per_kind_source}, max_per_kind_total=${summary.caps.max_per_kind_total}`,
  );
  lines.push("");
  lines.push("## Inputs");
  for (const input of summary.inputs) {
    lines.push(
      `- ${input.label}: high=${input.high_count}, review=${input.review_count}, dir=\`${input.input_dir}\``,
    );
  }
  lines.push("");
  lines.push("## High By Kind");
  for (const [kind, count] of Object.entries(summary.high_by_kind || {}).sort((a, b) =>
    String(a[0]).localeCompare(String(b[0])),
  )) {
    lines.push(`- ${kind}: ${count}`);
  }
  lines.push("");
  lines.push("## High By Kind+Source");
  for (const [kind, bySource] of Object.entries(summary.high_by_kind_source || {}).sort((a, b) =>
    String(a[0]).localeCompare(String(b[0])),
  )) {
    const chunks = Object.entries(bySource || {})
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([source, count]) => `${source}=${count}`);
    lines.push(`- ${kind}: ${chunks.join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs();
  const inputDirs = splitCsv(args["input-dirs"] || args.input_dirs || args.inputs || "");
  const sourceLabels = splitCsv(args["source-labels"] || args.source_labels || "");

  if (!inputDirs.length) {
    throw new Error("Передайте --input-dirs <dir1,dir2,...> c датасетами dialog-tests.");
  }

  const maxPerKindSource = toPositiveInt(
    args["max-per-kind-source"] ?? args.max_per_kind_source,
    300,
  );
  const maxPerKindTotal = toPositiveInt(
    args["max-per-kind-total"] ?? args.max_per_kind_total,
    500,
  );

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = args["out-dir"]
    ? path.resolve(process.cwd(), String(args["out-dir"]))
    : path.join(ROOT, "data", "tmp", "dialog-tests-merged", ts);
  await fs.mkdir(outDir, { recursive: true });

  const loadedHigh = [];
  const loadedReview = [];
  const inputsSummary = [];
  let duplicateHighSkipped = 0;

  for (let i = 0; i < inputDirs.length; i += 1) {
    const inputDir = path.resolve(process.cwd(), inputDirs[i]);
    const label = sourceLabels[i] || deriveSourceLabel(inputDir, i);

    const highFile = path.join(inputDir, "high_confidence_cases.json");
    const reviewFile = path.join(inputDir, "review_cases.json");

    if (!(await pathExists(highFile))) {
      throw new Error(`Не найден high_confidence_cases.json: ${highFile}`);
    }

    const highRows = ensureArray(JSON.parse(await fs.readFile(highFile, "utf8")));
    const reviewRows = (await pathExists(reviewFile))
      ? ensureArray(JSON.parse(await fs.readFile(reviewFile, "utf8")))
      : [];

    inputsSummary.push({
      label,
      input_dir: inputDir,
      high_count: highRows.length,
      review_count: reviewRows.length,
    });

    for (const row of highRows) {
      loadedHigh.push({
        ...row,
        dataset_source: label,
      });
    }
    for (const row of reviewRows) {
      loadedReview.push({
        ...row,
        dataset_source: label,
      });
    }
  }

  // Дедуп по стабильному ключу
  const seenHigh = new Set();
  const uniqueHigh = [];
  for (const row of loadedHigh) {
    const key = [
      row.dataset_source,
      row.case_id || "",
      getKind(row),
      row.client_message_id || "",
      row.client_text || "",
    ].join("|");
    if (seenHigh.has(key)) {
      duplicateHighSkipped += 1;
      continue;
    }
    seenHigh.add(key);
    uniqueHigh.push(row);
  }

  // kind -> source -> rows
  const bucket = new Map();
  for (const row of uniqueHigh) {
    const kind = getKind(row);
    const source = String(row.dataset_source || "unknown");
    if (!bucket.has(kind)) bucket.set(kind, new Map());
    if (!bucket.get(kind).has(source)) bucket.get(kind).set(source, []);
    bucket.get(kind).get(source).push(row);
  }

  const mergedHigh = [];
  for (const [kind, sourceMap] of bucket.entries()) {
    // 1) per-source cap + stable deterministic ordering
    const capped = new Map();
    for (const [source, rows] of sourceMap.entries()) {
      const ordered = rows
        .slice()
        .sort((a, b) => {
          const sa = stableScore(a, source);
          const sb = stableScore(b, source);
          if (sa !== sb) return sa - sb;
          return String(a.case_id || "").localeCompare(String(b.case_id || ""));
        })
        .slice(0, maxPerKindSource);
      capped.set(source, ordered);
    }

    // 2) total kind cap через round-robin между источниками
    const selectedForKind = roundRobinTake(capped, maxPerKindTotal);
    for (const row of selectedForKind) {
      mergedHigh.push({
        ...row,
        assertion_kind: kind,
      });
    }
  }

  // Дедуп review (без балансировки — это очередь разбора)
  const seenReview = new Set();
  const mergedReview = [];
  for (const row of loadedReview) {
    const key = [
      row.dataset_source,
      row.case_id || "",
      row.reason || "",
      row.client_message_id || "",
      row.client_text || "",
    ].join("|");
    if (seenReview.has(key)) continue;
    seenReview.add(key);
    mergedReview.push(row);
  }

  const summary = {
    created_at: new Date().toISOString(),
    inputs: inputsSummary,
    caps: {
      max_per_kind_source: maxPerKindSource,
      max_per_kind_total: maxPerKindTotal,
    },
    high_before_total: loadedHigh.length,
    high_after_dedup_total: uniqueHigh.length,
    high_duplicate_skipped: duplicateHighSkipped,
    high_confidence_total: mergedHigh.length,
    review_total: mergedReview.length,
    high_by_kind: countByKind(mergedHigh),
    high_by_kind_source: countByKindSource(mergedHigh),
    output_dir: outDir,
    files: {
      high_confidence_cases: "high_confidence_cases.json",
      review_cases: "review_cases.json",
      summary_json: "summary.json",
      summary_md: "summary.md",
    },
  };

  await fs.writeFile(
    path.join(outDir, "high_confidence_cases.json"),
    JSON.stringify(mergedHigh, null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(outDir, "review_cases.json"),
    JSON.stringify(mergedReview, null, 2),
    "utf8",
  );
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  await fs.writeFile(path.join(outDir, "summary.md"), buildSummaryMarkdown(summary), "utf8");

  const latestPtrDir = path.join(ROOT, "data", "tmp", "dialog-tests-merged");
  await fs.mkdir(latestPtrDir, { recursive: true });
  await fs.writeFile(path.join(latestPtrDir, "LATEST.txt"), outDir, "utf8");

  logger.info(
    {
      outDir,
      inputs: inputsSummary,
      highBefore: loadedHigh.length,
      highAfterDedup: uniqueHigh.length,
      highMerged: mergedHigh.length,
      reviewMerged: mergedReview.length,
    },
    "Merged dialog datasets",
  );

  process.stdout.write(
    `DIALOG_MERGED_READY ${outDir} high=${mergedHigh.length} review=${mergedReview.length}\n`,
  );
}

main().catch((err) => {
  logger.error({ err: String(err) }, "mergeDialogCaseDatasets failed");
  process.exitCode = 1;
});

