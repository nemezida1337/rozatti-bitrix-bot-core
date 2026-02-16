import assert from "node:assert/strict";
import test from "node:test";

import { logger } from "../core/logger.js";

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
  process.env.ABCP_DOMAIN = "example.abcp.test";
  process.env.ABCP_KEY = "abcp-login-secret";
  process.env.ABCP_USERPSW_MD5 = "abcp-password-secret";

  const infoCalls = [];
  const originalInfo = logger.info;
  logger.info = (ctxOrMsg, maybeMsg) => {
    infoCalls.push({ ctxOrMsg, maybeMsg });
    return originalInfo(ctxOrMsg, maybeMsg);
  };

  try {
    await import(`../modules/external/pricing/abcp.js?audit=${Date.now()}`);

    const configLog = infoCalls.find(
      (x) => x.maybeMsg === "ABCP конфиг загружен",
    );
    assert.ok(configLog, "Expected ABCP startup config log");

    const ctx = configLog.ctxOrMsg || {};
    assert.equal(
      Object.prototype.hasOwnProperty.call(ctx, "ABCP_LOGIN"),
      false,
      "ABCP_LOGIN must not be included in logs",
    );
  } finally {
    logger.info = originalInfo;
  }
});

test("abcp module: should redact credentials in error logs params", async () => {
  process.env.ABCP_DOMAIN = "127.0.0.1:1";
  process.env.ABCP_KEY = "abcp-login-secret";
  process.env.ABCP_USERPSW_MD5 = "abcp-password-secret";

  const errorCalls = [];
  const originalError = logger.error;
  logger.error = (ctxOrMsg, maybeMsg) => {
    errorCalls.push({ ctxOrMsg, maybeMsg });
    return originalError(ctxOrMsg, maybeMsg);
  };

  try {
    const mod = await import(`../modules/external/pricing/abcp.js?audit=${Date.now()}-err`);
    await mod.searchManyOEMs(["ABC12345"]);

    const brandsError = errorCalls.find((x) => x.maybeMsg === "Ошибка queryBrands");
    assert.ok(brandsError, "Expected queryBrands error log");

    const params = brandsError.ctxOrMsg?.params || {};
    assert.equal(params.userpsw, "***");
    assert.equal(params.userlogin, "***");
    assert.notEqual(params.userpsw, "abcp-password-secret");
    assert.notEqual(params.userlogin, "abcp-login-secret");
  } finally {
    logger.error = originalError;
  }
});
