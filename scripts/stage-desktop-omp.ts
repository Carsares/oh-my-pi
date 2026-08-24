#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

const repositoryRoot = path.join(import.meta.dir, "..");
const codingAgentDir = path.join(repositoryRoot, "packages", "coding-agent");
const desktopResourceDir = path.join(repositoryRoot, "apps", "desktop", "src-tauri", "resources", "omp");

interface CodingAgentManifest {
	version: string;
}

function crossTargetOutputName(crossTarget: string | undefined): string {
	return crossTarget ? `omp-${crossTarget}` : "omp";
}

function desktopBinaryName(crossTarget: string | undefined): string {
	const targetPlatform = crossTarget?.split("-", 1)[0] ?? process.platform;
	return targetPlatform === "windows" || targetPlatform === "win32" ? "omp.exe" : "omp";
}

function nativeBuildTarget(crossTarget: string | undefined): string {
	switch (crossTarget) {
		case undefined:
			return "host";
		case "darwin-arm64":
		case "linux-arm64":
			return crossTarget;
		case "darwin-x64":
			return "darwin-x64-baseline";
		case "linux-x64":
			return "linux-x64-baseline";
		case "windows-x64":
		case "win32-x64":
			return "win32-x64-baseline";
		default:
			throw new Error(`Unsupported CROSS_TARGET: ${crossTarget}`);
	}
}

async function existingBuildOutput(baseName: string): Promise<string> {
	const candidates = [
		path.join(codingAgentDir, "dist", baseName),
		path.join(codingAgentDir, "dist", `${baseName}.exe`),
	];
	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(candidate);
			if (stat.isFile()) return candidate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	throw new Error(`OMP build did not produce ${candidates.join(" or ")}`);
}

async function main(): Promise<void> {
	const manifest = (await Bun.file(path.join(codingAgentDir, "package.json")).json()) as CodingAgentManifest;
	if (!manifest.version) throw new Error("coding-agent package has no version");
	const crossTarget = Bun.env.CROSS_TARGET || undefined;
	const nativeTarget = nativeBuildTarget(crossTarget);

	const nativeBuild = Bun.spawn(
		[
			"bun",
			path.join(repositoryRoot, "scripts", "bazel-natives.ts"),
			nativeTarget,
			"--dest",
			path.join(repositoryRoot, "packages", "natives", "native"),
		],
		{
			cwd: repositoryRoot,
			env: Bun.env,
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	const nativeExitCode = await nativeBuild.exited;
	if (nativeExitCode !== 0) throw new Error(`OMP native addon build failed with exit code ${nativeExitCode}`);

	const build = Bun.spawn(["bun", path.join(codingAgentDir, "scripts", "build-binary.ts")], {
		cwd: repositoryRoot,
		env: Bun.env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await build.exited;
	if (exitCode !== 0) throw new Error(`OMP binary build failed with exit code ${exitCode}`);

	const source = await existingBuildOutput(crossTargetOutputName(crossTarget));
	const destination = path.join(desktopResourceDir, desktopBinaryName(crossTarget));
	await fs.rm(desktopResourceDir, { recursive: true, force: true });
	await fs.mkdir(desktopResourceDir, { recursive: true });
	await fs.copyFile(source, destination);
	if (process.platform !== "win32") await fs.chmod(destination, 0o755);
	await Bun.write(path.join(desktopResourceDir, ".version"), `${manifest.version}\n`);

	console.log(`Staged OMP ${manifest.version} at ${path.relative(repositoryRoot, destination)}`);
}

if (import.meta.main) await main();
