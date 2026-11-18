import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { noteAfterAct, noteFromLook } from "../src/note.ts";
import { countOutlineNodes, foldToBudget, nodeByRef, parseLookResponse, renderInteractiveControls } from "../src/outline.ts";
import { shouldPreferForegroundModalWindow } from "../src/root-selection.ts";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const windowsMain = read("native/windows/bridge-rs/src/main.rs");
const windowsProtocol = read("native/windows/bridge-rs/src/protocol.rs");
const windowsBackend = read("src/platform/windows/backend.ts");
const windowsHelper = read("src/platform/windows/helper.ts");
const platformIndex = read("src/platform/index.ts");
const platformTypes = read("src/platform/types.ts");
const extensionTs = read("extensions/computer-use.ts");
const ts = read("src/bridge.ts");
const noteTs = read("src/note.ts");
const stateTs = read("src/state.ts");
const configTs = read("src/config.ts");
const setupHelper = read("scripts/setup-helper.mjs");
const buildNative = read("scripts/build-native.mjs");
const srcFiles = fs
	.readdirSync(path.join(root, "src"), { recursive: true })
	.filter((file) => typeof file === "string" && file.endsWith(".ts"))
	.map((file) => [file, fs.readFileSync(path.join(root, "src", file), "utf8")]);
const results = [];

