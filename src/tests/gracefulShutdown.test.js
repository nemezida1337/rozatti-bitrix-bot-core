import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createGracefulShutdown } from "../core/gracefulShutdown.js";

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.exitCalls = [];
  }

  exit(code) {
    this.exitCalls.push(code);
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("gracefulShutdown: shutdown is idempotent and runs close/hooks once", async () => {
  const calls = [];
  const app = {
    close: async () => {
      calls.push("close");
    },
  };

  const manager = createGracefulShutdown({
    app,
    hooks: [
      async (reason) => {
        calls.push(`hook:${reason}`);
      },
    ],
  });

  await manager.shutdown("manual");
  await manager.shutdown("second-call");

  assert.deepEqual(calls, ["close", "hook:manual"]);
});

test("gracefulShutdown: SIGTERM triggers shutdown and process exit 0", async () => {
  const fakeProcess = new FakeProcess();
  let closeCalls = 0;
  const hookReasons = [];

  const manager = createGracefulShutdown({
    app: {
      close: async () => {
        closeCalls += 1;
      },
    },
    hooks: [
      async (reason) => {
        hookReasons.push(reason);
      },
    ],
    processRef: fakeProcess,
  });

  manager.install();
  manager.install();

  assert.equal(fakeProcess.listenerCount("SIGTERM"), 1);
  assert.equal(fakeProcess.listenerCount("SIGINT"), 1);

  fakeProcess.emit("SIGTERM");
  await tick();
  await tick();

  assert.equal(closeCalls, 1);
  assert.deepEqual(hookReasons, ["SIGTERM"]);
  assert.deepEqual(fakeProcess.exitCalls, [0]);
});

test("gracefulShutdown: failed signal shutdown exits with code 1", async () => {
  const fakeProcess = new FakeProcess();
  const errorLogs = [];
  const logger = {
    info() {},
    warn() {},
    error(ctx, msg) {
      errorLogs.push({ ctx, msg });
    },
  };

  const manager = createGracefulShutdown({
    app: {
      close: async () => {
        throw new Error("close failed");
      },
    },
    logger,
    processRef: fakeProcess,
  });

  manager.install();
  fakeProcess.emit("SIGINT");
  await tick();
  await tick();

  assert.deepEqual(fakeProcess.exitCalls, [1]);
  assert.equal(
    errorLogs.some((x) => x.msg === "Graceful shutdown failed"),
    true,
  );
});

test("gracefulShutdown: shutdown timeout rejects hanging hook", async () => {
  const manager = createGracefulShutdown({
    app: { close: async () => {} },
    hooks: [async () => new Promise(() => {})],
    timeoutMs: 10,
  });

  await assert.rejects(
    manager.shutdown("manual"),
    /shutdown hook #1 timed out after 10ms/,
  );
});
