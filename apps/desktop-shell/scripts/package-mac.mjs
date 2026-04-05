import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);

const electronPackageJsonPath = require.resolve("electron/package.json");
const electronDist = join(dirname(electronPackageJsonPath), "dist");
const extraArgs = process.argv.slice(2);

const child = spawn(
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
  [
    "--mac",
    ...extraArgs,
    `-c.electronDist=${electronDist}`,
  ],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
