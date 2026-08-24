import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const css = readFileSync(resolve("public/native/workspace/file-preview-panel.css"), "utf8");

describe("file image preview layout", () => {
  test("caps image width without overflowing narrow preview panels", () => {
    const rule = css.match(/\.file-image-img\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("max-width: min(100%, 640px)");
    expect(rule).toContain("object-fit: contain");
  });
});
