// ABOUTME: Keeps the complete Tauri development process restartable from Picot's menu.
// ABOUTME: The native debug binary writes a marker before exiting so this supervisor can rerun it.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { homedir, constants as osConstants, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export const DEV_RESTART_MARKER_ENV = "PICOT_DEV_RESTART_MARKER";

function developmentEnvironment(environment) {
  const cargoBin = join(homedir(), ".cargo", "bin");
  const pathEntries = (environment.PATH ?? "").split(delimiter).filter(Boolean);
  if (!pathEntries.includes(cargoBin)) pathEntries.unshift(cargoBin);
  return { ...environment, PATH: pathEntries.join(delimiter) };
}

function waitForProcess(child) {
  return new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal }));
  });
}

function exitCodeForResult({ code, signal }) {
  if (Number.isInteger(code)) return code;
  if (signal) {
    const signalNumber = osConstants.signals?.[signal];
    if (Number.isInteger(signalNumber)) return 128 + signalNumber;
  }
  return 1;
}

export async function runDevSupervisor({
  spawnProcess = spawn,
  environment = process.env,
  markerPath = null,
  command = process.platform === "win32" ? "tauri.cmd" : "tauri",
  binaryPath = resolve(
    import.meta.dirname,
    "..",
    "target",
    "debug",
    process.platform === "win32" ? "picot.exe" : "picot",
  ),
} = {}) {
  const markerDirectory = markerPath ? null : mkdtempSync(join(tmpdir(), "picot-dev-restart-"));
  const restartMarker = markerPath ?? join(markerDirectory, "restart");
  const childEnvironment = developmentEnvironment({
    ...environment,
    [DEV_RESTART_MARKER_ENV]: restartMarker,
  });
  let launchCommand = command;
  let launchArgs = ["dev"];

  try {
    while (true) {
      if (existsSync(restartMarker)) unlinkSync(restartMarker);

      const child = spawnProcess(launchCommand, launchArgs, {
        cwd: resolve(import.meta.dirname, ".."),
        env: childEnvironment,
        stdio: "inherit",
      });
      const result = await waitForProcess(child);

      if (!existsSync(restartMarker)) return exitCodeForResult(result);
      const restartMode = readFileSync(restartMarker, "utf8").trim();
      if (restartMode === "full") {
        console.info("[picot-dev] complete restart requested; rebuilding through Tauri");
        launchCommand = command;
        launchArgs = ["dev"];
      } else if (existsSync(binaryPath)) {
        console.info(`[picot-dev] fast restart from existing binary: ${binaryPath}`);
        launchCommand = binaryPath;
        launchArgs = [];
      } else {
        console.info("[picot-dev] debug binary missing; falling back to a complete Tauri restart");
        launchCommand = command;
        launchArgs = ["dev"];
      }
    }
  } finally {
    if (markerDirectory) rmSync(markerDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runDevSupervisor()
    .then((exitCode) => process.exit(exitCode))
    .catch((error) => {
      console.error(
        `[picot-dev] failed to supervise Tauri: ${error instanceof Error ? error.message : error}`,
      );
      process.exit(1);
    });
}
