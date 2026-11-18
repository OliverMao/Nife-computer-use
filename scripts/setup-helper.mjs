#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildNativeScript = path.join(rootDir, "scripts", "build-native.mjs");
const prebuiltWindowsPath = path.join(rootDir, "prebuilt", "windows", "windows-bridge.exe");
const windowsHelperDestPath =
	process.env.NIFE_COMPUTER_USE_WINDOWS_HELPER_PATH ||
	path.join(os.homedir(), ".nife", "agent", "helpers", "nife-computer-use", "windows-bridge.exe");

const args = new Set(process.argv.slice(2));
const isPostinstall = args.has("--postinstall");
const allowBuild =
	args.has("--allow-build") || args.has("--runtime") || process.env.NIFE_COMPUTER_USE_ALLOW_BUILD === "1";

function getArg(name) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
	return undefined;
}

/** True when nife runs on a Linux kernel provided by WSL, where Windows PE binaries can be started through interop. */
function isWslHost() {
	if (process.platform !== "linux") return false;
	if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
	try {
		return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
	} catch {
		return false;
	}
}

function isWindowsHost() {
	return process.platform === "win32" || isWslHost();
}

async function exists(filePath) {
	try {
		await fs.access(filePath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function hashFile(filePath) {
	const data = await fs.readFile(filePath);
	return createHash("sha256").update(data).digest("hex");
}

async function copyIfChanged(sourcePath, destinationPath) {
	if (await exists(destinationPath)) {
		const [sourceHash, destinationHash] = await Promise.all([hashFile(sourcePath), hashFile(destinationPath)]);
		if (sourceHash === destinationHash) {
			await fs.chmod(destinationPath, 0o755).catch(() => undefined);
			return { changed: false };
		}
	}
	await fs.mkdir(path.dirname(destinationPath), { recursive: true });
	await fs.copyFile(sourcePath, destinationPath);
	await fs.chmod(destinationPath, 0o755).catch(() => undefined);
	return { changed: true };
}

async function run(command, commandArgs) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`Command failed (${code}): ${command} ${commandArgs.join(" ")}`));
		});
	});
}

async function setupWindowsHelper() {
	if (!(await exists(prebuiltWindowsPath)) && allowBuild) {
		console.log("[nife-computer-use] Windows prebuilt helper missing; building from source...");
		await run(process.execPath, [buildNativeScript, "--platform", "windows"]);
	}

	if (!(await exists(prebuiltWindowsPath))) {
		throw new Error(
			`No Windows prebuilt helper found at ${prebuiltWindowsPath}. ` +
				"Run 'node scripts/build-native.mjs --platform windows' to build it, or set NIFE_COMPUTER_USE_ALLOW_BUILD=1 to build at install time.",
		);
	}

	const { changed } = await copyIfChanged(prebuiltWindowsPath, windowsHelperDestPath);
	console.log(
		changed
			? `[nife-computer-use] installed Windows helper at ${windowsHelperDestPath}`
			: `[nife-computer-use] Windows helper already up to date at ${windowsHelperDestPath}`,
	);
}

async function setup() {
	const explicitPlatform = getArg("--platform");
	if (explicitPlatform !== undefined && explicitPlatform !== "windows") {
		throw new Error(
			`nife-computer-use supports Windows only; '${explicitPlatform}' is not supported. Use --platform windows.`,
		);
	}
	if (explicitPlatform === "windows" || isWindowsHost()) {
		await setupWindowsHelper();
		return;
	}
	throw new Error(
		"nife-computer-use supports Windows only. Run nife on Windows or inside WSL to install the Windows helper.",
	);
}

if (isPostinstall && !isWindowsHost()) {
	console.warn(
		`[nife-computer-use] skipping helper setup: this platform (${process.platform}) is not Windows. ` +
			"Run nife on Windows or inside WSL, then use /computer-use to install the helper.",
	);
} else {
	try {
		await setup();
	} catch (error) {
		if (!isPostinstall) throw error;
		console.warn(`[nife-computer-use] postinstall helper setup skipped: ${error instanceof Error ? error.message : String(error)}`);
	}
}
