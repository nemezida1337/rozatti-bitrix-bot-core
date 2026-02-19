import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

function inGitRepo() {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "true";
  } catch {
    return false;
  }
}

function listTrackedRuntimeDumps() {
  const out = execFileSync("git", ["ls-files"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  const forbiddenPrefixes = ["data/events/", "data/cortex/"];

  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => forbiddenPrefixes.some((prefix) => p.startsWith(prefix)));
}

test("repo hygiene: runtime dumps must not be tracked by git", { skip: !inGitRepo() }, () => {
  const tracked = listTrackedRuntimeDumps();
  assert.deepEqual(
    tracked,
    [],
    `Tracked runtime dump files found:\n${tracked.join("\n")}`
  );
});

