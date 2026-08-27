import { describe, expect, it } from "vitest";
import { DEV_PREPARATION_TASKS, prepareDev } from "./prepare-dev";

describe("development preparation", () => {
  it("starts every independent task before waiting for completion", async () => {
    const started = [];
    const gates = new Map(
      DEV_PREPARATION_TASKS.map((task) => [task.script, Promise.withResolvers()]),
    );

    const preparation = prepareDev((task) => {
      started.push(task.script);
      return gates.get(task.script).promise;
    });

    expect(started).toEqual(DEV_PREPARATION_TASKS.map((task) => task.script));
    for (const gate of gates.values()) gate.resolve();
    await expect(preparation).resolves.toBeUndefined();
  });

  it("reports every failed task after all tasks settle", async () => {
    await expect(
      prepareDev(async (task) => {
        if (task.script === "stage:omp:dev" || task.script === "build:frontend") {
          throw new Error(`${task.script} failed`);
        }
      }),
    ).rejects.toThrow(/OMP staging: stage:omp:dev failed[\s\S]*frontend: build:frontend failed/);
  });
});
