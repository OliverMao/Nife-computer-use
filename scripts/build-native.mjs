#!/usr/bin/env node

/**
 * Build the Windows helper (native helper for nife-computer-use).
 *
 * Run on Windows directly, or inside WSL where the script uses the Windows
 * toolchain (`cargo.exe`) to produce a Windows PE binary. The result is copied
 * to prebuilt/windows/windows-bridge.exe, which setup-helper.mjs installs.
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windowsCrateDir = path.join(rootDir, "native", "windows", "bridge-rs");
const defaultOutput = path.join(rootDir, "prebuilt", "windows", "windows-bridge.exe");

function getArg(name) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
	return undefined;
}

function isWslHost() {
	if (process.platform !== "linux") return false;
	if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
	try {
		return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
	} catch {
		return false;
	}
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit", ...options });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}`));
		});
	});
}

/** Resolve a cargo executable that targets Windows. */
async function resolveWindowsCargo() {
	const explicit = process.env.NIFE_WINDOWS_CARGO;
	if (explicit) return explicit;
	if (process.platform === "win32") return "cargo";

	const onPath = await execFileAsync("which", ["cargo.exe"]).then(
		({ stdout }) => stdout.trim(),
		() => "",
	);
	if (onPath) return onPath;

	const usersDir = "/mnt/c/Users";
	const users = await fs.readdir(usersDir).catch(() => []);
	for (const user of users) {
		const candidate = path.join(usersDir, user, ".cargo", "bin", "cargo.exe");
		if (await exists(candidate)) return candidate;
	}
	throw new Error(
		"Could not find cargo.exe. Install the Rust toolchain for Windows, set NIFE_WINDOWS_CARGO to cargo.exe, or build on Windows.",
	);
}

/** Translate a WSL path to the Windows path a Windows program can open. */
async function toWindowsPath(unixPath) {
	const { stdout } = await execFileAsync("wslpath", ["-w", unixPath]);
	return stdout.trim();
}

/** Path of the Windows temp directory, translated for use from WSL. */
async function windowsTempDir() {
	const { stdout } = await execFileAsync("cmd.exe", ["/c", "echo", "%TEMP%"]);
	const raw = stdout.trim();
	if (!raw || raw.includes("%TEMP%")) return undefined;
	const { stdout: unixPath } = await execFileAsync("wslpath", ["-u", raw]);
	return unixPath.trim();
}

async function copyCrate(destination) {
	await fs.rm(destination, { recursive: true, force: true });
	await fs.mkdir(destination, { recursive: true });
	await fs.cp(windowsCrateDir, destination, {
		recursive: true,
		filter: (source) => !source.includes(`${path.sep}target`),
	});
	return destination;
}

async function verifyWindowsExecutable(filePath) {
	const handle = await fs.open(filePath, "r");
	try {
		const signature = Buffer.alloc(2);
		await handle.read(signature, 0, 2, 0);
		if (signature.toString("ascii") !== "MZ") {
			throw new Error(`Output is not a Windows PE executable: ${filePath}`);
		}
	} finally {
		await handle.close();
	}
}

async function buildWindowsHelper(outputPath) {
	const cargo = await resolveWindowsCargo();
	const target = getArg("--target");

	console.log(`Building Windows helper with ${cargo}...`);

	let crateDir = windowsCrateDir;
	let manifestPath = path.join(crateDir, "Cargo.toml");
	let cleanupDir;
	if (process.platform !== "win32") {
		const tempRoot = await windowsTempDir().catch(() => undefined);
		if (!tempRoot) {
			throw new Error("Could not resolve the Windows temp directory from WSL; build on Windows instead.");
		}
		crateDir = path.join(tempRoot, "nife-computer-use-windows-build", "bridge-rs");
		console.log(`Copying crate to ${crateDir}`);
		await copyCrate(crateDir);
		manifestPath = await toWindowsPath(path.join(crateDir, "Cargo.toml"));
		cleanupDir = path.dirname(crateDir);
	}

	try {
		const cargoArgs = ["build", "--release", "--manifest-path", manifestPath];
		if (target) cargoArgs.push("--target", target);
		await run(cargo, cargoArgs);

		const releaseDir = target
			? path.join(crateDir, "target", target, "release")
			: path.join(crateDir, "target", "release");
		const exePath = path.join(releaseDir, "windows-bridge.exe");
		if (!(await exists(exePath))) {
			throw new Error(`Cargo did not produce ${exePath}.`);
		}
		await verifyWindowsExecutable(exePath);

		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await fs.copyFile(exePath, outputPath);
		await fs.chmod(outputPath, 0o755).catch(() => undefined);
		console.log(`Built Windows helper at ${outputPath}`);
	} finally {
		if (cleanupDir) await fs.rm(cleanupDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function main() {
	const explicitPlatform = getArg("--platform");
	if (explicitPlatform !== undefined && explicitPlatform !== "windows") {
		console.log(
			`Skipping native build: nife-computer-use supports Windows only; '${explicitPlatform}' is not supported.`,
		);
		return;
	}
	if (explicitPlatform === undefined && process.platform !== "win32" && !isWslHost()) {
		console.log(
			`Skipping native build: this platform (${process.platform}) is not Windows or WSL. ` +
				"Use --platform windows to force a build.",
		);
		return;
	}

	const outputArg = getArg("--output");
	const outputPath = outputArg ? path.resolve(process.cwd(), outputArg) : defaultOutput;
	await buildWindowsHelper(outputPath);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
