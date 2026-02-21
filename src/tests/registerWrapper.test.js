import assert from "node:assert/strict";
import test from "node:test";

import { processIncomingBitrixMessage } from "../modules/bot/handler/index.js";
import * as core from "../modules/bot/register.core.js";
import registerDefault, {
  ensureBotRegistered,
  handleOnImBotMessageAdd,
  handleOnImCommandAdd,
  resolveRegisterExports,
} from "../modules/bot/register.js";

test("register wrapper: re-exports expected handlers", () => {
  assert.equal(handleOnImBotMessageAdd, processIncomingBitrixMessage);
  assert.equal(ensureBotRegistered, core.ensureBotRegistered);
  assert.equal(handleOnImCommandAdd, core.handleOnImCommandAdd);
});

test("register wrapper: default export stays undefined when core has no default export", () => {
  assert.equal(registerDefault, undefined);
});

test("register wrapper: resolveRegisterExports builds fallback handlers when core handlers are missing", async () => {
  const llmHandler = () => "llm";
  const resolved = resolveRegisterExports({}, llmHandler);

  assert.equal(typeof resolved.ensureBotRegistered, "function");
  assert.equal(typeof resolved.handleOnImCommandAdd, "function");
  assert.equal(resolved.defaultExport, undefined);

  const originalWarn = console.warn;
  const warns = [];
  console.warn = (...args) => warns.push(args);
  try {
    await resolved.ensureBotRegistered("portal.test");
    await resolved.handleOnImCommandAdd("portal.test");
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warns.length, 2);
  assert.match(String(warns[0][0]), /ensureBotRegistered not found/);
  assert.match(String(warns[1][0]), /handleOnImCommandAdd not found/);
});

test("register wrapper: resolveRegisterExports composes default export object", () => {
  const llmHandler = () => "llm";
  const coreDefaultEnsure = async () => "default-ensure";
  const coreDefaultCommand = async () => "default-command";
  const coreNamedEnsure = async () => "named-ensure";

  const resolved = resolveRegisterExports(
    {
      ensureBotRegistered: coreNamedEnsure,
      default: {
        ensureBotRegistered: coreDefaultEnsure,
        handleOnImCommandAdd: coreDefaultCommand,
      },
    },
    llmHandler,
  );

  assert.equal(resolved.ensureBotRegistered, coreNamedEnsure);
  assert.equal(resolved.handleOnImCommandAdd, coreDefaultCommand);
  assert.equal(resolved.defaultExport.handleOnImBotMessageAdd, llmHandler);
  assert.equal(resolved.defaultExport.ensureBotRegistered, coreNamedEnsure);
  assert.equal(resolved.defaultExport.handleOnImCommandAdd, coreDefaultCommand);
});
