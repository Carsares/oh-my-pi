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

function crossTargetMatchesHost(crossTarget: string | undefined): boolean {
	if (!crossTarget) return true;
	const [platform, arch] = crossTarget.split("-");
	const hostPlatform = process.platform === "win32" ? "windows" : process.platform;
	const targetPlatform = platform === "win32" ? "windows" : platform;
	return targetPlatform === hostPlatform && arch === process.arch;
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

async function run(command: string[], env: Record<string, string | undefined>, label: string): Promise<void> {
	const process = Bun.spawn(command, {
		cwd: repositoryRoot,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await process.exited;
	if (exitCode !== 0) throw new Error(`${label} failed with exit code ${exitCode}`);
}

async function buildOmp(crossTarget: string | undefined): Promise<string> {
	const env = { ...Bun.env };
	if (crossTarget) env.CROSS_TARGET = crossTarget;
	else delete env.CROSS_TARGET;
	const nativeTarget = crossTargetMatchesHost(crossTarget) ? "host" : nativeBuildTarget(crossTarget);
	await run(
		[
			"bun",
			path.join(repositoryRoot, "scripts", "bazel-natives.ts"),
			nativeTarget,
			"--dest",
			path.join(repositoryRoot, "packages", "natives", "native"),
		],
		env,
		"OMP native addon build",
	);
	await run(["bun", path.join(codingAgentDir, "scripts", "build-binary.ts")], env, "OMP binary build");
	return existingBuildOutput(crossTargetOutputName(crossTarget));
}

async function main(): Promise<void> {
	const manifest = (await Bun.file(path.join(codingAgentDir, "package.json")).json()) as CodingAgentManifest;
	if (!manifest.version) throw new Error("coding-agent package has no version");
	const crossTarget = Bun.env.CROSS_TARGET || undefined;
	const destination = path.join(desktopResourceDir, desktopBinaryName(crossTarget));
	await fs.rm(desktopResourceDir, { recursive: true, force: true });
	await fs.mkdir(desktopResourceDir, { recursive: true });
	if (crossTarget === "darwin-universal") {
		const arm64 = await buildOmp("darwin-arm64");
		const x64 = await buildOmp("darwin-x64");
		await run(["lipo", "-create", "-output", destination, arm64, x64], Bun.env, "Universal OMP merge");
	} else {
		await fs.copyFile(await buildOmp(crossTarget), destination);
	}
	if (process.platform !== "win32") await fs.chmod(destination, 0o755);
	await Bun.write(path.join(desktopResourceDir, ".version"), `${manifest.version}\n`);

	console.log(`Staged OMP ${manifest.version} at ${path.relative(repositoryRoot, destination)}`);
}

if (import.meta.main) await main();
