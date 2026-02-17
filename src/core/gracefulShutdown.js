const CTX = "core/gracefulShutdown";

function withTimeout({
  taskName,
  timeoutMs,
  run,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve().then(run);
  }

  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeoutFn(() => {
      if (done) return;
      done = true;
      reject(new Error(`${taskName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    Promise.resolve()
      .then(run)
      .then((result) => {
        if (done) return;
        done = true;
        clearTimeoutFn(timer);
        resolve(result);
      })
      .catch((err) => {
        if (done) return;
        done = true;
        clearTimeoutFn(timer);
        reject(err);
      });
  });
}

export function createGracefulShutdown({
  app,
  logger,
  hooks = [],
  timeoutMs = 10_000,
  processRef = process,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const safeLogger = logger || {
    info() {},
    warn() {},
    error() {},
  };

  const hookList = Array.isArray(hooks) ? hooks.filter(Boolean) : [];

  let installed = false;
  let exitRequested = false;
  let shutdownPromise = null;

  const runSignalShutdown = async (signal) => {
    try {
      await shutdown(signal);
      if (!exitRequested) {
        exitRequested = true;
        processRef.exit(0);
      }
    } catch (err) {
      if (!exitRequested) {
        exitRequested = true;
        safeLogger.error(
          { ctx: CTX, signal, err: String(err) },
          "Graceful shutdown failed",
        );
        processRef.exit(1);
      }
    }
  };

  const signalHandlers = {
    SIGTERM: () => runSignalShutdown("SIGTERM"),
    SIGINT: () => runSignalShutdown("SIGINT"),
  };

  function install() {
    if (installed) return;
    installed = true;
    processRef.on("SIGTERM", signalHandlers.SIGTERM);
    processRef.on("SIGINT", signalHandlers.SIGINT);
  }

  function dispose() {
    if (!installed) return;
    installed = false;
    processRef.off("SIGTERM", signalHandlers.SIGTERM);
    processRef.off("SIGINT", signalHandlers.SIGINT);
  }

  function shutdown(reason = "manual") {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      safeLogger.info({ ctx: CTX, reason }, "Shutdown started");

      try {
        if (app && typeof app.close === "function") {
          await withTimeout({
            taskName: "app.close",
            timeoutMs,
            run: () => app.close(),
            setTimeoutFn,
            clearTimeoutFn,
          });
        }

        for (let i = 0; i < hookList.length; i += 1) {
          const hook = hookList[i];
          await withTimeout({
            taskName: `shutdown hook #${i + 1}`,
            timeoutMs,
            run: () => hook(reason),
            setTimeoutFn,
            clearTimeoutFn,
          });
        }

        safeLogger.info({ ctx: CTX, reason }, "Shutdown completed");
      } finally {
        dispose();
      }
    })();

    return shutdownPromise;
  }

  return {
    install,
    dispose,
    shutdown,
  };
}

export default {
  createGracefulShutdown,
};
