import { readFileSync } from "node:fs";
import type { ComputerUsePlatformBackend, PlatformName } from "./types.ts";
import { windowsBackend } from "./windows/backend.ts";

function isWslRuntime(): boolean {
	if (process.platform !== "linux") return false;
	if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
	try {
		return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
	} catch {
		return false;
	}
}

/**
 * The Windows helper is a Windows PE executable. Inside WSL it is started
 * through WSL interop, so a Linux Node process still drives Windows UI.
 */
export const isWindowsHost = process.platform === "win32" || isWslRuntime();

class UnsupportedPlatformBackend implements ComputerUsePlatformBackend {
	readonly name: PlatformName = "windows";
	private readonly platform: NodeJS.Platform;

	constructor(platform: NodeJS.Platform) {
		this.platform = platform;
	}

	private unsupported(): never {
		throw new Error(
			`nife-computer-use supports Windows only. Run nife on Windows or inside WSL; '${this.platform}' is not supported.`,
		);
	}

	async ensureReady(): Promise<never> {
		this.unsupported();
	}
	async listApps(): Promise<never> {
		this.unsupported();
	}
	async listRoots(): Promise<never> {
		this.unsupported();
	}
	async getFrontmost(): Promise<never> {
		this.unsupported();
	}
	async focusWindow(): Promise<never> {
		this.unsupported();
	}
	async observe(): Promise<never> {
		this.unsupported();
	}
	async act(): Promise<never> {
		this.unsupported();
	}
	async readText(): Promise<never> {
		this.unsupported();
	}
	async waitFor(): Promise<never> {
		this.unsupported();
	}
	isBrowserApp(): never {
		this.unsupported();
	}
	isChromeFamilyApp(): never {
		this.unsupported();
	}
	async openBrowserLocation(): Promise<boolean> {
		this.unsupported();
	}
}

export function platformBackendForRuntime(platform: NodeJS.Platform = process.platform): ComputerUsePlatformBackend {
	if (platform === "win32") return windowsBackend;
	return new UnsupportedPlatformBackend(platform);
}

export const currentPlatformBackend = platformBackendForRuntime(isWindowsHost ? "win32" : process.platform);
