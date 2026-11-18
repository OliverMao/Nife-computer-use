#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	assertPlatformArchitecture,
	PLATFORM_ARCHITECTURE_VERSION,
	REQUIRED_PLATFORM_INVARIANTS,
} from "../src/platform/architecture.ts";

const helperOverride = path.join(os.tmpdir(), "custom-windows-bridge.exe");
process.env.NIFE_COMPUTER_USE_WINDOWS_HELPER_PATH = helperOverride;

const [{ platformBackendForRuntime }, { WINDOWS_HELPER_PATH }] = await Promise.all([
	import("../src/platform/index.ts"),
	import("../src/platform/windows/helper.ts"),
]);

assert.equal(WINDOWS_HELPER_PATH, helperOverride);

const win = platformBackendForRuntime("win32");
assert.equal(win.name, "windows");
for (const method of ["ensureReady", "listApps", "listRoots", "observe", "act", "actBatch", "readText", "waitFor"]) {
	assert.equal(typeof win[method], "function", `Windows backend is missing ${method}`);
}

for (const platform of ["darwin", "linux", "freebsd"]) {
	const backend = platformBackendForRuntime(platform);
	assert.equal(backend.name, "windows");
	assert.throws(() => backend.isBrowserApp("chrome"), /supports Windows only/);
}

const conforming = {
	protocolVersion: 1,
	pid: 1,
	architectureVersion: PLATFORM_ARCHITECTURE_VERSION,
	invariants: [...REQUIRED_PLATFORM_INVARIANTS],
};
assert.doesNotThrow(() => assertPlatformArchitecture("fixture", conforming));
assert.throws(
	() => assertPlatformArchitecture("fixture", { ...conforming, invariants: conforming.invariants.slice(1) }),
	/shared computer-use contract/,
);

const commit = await fs.readFile(new URL("../native/windows/bridge-rs/src/protocol.rs", import.meta.url), "utf8");
assert.match(commit, /PROTOCOL_VERSION: u32 = 4/, "Windows helper protocol version changed unexpectedly");

console.log("Windows platform checks passed");
