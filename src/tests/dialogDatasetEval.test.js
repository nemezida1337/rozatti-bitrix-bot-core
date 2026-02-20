import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildDecision } from "../modules/bot/handler/decision.js";
import { resolveSmallTalk } from "../modules/bot/handler/shared/smallTalk.js";
import { detectOemsFromText } from "../modules/bot/oemDetector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveCasesFile() {
  const direct = String(process.env.DIALOG_CASES_FILE || "").trim();
  if (direct) {
    const resolved = path.resolve(process.cwd(), direct);
    if (!(await pathExists(resolved))) {
      throw new Error(`DIALOG_CASES_FILE не найден: ${resolved}`);
    }
    return resolved;
  }

  const latestPointer = path.join(ROOT, "data", "tmp", "dialog-tests", "LATEST.txt");
  if (!(await pathExists(latestPointer))) {
    throw new Error("data/tmp/dialog-tests/LATEST.txt не найден");
  }

  const latestDir = String(await fs.readFile(latestPointer, "utf8")).trim();
  if (!latestDir) throw new Error("data/tmp/dialog-tests/LATEST.txt пустой");

  const directFromPointer = path.join(path.resolve(latestDir), "high_confidence_cases.json");
  if (await pathExists(directFromPointer)) return directFromPointer;

  // В LATEST.txt может быть absolute path с другой ОС/машины.
  // Пытаемся восстановить путь по имени директории внутри текущего workspace.
  const pointerDirName = path.basename(latestDir.replace(/[/\\]+/g, path.sep));
  if (pointerDirName) {
    const byDirName = path.join(
      ROOT,
      "data",
      "tmp",
      "dialog-tests",
      pointerDirName,
      "high_confidence_cases.json",
    );
    if (await pathExists(byDirName)) return byDirName;
  }

  // Fallback: выбрать самый свежий валидный датасет в workspace.
  const baseDir = path.join(ROOT, "data", "tmp", "dialog-tests");
  let entries = [];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    throw new Error(`Нет валидного датасета: pointer=${latestDir}`);
  }

  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => String(b).localeCompare(String(a)));

  for (const dirName of dirs) {
    const candidate = path.join(baseDir, dirName, "high_confidence_cases.json");
    if (await pathExists(candidate)) return candidate;
  }

  throw new Error(
    `high_confidence_cases.json не найден (pointer=${latestDir}, checked=${dirs.length} dirs)`,
  );
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function resolveEvalOutDir(casesFile) {
  const explicit = String(process.env.DIALOG_EVAL_OUT_DIR || "").trim();
  if (explicit) return path.resolve(process.cwd(), explicit);

  const rel = path.relative(ROOT, casesFile).replaceAll("\\", "/");
  if (!rel.startsWith("..") && rel.startsWith("src/tests/fixtures/")) {
    return path.join(ROOT, "data", "tmp", "dialog-eval");
  }

  return path.join(path.dirname(casesFile), "eval");
}

function evaluateDecisionForText(text) {
  const detectedOems = detectOemsFromText(text);
  const { gateInput, decision } = buildDecision({
    message: {
      text,
      userFlags: {
        isConnector: "Y",
        isBot: "N",
      },
      chatEntityType: "LINES",
      isSystemLike: false,
    },
    detectedOems,
    lead: {
      statusId: null,
      oemInLead: null,
    },
    session: {
      mode: "auto",
      state: { offers: [] },
      abcp: { offers: [] },
      manualAckSent: false,
    },
    manualStatuses: [],
  });

  return { gateInput, decision, detectedOems };
}