function check(name, fn) {
	try {
		fn();
		results.push([name, true]);
		console.log(`PASS ${name}`);
	} catch (error) {
		results.push([name, false]);
		process.exitCode = 1;
		console.error(`FAIL ${name}: ${error.message}`);
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function enclosingFunctionName(text, index) {
	const prefix = text.slice(0, index);
	const matches = [...prefix.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g)];
	return matches.at(-1)?.[1] ?? "(unknown)";
}

check("INV-1 retired helper commands stay removed", () => {
	const deletedCommands = [
		"mouseClick",
		"mouseMove",
		"mouseDrag",
		"scrollWheel",
		"keyPress",
		"typeText",
		"setValue",
		"selectText",
		"axClickElement",
		"axPerformActionElement",
		"axFocusElement",
		"axFocusAtPoint",
		"axClickAtPoint",
		"axFindTextInput",
		"axFocusTextInput",
		"axPressElement",
		"axPressAtPoint",
	];
	for (const command of deletedCommands) {
		assert(!new RegExp(`bridgeCommand(?:<[^>]+>)?\\(\\s*["']${command}["']`).test(ts), `src still calls helper command ${command}`);
		assert(!new RegExp(`"${command}"\\s*=>`).test(windowsMain), `Windows helper still dispatches ${command}`);
	}
	for (const [file, text] of srcFiles) {
		assert(!text.includes("lookCompat"), `lookCompat appears in src/${file}`);
	}
});

check("INV-2 static no TS coordinate transforms or capture dimensions", () => {
	for (const [file, text] of srcFiles) {
		assert(
			!/screenPointToCapturePoint|screenFrameToCaptureFrame/.test(text),
			`coordinate transform appears in src/${file}`,
		);
		assert(!/\bcaptureWidth\b|\bcaptureHeight\b/.test(text), `capture dimensions appear in src/${file}`);
	}
});

check("INV-3 static scene fusion and auto-confirm absent", () => {
	for (const [file, text] of srcFiles) {
		assert(
			!/sceneAxTargetsFromSemantic|buildSceneProjection|autoConfirmButton|coordinateStateSignature/.test(text),
			`deleted scene/confirm helper appears in src/${file}`,
		);
	}
});

check("INV-4 act owns the input command surface", () => {
	assert(
		srcFiles.some(([, text]) => /interface HelperActResult[\s\S]*outcome: ActOutcome/.test(text)),
		"TS helper act result does not carry outcome",
	);
	for (const [file, text] of srcFiles) {
		assert(!/verifiedCoordinateClick|coordinateStateSignature/.test(text), `deleted verification helper appears in src/${file}`);
	}
	assert(windowsMain.includes('"act" => handle_act') && windowsMain.includes('"actBatch" => handle_act_batch'), "Windows helper does not expose act/actBatch only");
	assert(!/=> handle_(click|type|keypress|scroll)\b/.test(windowsMain), "Windows helper still exposes one-shot input commands");
});

check("INV-5 listRoots seam stays platform-neutral", () => {
	assert(
		srcFiles.some(([, text]) => /interface PlatformRoot[\s\S]*isModal: boolean/.test(text)),
		"PlatformRoot lacks required isModal fact",
	);
	assert(
		srcFiles.some(([, text]) => /interface PlatformRoot[\s\S]*metadata\?: Record<string, unknown>/.test(text)),
		"PlatformRoot lacks metadata escape hatch",
	);
	assert(!srcFiles.some(([, text]) => /interface PlatformRoot[\s\S]*\bpairing:/.test(text)), "PlatformRoot must not require pairing");
	assert(!srcFiles.some(([, text]) => /interface PlatformRoot[\s\S]*\bsheetCount:/.test(text)), "PlatformRoot must not require sheetCount");
});

check("explicit root is not replaced by a modal window behind it", () => {
	const base = {
		kind: "window",
		windowId: 1,
		windowRef: "w1",
		rootRef: "@r1",
		title: "Main",
		appName: "Fixture",
		pid: 1,
		zOrder: 10,
		framePoints: { x: 0, y: 0, w: 100, h: 100 },
		scaleFactor: 1,
		isOnscreen: true,
		isFocused: true,
		isMinimized: false,
		isMain: true,
		isModal: false,
	};
	const rootOf = (overrides) => ({ ...base, ...overrides });
	const current = rootOf({});
	const behindModal = rootOf({ windowId: 2, windowRef: "w2", rootRef: "@r2", title: "Behind", zOrder: 20, isModal: true, isFocused: false });
	const foregroundModal = rootOf({ windowId: 3, windowRef: "w3", rootRef: "@r3", title: "Prompt", zOrder: 2, isModal: true, isFocused: false });
	assert(!shouldPreferForegroundModalWindow(current, behindModal), "modal root behind the explicit target was promoted");
	assert(shouldPreferForegroundModalWindow(current, foregroundModal), "foreground modal root was not promoted");
});

check("INV-6 static note is derived and disposable", () => {
	for (const match of noteTs.matchAll(/export\s+function\s+([A-Za-z0-9_]+)/g)) {
		assert(/^note|^render/.test(match[1]), `src/note.ts exports non-note/render function ${match[1]}`);
	}
	assert(!/export\s+(let|const|var)\s+/.test(noteTs), "src/note.ts exports mutable or module state");
	const allowed = new Set(["captureCurrentTarget", "runActionTool", "reconstructStateFromBranch", "shutdownComputerUseSession"]);
	for (const match of ts.matchAll(/runtimeState\.currentNote\s*=/g)) {
		const fn = enclosingFunctionName(ts, match.index ?? 0);
		assert(allowed.has(fn), `runtimeState.currentNote assigned in ${fn}`);
	}
	const parsed = parseLookResponse({
		lookId: "inv-6",
		window: { title: "Fixture", appName: "Fixture", pid: 1 },
		outline: { role: "AXWindow", children: [{ role: "AXButton", title: "Save" }] },
	});
	const note = noteFromLook(undefined, parsed.parsedOutline, {
		windowRef: "@r1",
		title: "Fixture",
		pairing: "high",
	});
	const target = parsed.parsedOutline.nodes.find((node) => node !== parsed.parsedOutline.root);
	const acted = noteAfterAct(note, target.ref, parsed.parsedOutline, {
		window: { windowRef: note.windowRef, title: note.title, pairing: note.pairing },
	});
	assert(acted.regions.some((region) => region.status === "changed"), "synthetic act did not mark a region changed");
});

check("INV-7 static no label-confirm press regex", () => {
	for (const [file, text] of srcFiles) {
		assert(
			!/\/[^/\n]*(confirm|ok|continue|apply)[^/\n]*\/[gimsuyd]*[\s\S]{0,200}(\bpress\b|AXPress|axPress|axPerformActionElement)/i.test(text),
			`confirm-label press regex appears in src/${file}`,
		);
		assert(
			!/(confirm|ok|continue|apply)[\s\S]{0,80}(includes|startsWith|endsWith|===|==)[\s\S]{0,200}(\bpress\b|AXPress|axPress|axPerformActionElement)/i.test(text),
			`confirm-label press comparison appears in src/${file}`,
		);
	}
});

check("INV-8 tsc no unused locals", () => {
	execFileSync("npx", ["tsc", "--noEmit"], { cwd: root, stdio: "pipe" });
});

check("INV-9 immutable state ownership", () => {
	assert(!/runtimeState\.current(Target|Capture|Look|Outline|Note|ImageMode|StateTarget)/.test(ts), "global current UI state remains in bridge");
	assert(stateTs.includes("class SavedStates") && stateTs.includes("new StateStore<UiObservation>"), "unified bounded observation store is missing");
});

check("INV-10 resource-keyed scheduling", () => {
	assert(ts.includes("desktopResourceKey") && ts.includes("resourceScheduler.write"), "desktop writes are not resource scheduled");
	assert(!ts.includes("withRuntimeLock"), "global runtime lock remains");
});

check("INV-11 unified agent contract", () => {
	const tools = [...extensionTs.matchAll(/\bname:\s*"([^"]+)"/g)].map((match) => match[1]);
	const expected = [
		"find_roots",
		"observe_ui",
		"search_ui",
		"expand_ui",
		"inspect_ui",
		"act_ui",
		"read_text",
		"wait_for",
		"launch_browser",
		"navigate_browser",
		"evaluate_browser",
	];
	assert(JSON.stringify(tools) === JSON.stringify(expected), `unexpected public tool surface: ${tools.join(", ")}`);
	assert(!extensionTs.includes('executionMode: "sequential"'), "computer-use tools remain globally sequential");
	assert(extensionTs.includes("Required state id owning every @e ref"), "state-scoped ref contract is missing");
});

check("INV-11a compact observe view", () => {
	assert(
		/detail:\s*Type\.Optional\(\s*Type\.Union\(\[Type\.Literal\("compact"\), Type\.Literal\("outline"\)\]/.test(extensionTs),
		"observe_ui does not declare detail compact|outline",
	);
	assert(
		ts.includes("function renderStateView") &&
			(ts.match(/renderStateView\(/g) ?? []).length >= 4 &&
			(ts.match(/waitForViewText\(/g) ?? []).length >= 3,
		"full views do not route through renderStateView",
	);
	assert(/`Controls \([^`]*stateId \$\{stateId\}, root \$\{outline\.root\.ref\}/.test(ts), "controls header does not show stateId and root ref");
});

check("INV-12 parallel native transports", () => {
	assert(
		windowsMain.includes("thread::spawn") && windowsMain.includes("physical_input_lock"),
		"Windows helper is not concurrent with protected physical input",
	);
	assert(windowsMain.includes("REQUEST_WORKERS") && windowsMain.includes("mpsc"), "Windows helper does not fan requests out to workers");
});

check("INV-14 native batches settle once", () => {
	assert(ts.includes("currentPlatformBackend.actBatch") && ts.includes("dispatchUiTransaction"), "bridge does not route batches through the native transaction seam");
	assert(windowsMain.includes('"actBatch" => handle_act_batch') && windowsMain.includes("deferRootDelta"), "Windows helper does not defer per-step root deltas");
	assert(windowsMain.includes('response["stoppedAt"]'), "native batches do not report their checked stop boundary");
});

check("INV-15 semantic action postconditions", () => {
	const actions = read("src/actions.ts");
	assert(extensionTs.includes("expect: Type.Optional") && extensionTs.includes("timeoutMs"), "act_ui does not expose a semantic postcondition");
	assert(
		ts.includes('code: "postcondition_failed"') && ts.includes('status: "verified" | "preexisting" | "failed"'),
		"postcondition failure is not represented honestly",
	);
	assert(
		ts.includes("outcomeAfterCheck") && actions.includes('check === "verified"') && actions.includes('return "worked"'),
		"newly verified expectations do not determine the request outcome",
	);
});

check("INV-16 clean headless contract and non-destructive helper install", () => {
	assert(!/stealth_mode|stealthMode|NIFE_COMPUTER_USE_STEALTH|NIFE_COMPUTER_USE_STRICT_AX/.test(configTs), "obsolete stealth configuration aliases remain");
	assert(
		ts.includes('code !== "foreground_required" || headless'),
		"headless mode can still escalate to foreground input",
	);
	assert(!/tccutil|resetTcc/i.test(setupHelper), "helper installation can reset platform privacy grants");
	assert(setupHelper.includes("copyIfChanged") && setupHelper.includes("prebuilt"), "helper installer does not reuse the verified prebuilt binary");
	assert(!/darwin|swiftc|codesign|xcrun/i.test(setupHelper), "helper installer still contains macOS-only setup");
	assert(!/darwin|swiftc|codesign|xcrun|linuxCrateDir|linux-bridge/i.test(buildNative), "native build script still contains macOS/Linux setup");
});

check("INV-17 consolidated actions and diff-first resulting views", () => {
	const actions = read("src/actions.ts");
	const view = read("src/view.ts");
	assert(actions.includes("prepareAction") && actions.includes("canRetryInForeground"), "action preparation and safe recovery are not consolidated");
	assert(!fs.existsSync(path.join(root, "src/interaction.ts")), "superseded interaction policy module still exists");
	assert(!ts.includes("responseMode") && !extensionTs.includes("responseMode"), "alternate confirmation-only action path still exists");
	assert(ts.includes("currentFocus") && ts.includes('escalationReason = "side_effect_free_didnt"'), "runner does not preserve action focus or recover checked keyboard failures");
	assert(view.includes("stabilizeRefs") && view.includes("changesBetween"), "resulting-state ref stabilization or change rendering is missing");
	assert(ts.includes('view: "full" | "diff"') && ts.includes("Changes ("), "agent result does not expose changes-first resulting views");
	assert(!ts.includes("preserveFocus") && windowsBackend.includes("preserveFocus"), "native focus continuity leaks through the coordinator");
});

check("INV-18 Windows-only platform routing", () => {
	assert(platformTypes.includes('export type PlatformName = "windows"'), "PlatformName still lists retired platforms");
	assert(!/platform\/macos|platform\/linux|macosBackend|linuxBackend/.test(platformIndex), "platform index still references macOS or Linux backends");
	assert(platformIndex.includes('from "./windows/backend.ts"'), "platform index does not route to the Windows backend");
	assert(platformIndex.includes("WSL_DISTRO_NAME") && platformIndex.includes("/proc/version"), "platform index cannot detect WSL");
	assert(platformIndex.includes("supports Windows only"), "unsupported platforms do not get an explicit message");
});

check("INV-19 retired platform sources stay removed", () => {
	for (const retired of [
		"src/platform/macos",
		"src/platform/linux",
		"native/macos",
		"native/linux",
		"prebuilt/macos",
		"prebuilt/linux",
	]) {
		assert(!fs.existsSync(path.join(root, retired)), `${retired} still exists`);
	}
});

check("INV-20 helper protocol parity and install path parity", () => {
	const rustVersion = windowsProtocol.match(/PROTOCOL_VERSION: u32 = (\d+)/)?.[1];
	const tsVersion = windowsHelper.match(/WINDOWS_HELPER_PROTOCOL_VERSION = (\d+)/)?.[1];
	assert(rustVersion && tsVersion && rustVersion === tsVersion, `helper protocol mismatch: rust=${rustVersion} ts=${tsVersion}`);
	assert(windowsHelper.includes('".nife", "agent", "helpers", "nife-computer-use", "windows-bridge.exe"'), "Windows helper path does not follow the nife agent directory");
	assert(setupHelper.includes('".nife", "agent", "helpers", "nife-computer-use", "windows-bridge.exe"'), "setup helper install path differs from the runtime path");
	assert(windowsHelper.includes('"--platform", "windows"'), "Windows helper client does not request the Windows installer");
});

check("INV-21 outline folding and compact controls stay bounded", () => {
	const parsed = parseLookResponse({
		lookId: "inv-21",
		window: { title: "Fixture", appName: "Fixture", pid: 1 },
		outline: {
			role: "AXWindow",
			children: [
				{ role: "AXButton", title: "Save" },
				{ role: "AXGroup", children: [{ role: "AXButton", title: "Cancel" }, { role: "AXButton", title: "Apply" }] },
			],
		},
	}).parsedOutline;
	const folded = foldToBudget(parsed, { maxDepth: 1, maxNodes: 20 });
	const compact = renderInteractiveControls(parsed);
	assert(folded.text.includes("more nodes not shown") || folded.text.length > 0, "fold produced no text");
	assert(compact.renderedRefs.every((ref) => nodeByRef(parsed, ref)), "compact view rendered an unknown ref");
	assert(compact.nodeCount === countOutlineNodes(parsed.root), "compact node count does not match the outline");
});

if (results.some(([, ok]) => !ok)) process.exit(1);
