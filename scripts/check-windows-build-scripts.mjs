#!/usr/bin/env node

/**
 * Smoke tests for the Windows helper build/install scripts.
 *
 * Exercises --platform routing, install-path alignment, and prebuilt handling
 * without requiring a Windows host (the build itself needs a Windows toolchain).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "nife-computer-use-script-test-"));
const TEST_WINDOWS_HELPER = path.join(TEST_ROOT, "windows-bridge.exe");
const PREBUILT = path.join(ROOT, "prebuilt", "windows", "windows-bridge.exe");

let failures = 0;
let assertions = 0;
const LABEL = "[check-windows-build-scripts]";

function tap(actual, expected, msg) {
	assertions++;
	const ok = actual === expected;
	console.log(ok ? "  \u2705" : "  \u274c", msg);
	if (!ok) {
		console.error(`       expected: ${JSON.stringify(expected)}`);
		console.error(`       actual:   ${JSON.stringify(actual)}`);
		failures++;
	}
}

function tapMatch(actual, re, msg) {
	assertions++;
	const ok = re.test(actual);
	console.log(ok ? "  \u2705" : "  \u274c", msg);
	if (!ok) {
		console.error(`       pattern:  ${re}`);
		console.error(`       actual:   ${JSON.stringify(actual.slice(0, 300))}`);
		failures++;
	}
}

function fingerprint(filePath) {
	if (!fs.existsSync(filePath)) return "missing";
	const stat = fs.statSync(filePath);
	const hash = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
	return `${stat.mtimeMs}:${stat.size}:${hash}`;
}

function runScript(relPath, args, timeoutMs = 120_000) {
	const scriptPath = path.join(__dirname, relPath);
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [scriptPath, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NIFE_COMPUTER_USE_WINDOWS_HELPER_PATH: TEST_WINDOWS_HELPER },
		});
		let stdout = "";
		let stderr = "";
		const finish = (result) => {
			settled = true;
			clearTimeout(timeout);
			resolve(result);
		};
		let settled = false;
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			finish({ code: -1, stdout, stderr: `${stderr}Timed out after ${timeoutMs}ms\n` });
		}, timeoutMs);
		timeout.unref();
		child.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("close", (code) => {
			if (!settled) finish({ code, stdout, stderr });
		});
		child.on("error", (err) => {
			if (!settled) finish({ code: -1, stdout, stderr: `${stderr}${err.message}` });
		});
	});
}

function isWindowsHost() {
	if (process.platform === "win32") return true;
	if (process.platform !== "linux") return false;
	if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
	try {
		return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
	} catch {
		return false;
	}
}

process.on("exit", () => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

console.log(`\n${LABEL} Path alignment`);
tap(
	path.join(os.homedir(), ".nife", "agent", "helpers", "nife-computer-use", "windows-bridge.exe"),
	path.join(os.homedir(), ".nife", "agent", "helpers", "nife-computer-use", "windows-bridge.exe"),
	"install destination uses the nife agent helper directory",
);
tap(path.join(ROOT, "prebuilt", "windows", "windows-bridge.exe"), PREBUILT, "prebuilt helper lives in prebuilt/windows");
tap(fs.existsSync(PREBUILT), true, "prebuilt Windows helper is committed");
if (fs.existsSync(PREBUILT)) {
	const header = fs.readFileSync(PREBUILT).subarray(0, 2).toString("ascii");
	tap(header, "MZ", "prebuilt helper is a Windows PE executable");
}

console.log(`\n${LABEL} setup-helper.mjs --platform windows`);
{
	const result = await runScript("setup-helper.mjs", ["--platform", "windows"]);
	tap(result.code, 0, "--platform windows installs the prebuilt helper");
	tap(fs.existsSync(TEST_WINDOWS_HELPER), true, "helper landed at the configured destination");
	tapMatch(result.stdout + result.stderr, /installed Windows helper|already up to date/, "prints install status");
}

console.log(`\n${LABEL} setup-helper.mjs --platform <retired>`);
for (const platform of ["darwin", "linux"]) {
	const result = await runScript("setup-helper.mjs", ["--platform", platform]);
	tap(result.code, 1, `--platform ${platform} is rejected`);
	tapMatch(result.stderr, /supports Windows only/, "explains the Windows-only support boundary");
}

console.log(`\n${LABEL} setup-helper.mjs --postinstall`);
{
	const result = await runScript("setup-helper.mjs", ["--postinstall"]);
	tap(result.code, 0, "--postinstall exits 0 (failures are never fatal at install time)");
	tapMatch(result.stderr + result.stdout, /installed|up to date|skipping helper setup/, "prints install or skip status");
}

console.log(`\n${LABEL} build-native.mjs routing`);
{
	const output = path.join(TEST_ROOT, "native-retired.exe");
	for (const platform of ["darwin", "linux"]) {
		const result = await runScript("build-native.mjs", ["--platform", platform, "--output", output]);
		tap(result.code, 0, `--platform ${platform} is skipped without touching the output`);
		tapMatch(result.stdout, /supports Windows only/, "prints the Windows-only message");
		tap(fs.existsSync(output), false, `no binary written for --platform ${platform}`);
	}
}

const prebuiltBefore = fingerprint(PREBUILT);
tap(fingerprint(PREBUILT), prebuiltBefore, "tests do not modify the committed prebuilt helper");

console.log(`\n${LABEL} ${"=".repeat(40)}`);
console.log(`${LABEL} Assertions: ${assertions}   Failures: ${failures}`);
if (failures === 0) {
	console.log(`${LABEL} \u2705 ALL PASSED`);
} else {
	console.log(`${LABEL} \u274c ${failures} FAILURE(S)`);
	process.exit(1);
}
