// ABOUTME: Locks Picot's audited OMP RPC and session fixture versions to the monorepo runtime.
// ABOUTME: Fails when an OMP version bump is not accompanied by a reviewed desktop contract fixture.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const ompPackage = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "packages", "coding-agent", "package.json"), "utf8"),
);
const contractPath = path.join(
  desktopRoot,
  "tests",
  "fixtures",
  "omp-rpc",
  ompPackage.version,
  "contract.json",
);

describe("OMP desktop compatibility fixtures", () => {
  test("pins an audited RPC contract to the current OMP version", () => {
    expect(fs.existsSync(contractPath)).toBe(true);
    const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));

    expect(contract.version).toBe(ompPackage.version);
    expect(contract.binary).toBe("omp");
    expect(contract.commands).toEqual(
      expect.arrayContaining(["get_available_commands", "get_available_models", "branch"]),
    );
    expect(contract.stateFields).toContain("queuedMessageCount");
    expect(contract.stateFields).not.toContain("pendingMessageCount");
  });

  test("uses the current OMP v3 branched session shape", () => {
    const fixturePath = path.join(
      desktopRoot,
      "tests",
      "fixtures",
      "omp-session",
      "v3",
      "branched-session.jsonl",
    );
    const entries = fs
      .readFileSync(fixturePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(entries[0]).toMatchObject({ type: "session", version: 3 });
    expect(entries.filter((entry) => entry.type === "message")).toHaveLength(4);
    expect(entries[3].parentId).toBe(entries[1].id);
    expect(entries.at(-1)).toMatchObject({ type: "session_info", name: "OMP desktop fixture" });
  });
});
