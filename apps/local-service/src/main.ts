import { createLocalServiceRuntime } from "./application/runtime.js";
import { createReminderScheduler } from "./application/reminder-scheduler.js";
import { loadLocalServiceEnv } from "./config/load-local-env.js";
import { createLocalServiceHttpServer } from "./http/server.js";

const boot = async () => {
  loadLocalServiceEnv();

  const port = Number(process.env.APP_PORT ?? "3765");
  const configuredTickMs = Number(process.env.ZHUOCHONG_REMINDER_TICK_MS);
  const reminderTickMs =
    Number.isFinite(configuredTickMs) && configuredTickMs >= 5_000
      ? configuredTickMs
      : undefined;
  const runtime = await createLocalServiceRuntime();
  const server = createLocalServiceHttpServer(runtime);
  const reminderScheduler = createReminderScheduler(runtime, {
    ...(reminderTickMs ? { tickMs: reminderTickMs } : {}),
  });

  const shutdown = () => {
    reminderScheduler.stop();
    server.close();
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  reminderScheduler.start();

  server.listen(port, "127.0.0.1", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[local-service] listening on http://127.0.0.1:${port} (${runtime.storage.mode}${
        runtime.storage.mode === "sqlite"
          ? `: ${runtime.storage.databaseFilePath}`
          : runtime.storage.reason
            ? `: ${runtime.storage.reason}`
            : ""
      })`,
    );
  });
};

void boot().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[local-service] failed to boot", error);
  process.exitCode = 1;
});
