#!/usr/bin/env bun

import * as path from "node:path";

export interface DevPreparationTask {
  label: string;
  script: string;
}

export const DEV_PREPARATION_TASKS: readonly DevPreparationTask[] = [
  { label: "OMP staging", script: "stage:omp:dev" },
  { label: "terminal font", script: "fetch:terminal-font" },
  { label: "CJK font", script: "fetch:cjk-font" },
  { label: "extensions", script: "build:extensions" },
  { label: "frontend", script: "build:frontend" },
];

export type DevPreparationRunner = (task: DevPreparationTask) => Promise<void>;

async function execTask(task: DevPreparationTask): Promise<void> {
  const startedAt = performance.now();
  console.log(`[prepare-dev] starting ${task.label}`);
  const child = Bun.spawn([process.execPath, "run", task.script], {
    cwd: path.join(import.meta.dir, ".."),
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${task.label} failed with exit code ${exitCode}`);
  console.log(
    `[prepare-dev] completed ${task.label} in ${Math.round(performance.now() - startedAt)}ms`,
  );
}

export async function prepareDev(runner: DevPreparationRunner = execTask): Promise<void> {
  const results = await Promise.allSettled(DEV_PREPARATION_TASKS.map((task) => runner(task)));
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          `${DEV_PREPARATION_TASKS[index].label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        ]
      : [],
  );
  if (failures.length > 0)
    throw new Error(`Development preparation failed:\n${failures.join("\n")}`);
}

if (import.meta.main) await prepareDev();
