#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = resolve(root, "docs/content/docs");
const modes = ["tutorials", "how-to-guides", "explanation", "reference"];
const failures = [];

for (const mode of modes) {
	const path = resolve(docsRoot, mode);
	if (!existsSync(path) || !statSync(path).isDirectory()) failures.push(`Missing Diátaxis section: docs/${mode}/`);
}

function filesBelow(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? filesBelow(path) : [path];
	});
}

const markdownFiles = filesBelow(docsRoot).filter((file) => [".md", ".mdx"].includes(extname(file)));

for (const path of markdownFiles) {
	const content = readFileSync(path, "utf8");
	const display = relative(root, path);
	if (
		display.includes("docs/content/docs/reference/") &&
		!content.slice(0, 700).includes("{/* This file is generated")
	) {
		failures.push(
			`${display}: every reader-facing reference page must be generated from source ownership or repository metadata`,
		);
	}

	for (const match of content.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) {
		const rawTarget = match[1].trim().replace(/^<|>$/g, "");
		if (!rawTarget || /^(?:[a-z]+:|#)/i.test(rawTarget)) continue;
		const target = decodeURIComponent(rawTarget.split(/[?#]/, 1)[0]);
		const resolved = target.startsWith("/") ? resolve(docsRoot, `.${target}`) : resolve(dirname(path), target);
		const candidates = [
			resolved,
			`${resolved}.md`,
			`${resolved}.mdx`,
			resolve(resolved, "index.md"),
			resolve(resolved, "index.mdx"),
		];
		if (!candidates.some((candidate) => existsSync(candidate))) failures.push(`${display}: broken local link ${rawTarget}`);
	}
}

const windowsDocPath = resolve(docsRoot, "reference/platforms/windows.mdx");
if (!existsSync(windowsDocPath)) {
	failures.push("Missing Windows bridge reference: docs/content/docs/reference/platforms/windows.mdx");
} else {
	const windowsDoc = readFileSync(windowsDocPath, "utf8");
	const evidence = JSON.parse(readFileSync(resolve(root, "scripts/docs-generators/reference-evidence.json"), "utf8"));
	const page = evidence.pages.find((entry) => entry.key === "reference/platforms/windows");
	if (!page) {
		failures.push("reference-evidence.json no longer declares the Windows bridge page");
	} else {
		for (const symbol of page.requiredSymbols) {
			if (!windowsDoc.includes(symbol)) failures.push(`Windows reference is missing evidence symbol ${symbol}`);
		}
		if (!windowsDoc.includes("windows-bridge.exe")) failures.push("Windows reference does not name the installed helper binary");
	}
}

for (const retired of [
	"docs/content/docs/reference/platforms/macos",
	"docs/content/docs/how-to-guides/linux.mdx",
]) {
	if (existsSync(resolve(root, retired))) failures.push(`Retired platform documentation still exists: ${retired}`);
}

const allDocs = [resolve(root, "README.md"), resolve(root, "CONTRIBUTING.md"), ...markdownFiles]
	.map((file) => readFileSync(file, "utf8"))
	.join("\n");
const stalePlatformClaims = [
	[/AT-SPI2/i, "Linux accessibility bus still documented"],
	[/ScreenCaptureKit|Core Graphics|CGWindowList/i, "macOS capture API still documented"],
	[/pi-computer-use\.app/, "macOS helper app still documented"],
	[/Screen Recording (grant|permission)/i, "macOS Screen Recording permission still documented"],
];
for (const [pattern, description] of stalePlatformClaims) {
	if (pattern.test(allDocs)) failures.push(`Stale platform claim: ${description}`);
}

if (failures.length) {
	console.error("Documentation checks failed:\n");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exit(1);
}

console.log("Documentation structure and local links passed.");
