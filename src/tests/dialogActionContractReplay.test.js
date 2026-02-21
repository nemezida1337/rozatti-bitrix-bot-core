import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { crmSettings } from "../config/settings.crm.js";
import { buildDecision } from "../modules/bot/handler/decision.js";
import { detectOemsFromText } from "../modules/bot/oemDetector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

async function resolveCasesFile() {
  const ciFixture = path.join(
    ROOT,
    "src",
    "tests",
    "fixtures",
    "dialog-cases",
    "high_confidence_cases.ci.json",
  );

  const direct = String(process.env.DIALOG_CASES_FILE || "").trim();
  if (direct) {
    const resolved = path.resolve(process.cwd(), direct);
    if (!(await pathExists(resolved))) {
      throw new Error(`DIALOG_CASES_FILE не найден: ${resolved}`);
    }
    return resolved;
  }

  // Приоритет merged-набору, затем обычному dialog-tests.
  const mergedLatest = path.join(ROOT, "data", "tmp", "dialog-tests-merged", "LATEST.txt");
  if (await pathExists(mergedLatest)) {
    const dir = String(await fs.readFile(mergedLatest, "utf8")).trim();
    const candidate = path.join(path.resolve(dir), "high_confidence_cases.json");
    if (await pathExists(candidate)) return candidate;
  }

  const latestPointer = path.join(ROOT, "data", "tmp", "dialog-tests", "LATEST.txt");
  if (!(await pathExists(latestPointer))) {
    if (await pathExists(ciFixture)) return ciFixture;
    throw new Error("Не найден LATEST: data/tmp/dialog-tests/LATEST.txt и нет CI fixture");
  }
  const latestDir = String(await fs.readFile(latestPointer, "utf8")).trim();
  if (!latestDir) {
    if (await pathExists(ciFixture)) return ciFixture;
    throw new Error("Пустой LATEST: data/tmp/dialog-tests/LATEST.txt");
  }
  const candidate = path.join(path.resolve(latestDir), "high_confidence_cases.json");
  if (!(await pathExists(candidate))) {
    if (await pathExists(ciFixture)) return ciFixture;
    throw new Error(`high_confidence_cases.json не найден: ${candidate}`);
  }
  return candidate;
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

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function hasStageMapping(stage) {
  const aliases = crmSettings?.stageAliases || {};
  const stageToStatusId = crmSettings?.stageToStatusId || {};
  const normalized = aliases[String(stage || "").toUpperCase()] || String(stage || "").toUpperCase();
  return !!stageToStatusId[normalized];
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

  return { gateInput, decision };
}

function evaluateActionContract(row) {
  const kind = String(row?.assertion_kind || "");
  const text = String(row?.client_text || "");
  const { gateInput, decision } = evaluateDecisionForText(text);

  if (kind === "OEM_FLOW" || kind === "NO_STOCK_REPLY") {
    const ok =
      gateInput.requestType === "OEM" &&
      decision.shouldCallCortex === true &&
      decision.mode === "auto" &&
      hasStageMapping("PRICING");
    return {
      ok,
      expected: "route=cortex, action=abcp_lookup, stage=PRICING",
      actual: `requestType=${gateInput.requestType}, shouldCallCortex=${decision.shouldCallCortex}, mode=${decision.mode}`,
      extra: {
        expected_action: "abcp_lookup",
        expected_stage: "PRICING",
        stage_mapped: hasStageMapping("PRICING"),
      },
    };
  }

  if (kind === "SERVICE_ACK" || kind === "STATUS_TRACKING") {
    const isVinLike = !!row?.signals?.isVinLike;
    const oemsCount = Number(row?.signals?.oemsCount || 0);

    // Mixed VIN+OEM теперь считается OEM-путём (abcp_lookup/PRICING).
    if (isVinLike && oemsCount > 0) {
      const ok =
        gateInput.requestType === "OEM" &&
        decision.shouldCallCortex === true &&
        decision.mode === "auto" &&
        hasStageMapping("PRICING");
      return {
        ok,
        expected: "route=cortex, action=abcp_lookup, stage=PRICING (mixed VIN+OEM)",
        actual: `requestType=${gateInput.requestType}, shouldCallCortex=${decision.shouldCallCortex}, mode=${decision.mode}`,
        extra: {
          expected_action: "abcp_lookup",
          expected_stage: "PRICING",
          stage_mapped: hasStageMapping("PRICING"),
        },
      };
    }

    const ok =
      decision.shouldCallCortex === true && decision.mode === "auto" && hasStageMapping("IN_WORK");
    return {
      ok,
      expected: "route=cortex, action=reply, stage=IN_WORK",
      actual: `requestType=${gateInput.requestType}, shouldCallCortex=${decision.shouldCallCortex}, mode=${decision.mode}`,
      extra: {
        expected_action: "reply",
        expected_stage: "IN_WORK",
        stage_mapped: hasStageMapping("IN_WORK"),
      },
    };
  }

  if (kind === "VIN_SERVICE_ACK" || kind === "VIN_HANDOVER") {
    const ok =
      gateInput.requestType === "VIN" &&
      decision.shouldCallCortex === false &&
      decision.mode === "manual" &&
      decision.shouldMoveStage === true &&
      hasStageMapping("VIN_PICK");
    return {
      ok,
      expected: "route=manual, action=handover_operator, stage=VIN_PICK",
      actual: `requestType=${gateInput.requestType}, shouldCallCortex=${decision.shouldCallCortex}, mode=${decision.mode}, shouldMoveStage=${decision.shouldMoveStage}`,
      extra: {
        expected_action: "handover_operator",
        expected_stage: "VIN_PICK",
        stage_mapped: hasStageMapping("VIN_PICK"),
        waitReason: decision.waitReason || null,
      },
    };
  }

  if (
    kind === "SMALLTALK_HOWTO" ||
    kind === "SMALLTALK_OFFTOPIC" ||
    kind === "REPEAT_FOLLOWUP" ||
    kind === "TEXT_CONTEXT_FOLLOWUP"
  ) {
    const ok = decision.shouldCallCortex === true;
    return {
      ok,
      expected: "route=cortex, action=reply, stage=contextual",
      actual: `requestType=${gateInput.requestType}, shouldCallCortex=${decision.shouldCallCortex}, mode=${decision.mode}`,
      extra: {
        expected_action: "reply",
        expected_stage: "contextual",
      },
    };
  }

  return {
    ok: false,
    expected: "known assertion_kind for action contract",
    actual: `unsupported assertion_kind=${kind || "EMPTY"}`,
    extra: {},
  };
}

function buildMarkdownReport(summary, mismatches, reportJsonPath) {
  const lines = [];
  lines.push("# Dialog Action Contract Replay");
  lines.push("");
  lines.push(`- Created: ${summary.created_at}`);
  lines.push(`- Cases file: \`${summary.cases_file}\``);
  lines.push(`- Checked: ${summary.total_checked}`);
  lines.push(`- Failed: ${summary.total_failed}`);
  lines.push(`- Pass rate: ${summary.pass_rate_pct}%`);
  lines.push("");
  lines.push("## By Kind");
  for (const [kind, row] of Object.entries(summary.by_kind || {}).sort((a, b) =>
    String(a[0]).localeCompare(String(b[0])),
  )) {
    lines.push(`- ${kind}: total=${row.total}, passed=${row.passed}, failed=${row.failed}`);
  }
  lines.push("");
  lines.push("## Mismatches (Top 100)");
  if (!mismatches.length) {
    lines.push("- none");
  } else {
    for (const mm of mismatches.slice(0, 100)) {
      lines.push(
        `- ${mm.kind} :: ${mm.case_id} :: expected=${mm.expected} :: actual=${mm.actual}`,
      );
    }
  }
  lines.push("");
  lines.push(`- JSON report: \`${reportJsonPath}\``);
  lines.push("");
  return lines.join("\n");
}

test("dialog action contract replay: merged/high-confidence cases", async () => {
  const casesFile = await resolveCasesFile();
  const loaded = await readJson(casesFile);
  const rows = Array.isArray(loaded) ? loaded : [];
  const maxCases = toPositiveInt(process.env.DIALOG_REPLAY_MAX_CASES, rows.length);
  const checked = rows.slice(0, maxCases);

  const mismatches = [];
  const byKind = {};

  for (const row of checked) {
    const kind = String(row?.assertion_kind || "UNKNOWN");
    const result = evaluateActionContract(row);
    if (!byKind[kind]) byKind[kind] = { total: 0, passed: 0, failed: 0 };
    byKind[kind].total += 1;

    if (result.ok) {
      byKind[kind].passed += 1;
    } else {
      byKind[kind].failed += 1;
      mismatches.push({
        case_id: row?.case_id || null,
        kind,
        client_text: row?.client_text || "",
        expected: result.expected,
        actual: result.actual,
        extra: result.extra || {},
      });
    }
  }

  const totalChecked = checked.length;
  const totalFailed = mismatches.length;
  const passRatePct =
    totalChecked > 0 ? Number((((totalChecked - totalFailed) / totalChecked) * 100).toFixed(2)) : 0;

  const summary = {
    created_at: new Date().toISOString(),
    cases_file: casesFile,
    total_loaded: rows.length,
    total_checked: totalChecked,
    total_failed: totalFailed,
    pass_rate_pct: passRatePct,
    by_kind: byKind,
  };

  const evalDir = resolveEvalOutDir(casesFile);
  await fs.mkdir(evalDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportJsonPath = path.join(evalDir, `dialog_action_replay_${ts}.json`);
  const reportMdPath = path.join(evalDir, `dialog_action_replay_${ts}.md`);

  await fs.writeFile(
    reportJsonPath,
    JSON.stringify({ summary, mismatches }, null, 2),
    "utf8",
  );
  await fs.writeFile(
    reportMdPath,
    buildMarkdownReport(summary, mismatches, reportJsonPath),
    "utf8",
  );
  await fs.writeFile(path.join(evalDir, "LATEST_ACTION_REPLAY.json"), reportJsonPath, "utf8");

  process.stdout.write(
    `DIALOG_ACTION_REPLAY checked=${totalChecked} failed=${totalFailed} report=${reportMdPath}\n`,
  );

  assert.equal(totalFailed, 0, `Action contract mismatches: ${totalFailed}`);
});
