import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canReuseStagedOmp, computeFilesFingerprint, OMP_BUILD_INPUTS } from "./stage-desktop-omp";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "picot-omp-staging-"));
	tempDirs.push(dir);
	return dir;
}

describe("desktop OMP staging cache", () => {
	it("tracks OMP build inputs without coupling staging to desktop-only changes", () => {
		expect(OMP_BUILD_INPUTS).toContain("packages");
		expect(OMP_BUILD_INPUTS).toContain("crates");
		expect(OMP_BUILD_INPUTS).toContain("rust-toolchain.toml");
		expect(OMP_BUILD_INPUTS).not.toContain("apps/desktop");
	});

	it("keeps the fingerprint stable until an input changes", async () => {
		const root = await createTempDir();
		await Promise.all([Bun.write(path.join(root, "a.ts"), "alpha"), Bun.write(path.join(root, "b.ts"), "beta")]);

		const first = await computeFilesFingerprint(root, ["b.ts", "a.ts"]);
		expect(await computeFilesFingerprint(root, ["a.ts", "b.ts"])).toBe(first);

		await Bun.write(path.join(root, "a.ts"), "changed");
		expect(await computeFilesFingerprint(root, ["a.ts", "b.ts"])).not.toBe(first);
	});

	it("reuses staging only when the binary, version, and fingerprint all match", async () => {
		const root = await createTempDir();
		const destination = path.join(root, "omp");
		const versionPath = path.join(root, ".version");
		const cachePath = path.join(root, "cache.sha256");
		await Promise.all([
			Bun.write(destination, "binary"),
			Bun.write(versionPath, "1.2.3\n"),
			Bun.write(cachePath, "fingerprint\n"),
		]);

		expect(await canReuseStagedOmp(destination, versionPath, cachePath, "fingerprint", "1.2.3")).toBe(true);
		expect(await canReuseStagedOmp(destination, versionPath, cachePath, "changed", "1.2.3")).toBe(false);
		expect(await canReuseStagedOmp(destination, versionPath, cachePath, "fingerprint", "2.0.0")).toBe(false);
	});
});