function evaluateCase(row) {
  const kind = String(row?.assertion_kind || "");
  const text = String(row?.client_text || "");
  const { gateInput, decision } = evaluateDecisionForText(text);
  const smallTalk = resolveSmallTalk(text);

  if (kind === "OEM_FLOW") {
    const ok = gateInput.requestType === "OEM" && decision.shouldCallCortex === true;
    return {
      ok,
      expected: "requestType=OEM and shouldCallCortex=true",
      actual: `requestType=${gateInput.requestType}, shouldCallCortex=${decision.shouldCallCortex}`,
      extra: { mode: decision.mode, oems: gateInput.detectedOems?.length || 0 },
    };
  }

  if (kind === "VIN_HANDOVER") {
    const ok =
      gateInput.requestType === "VIN" &&
      decision.mode === "manual" &&
      decision.shouldCallCortex === false;
    return {
      ok,
      expected: "requestType=VIN, mode=manual, shouldCallCortex=false",
      actual: `requestType=${gateInput.requestType}, mode=${decision.mode}, shouldCallCortex=${decision.shouldCallCortex}`,
      extra: { waitReason: decision.waitReason, oems: gateInput.detectedOems?.length || 0 },
    };
  }

  if (kind === "SMALLTALK_HOWTO") {
    const ok = smallTalk?.intent === "HOWTO";
    return {
      ok,
      expected: "resolveSmallTalk.intent=HOWTO",
      actual: `resolveSmallTalk.intent=${smallTalk?.intent || "null"}`,
      extra: { topic: smallTalk?.topic || null },
    };
  }

  if (kind === "SMALLTALK_OFFTOPIC") {
    const ok = smallTalk?.intent === "OFFTOPIC";
    return {
      ok,
      expected: "resolveSmallTalk.intent=OFFTOPIC",
      actual: `resolveSmallTalk.intent=${smallTalk?.intent || "null"}`,
      extra: { topic: smallTalk?.topic || null },
    };
  }

  if (kind === "NO_STOCK_REPLY") {
    const ok = gateInput.requestType === "OEM" && decision.shouldCallCortex === true;
    return {
      ok,
      expected: "requestType=OEM and shouldCallCortex=true",
      actual: `requestType=${gateInput.requestType}, shouldCallCortex=${decision.shouldCallCortex}`,
      extra: { mode: decision.mode, oems: gateInput.detectedOems?.length || 0 },
    };
  }

  if (kind === "STATUS_TRACKING") {
    const statusLikeText =
      /(статус|где заказ|заказ\s*[№#]|трек|накладн|когда отправ|отслеживат)/i.test(text);
    const ok = smallTalk?.intent === "HOWTO" || statusLikeText;
    return {
      ok,
      expected: "status-like text should map to status intent/context",
      actual: `resolveSmallTalk.intent=${smallTalk?.intent || "null"}, statusLikeText=${statusLikeText}`,
      extra: { topic: smallTalk?.topic || null, requestType: gateInput.requestType },
    };
  }

  if (kind === "SERVICE_ACK") {
    const isVinLike = !!row?.signals?.isVinLike;
    if (isVinLike) {
      const ok =
        gateInput.requestType === "VIN" &&
        decision.mode === "manual" &&
        decision.shouldCallCortex === false;
      return {
        ok,
        expected: "VIN service-ack should map to manual VIN gate",
        actual: `requestType=${gateInput.requestType}, mode=${decision.mode}, shouldCallCortex=${decision.shouldCallCortex}`,
        extra: { waitReason: decision.waitReason },
      };
    }

    const ok = decision.shouldCallCortex === true;
    return {
      ok,
      expected: "service-ack sales message should call Cortex",
      actual: `requestType=${gateInput.requestType}, shouldCallCortex=${decision.shouldCallCortex}`,
      extra: { mode: decision.mode, oems: gateInput.detectedOems?.length || 0 },
    };
  }

  if (kind === "VIN_SERVICE_ACK") {
    const ok =
      gateInput.requestType === "VIN" &&
      decision.mode === "manual" &&
      decision.shouldCallCortex === false;
    return {
      ok,
      expected: "requestType=VIN, mode=manual, shouldCallCortex=false",
      actual: `requestType=${gateInput.requestType}, mode=${decision.mode}, shouldCallCortex=${decision.shouldCallCortex}`,
      extra: { waitReason: decision.waitReason, oems: gateInput.detectedOems?.length || 0 },
    };
  }

  if (kind === "REPEAT_FOLLOWUP") {
    const hasContext = !!String(row?.history_prev_client_text || "").trim();
    const ok = hasContext;
    return {
      ok,
      expected: "repeat followup must have previous client context",
      actual: `hasContext=${hasContext}`,
      extra: { prevClient: row?.history_prev_client_text || null },
    };
  }

  return {
    ok: false,
    expected: "known assertion_kind",
    actual: `unsupported assertion_kind=${kind || "EMPTY"}`,
    extra: {},
  };
}

async function writeReport({ casesFile, sampled, results, mismatches }) {
  const outDir = resolveEvalOutDir(casesFile);
  await fs.mkdir(outDir, { recursive: true });

  const byKind = {};
  for (const row of results) {
    const k = row.kind;
    if (!byKind[k]) byKind[k] = { total: 0, passed: 0, failed: 0 };
    byKind[k].total += 1;
    if (row.ok) byKind[k].passed += 1;
    else byKind[k].failed += 1;
  }

  const summary = {
    created_at: new Date().toISOString(),
    cases_file: casesFile,
    total_loaded: sampled.length,
    total_checked: results.length,
    total_failed: mismatches.length,
    pass_rate_pct:
      results.length > 0 ? Number((((results.length - mismatches.length) / results.length) * 100).toFixed(2)) : 0,
    by_kind: byKind,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `dialog_eval_${stamp}.json`);
  const mdPath = path.join(outDir, `dialog_eval_${stamp}.md`);
  await fs.writeFile(jsonPath, JSON.stringify({ summary, mismatches }, null, 2), "utf8");

  const md = [
    "# Dialog Dataset Eval",
    `- Cases file: \`${casesFile}\``,
    `- Checked: ${summary.total_checked}`,
    `- Failed: ${summary.total_failed}`,
    `- Pass rate: ${summary.pass_rate_pct}%`,
    "",
    "## By Kind",
    ...Object.entries(byKind).map(([kind, stat]) => `- ${kind}: ${stat.passed}/${stat.total}`),
    "",
    "## First Failures",
    ...mismatches.slice(0, 25).map((m) => {
      const excerpt = String(m.client_text || "").replace(/\s+/g, " ").trim().slice(0, 180);
      return `- ${m.case_id} | ${m.kind}: expected ${m.expected}; actual ${m.actual}; text="${excerpt}"`;
    }),
    "",
  ].join("\n");
  await fs.writeFile(mdPath, md, "utf8");
  await fs.writeFile(path.join(outDir, "LATEST.json"), jsonPath, "utf8");

  return { summary, jsonPath, mdPath };
}

test("dialog dataset eval: high-confidence cases", async (t) => {
  let casesFile = null;
  try {
    casesFile = await resolveCasesFile();
  } catch (err) {
    t.skip(`Датасет не найден: ${String(err?.message || err)}`);
    return;
  }

  const allCases = await readJson(casesFile);
  assert.ok(Array.isArray(allCases), "high_confidence_cases.json должен быть массивом");

  const limit = toPositiveInt(process.env.DIALOG_CASES_LIMIT, allCases.length);
  const sampled = allCases.slice(0, limit);
  if (!sampled.length) {
    t.skip("В high_confidence_cases.json нет кейсов для проверки");
    return;
  }

  const results = [];
  const mismatches = [];

  for (const row of sampled) {
    const evalResult = evaluateCase(row);
    const enriched = {
      case_id: row.case_id,
      kind: row.assertion_kind,
      client_text: row.client_text,
      ...evalResult,
    };
    results.push(enriched);
    if (!evalResult.ok) mismatches.push(enriched);
  }

  const { summary, jsonPath, mdPath } = await writeReport({
    casesFile,
    sampled,
    results,
    mismatches,
  });

  const enforceStrict = String(process.env.DIALOG_EVAL_ENFORCE || "").trim() === "1";
  if (enforceStrict) {
    assert.equal(
      mismatches.length,
      0,
      `Найдены несоответствия: ${mismatches.length}. См. отчёт: ${jsonPath}`,
    );
  } else {
    assert.ok(summary.total_checked > 0, "Должен быть проверен минимум 1 кейс");
  }

  process.stdout.write(
    `DIALOG_DATASET_EVAL checked=${summary.total_checked} failed=${summary.total_failed} report=${mdPath}\n`,
  );
});
