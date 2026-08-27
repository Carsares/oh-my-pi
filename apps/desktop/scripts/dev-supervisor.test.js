import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEV_RESTART_MARKER_ENV, runDevSupervisor } from "./dev-supervisor.js";

describe("Picot development supervisor", () => {
  test("fast-restarts the existing debug binary after the initial Tauri launch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "picot-dev-supervisor-test-"));
    const markerPath = join(directory, "restart");
    const binaryPath = join(directory, "picot");
    writeFileSync(binaryPath, "compiled");
    const calls = [];

    const result = await runDevSupervisor({
      markerPath,
      binaryPath,
      environment: { PATH: "/usr/bin" },
      spawnProcess(command, args, options) {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        queueMicrotask(() => {
          if (calls.length === 1) writeFileSync(markerPath, "fast\n");
          child.emit("close", calls.length === 1 ? 0 : 7, null);
        });
        return child;
      },
    });

    expect(result).toBe(7);
    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe("tauri");
    expect(calls[0].args).toEqual(["dev"]);
    expect(calls[1].command).toBe(binaryPath);
    expect(calls[1].args).toEqual([]);
    expect(calls[0].options.env[DEV_RESTART_MARKER_ENV]).toBe(markerPath);
    expect(calls[0].options.env.PATH.split(":")[0]).toContain("/.cargo/bin");
  });

  test("performs a complete Tauri restart when explicitly requested", async () => {
    const directory = mkdtempSync(join(tmpdir(), "picot-dev-supervisor-full-"));
    const markerPath = join(directory, "restart");
    const binaryPath = join(directory, "picot");
    writeFileSync(binaryPath, "compiled");
    const calls = [];

    const result = await runDevSupervisor({
      markerPath,
      binaryPath,
      spawnProcess(command, args) {
        calls.push({ command, args });
        const child = new EventEmitter();
        queueMicrotask(() => {
          if (calls.length === 1) writeFileSync(markerPath, "full\n");
          child.emit("close", calls.length === 1 ? 0 : 6, null);
        });
        return child;
      },
    });

    expect(result).toBe(6);
    expect(calls).toEqual([
      { command: "tauri", args: ["dev"] },
      { command: "tauri", args: ["dev"] },
    ]);
  });

  test("falls back to a complete Tauri restart when the debug binary is missing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "picot-dev-supervisor-fallback-"));
    const markerPath = join(directory, "restart");
    const calls = [];

    const result = await runDevSupervisor({
      markerPath,
      binaryPath: join(directory, "missing-picot"),
      spawnProcess(command, args) {
        calls.push({ command, args });
        const child = new EventEmitter();
        queueMicrotask(() => {
          if (calls.length === 1) writeFileSync(markerPath, "fast\n");
          child.emit("close", calls.length === 1 ? 0 : 5, null);
        });
        return child;
      },
    });

    expect(result).toBe(5);
    expect(calls).toEqual([
      { command: "tauri", args: ["dev"] },
      { command: "tauri", args: ["dev"] },
    ]);
  });

  test("returns the normal Tauri exit code when no restart was requested", async () => {
    const child = new EventEmitter();
    const resultPromise = runDevSupervisor({
      markerPath: join(tmpdir(), "picot-dev-supervisor-no-restart", "restart"),
      spawnProcess() {
        queueMicrotask(() => child.emit("close", 3, null));
        return child;
      },
    });

    await expect(resultPromise).resolves.toBe(3);
  });

  test("preserves signal-based exits when no restart was requested", async () => {
    const child = new EventEmitter();
    const resultPromise = runDevSupervisor({
      markerPath: join(tmpdir(), "picot-dev-supervisor-signal", "restart"),
      spawnProcess() {
        queueMicrotask(() => child.emit("close", null, "SIGINT"));
        return child;
      },
    });

    await expect(resultPromise).resolves.toBe(130);
  });
});
