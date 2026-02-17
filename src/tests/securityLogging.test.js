import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { logger } from "../core/logger.js";

function runNodeModuleSnippet(code, extraEnv = {}) {
  const res = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnv },
      encoding: "utf8",
    },
  );

  if (res.error) throw res.error;
  return {
    status: res.status,
    output: `${res.stdout || ""}\n${res.stderr || ""}`,
  };
}

test("bitrix route: should not log raw request body on missing domain", async () => {
  process.env.BITRIX_EVENTS_SECRET = "audit-secret";

  const warnCalls = [];
  const originalWarn = logger.warn;
  logger.warn = (ctxOrMsg, maybeMsg) => {
    warnCalls.push({ ctxOrMsg, maybeMsg });
    return originalWarn(ctxOrMsg, maybeMsg);
  };

  const { buildServer } = await import("../core/app.js");
  const app = await buildServer();

  try {
    const res = await app.inject({
      method: "POST",
      url: "/bitrix/events?secret=audit-secret",
      payload: {
        event: "onimbotmessageadd",
        data: {
          PARAMS: {
            MESSAGE: "client secret text",
            PHONE: "+7 (999) 111-22-33",
          },
        },
      },
    });

    assert.equal(res.statusCode, 400);

    const eventWithoutDomainCall = warnCalls.find(
      (x) => x.maybeMsg === "Event without domain",
    );
    assert.ok(eventWithoutDomainCall, "Expected warning about missing domain");

    const ctx = eventWithoutDomainCall.ctxOrMsg || {};
    assert.equal(
      Object.prototype.hasOwnProperty.call(ctx, "body"),
      false,
      "Logger context must not include raw body",
    );
  } finally {
    await app.close();
    logger.warn = originalWarn;
  }
});

test("abcp module: should not log credentials in startup config log", async () => {
  const secretLogin = "abcp-login-secret";
  const secretPassword = "abcp-password-secret";
  const { status, output } = runNodeModuleSnippet(
    `await import("./src/modules/external/pricing/abcp.js");`,
    {
      ABCP_DOMAIN: "example.abcp.test",
      ABCP_KEY: secretLogin,
      ABCP_USERPSW_MD5: secretPassword,
    },
  );

  assert.equal(status, 0);
  assert.match(output, /ABCP конфиг загружен/);
  assert.doesNotMatch(output, new RegExp(secretLogin));
  assert.doesNotMatch(output, new RegExp(secretPassword));
});

test("abcp module: should redact credentials in error logs params", async () => {
  const secretLogin = "abcp-login-secret";
  const secretPassword = "abcp-password-secret";
  const { status, output } = runNodeModuleSnippet(
    `
      const mod = await import("./src/modules/external/pricing/abcp.js");
      await mod.searchManyOEMs(["ABC12345"]);
    `,
    {
      ABCP_DOMAIN: "127.0.0.1:1",
      ABCP_KEY: secretLogin,
      ABCP_USERPSW_MD5: secretPassword,
    },
  );

  assert.equal(status, 0);
  assert.match(output, /Ошибка queryBrands/);
  assert.match(output, /userlogin: '\*\*\*'/);
  assert.match(output, /userpsw: '\*\*\*'/);
  assert.doesNotMatch(output, new RegExp(secretLogin));
  assert.doesNotMatch(output, new RegExp(secretPassword));
});
