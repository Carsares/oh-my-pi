// ABOUTME: Verifies the OMP RPC smoke test derives its fixture version from the monorepo runtime.
// ABOUTME: Ensures every bundled OMP version has an audited RPC contract fixture.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const ompVersion = JSON.parse(read("../../packages/coding-agent/package.json")).version;

describe("OMP RPC smoke contract", () => {
  test("derives the contract version and fixture path from the monorepo runtime", () => {
    const smokeSource = read("scripts/smoke-omp-rpc.js");

    expect(smokeSource).toContain('packages", "coding-agent", "package.json');
    expect(smokeSource).not.toContain('"18.0.4"');
  });

  test("includes a contract fixture for the bundled OMP version", () => {
    const fixture = path.join(root, "tests", "fixtures", "omp-rpc", ompVersion, "contract.json");

    expect(fs.existsSync(fixture)).toBe(true);
    expect(JSON.parse(fs.readFileSync(fixture, "utf8")).version).toBe(ompVersion);
  });
});
