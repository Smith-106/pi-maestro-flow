import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";

test("real native Cockpit entry keeps core tools untouched on load, session and quiet settings; theme row delegates", async () => {
	assert.equal(VERSION, "0.99.0", "fixture verifies the installed public SDK");
	const agentDir = mkdtempSync(join(tmpdir(), "cockpit-native-entry-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const handlers = new Map<string, any[]>();
	const commands = new Map<string, any>();
	const registered: string[] = [];
	const bus = new Map<string, Set<any>>();
	const setConfig = (quietMode: boolean) => writeFileSync(join(agentDir, "cockpit.json"), JSON.stringify({ enabled: true, historyEnabled: false, staticMode: true, quietMode, usage: { enabled: false }, title: { enabled: false }, sidebar: { mode: "off" } }));
	setConfig(true);
	const pi = {
		on(name: string, handler: any) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => {}; },
		registerTool(tool: any) { registered.push(tool.name); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerShortcut() {}, registerMessageRenderer() {}, registerFlag() {}, getFlag: () => false, getThinkingLevel: () => "off",
		events: {
			on(name: string, fn: any) { const listeners = bus.get(name) ?? new Set(); listeners.add(fn); bus.set(name, listeners); return () => listeners.delete(fn); },
			emit(name: string, payload: any) { for (const fn of [...(bus.get(name) ?? [])]) fn(payload); },
		},
	};
	let draft = "";
	let themeWrites = 0;
	let syncEnabled = true;
	let overlayThemeWrites = 0;
	let footerFactory: any;
	let palette = "31";
	const ui = new Proxy({
		theme: { fg: (_role: string, text: string) => `\x1b[${palette}m${text}\x1b[0m`, bold: (text: string) => text },
		setFooter(factory: any) { footerFactory = factory; },
		getEditorText: () => draft, setEditorText: (text: string) => { draft = text; },
		setTheme() { themeWrites++; syncEnabled = false; return { success: true }; },
		getAllThemes: () => [{ name: "light" }, { name: "dark" }],
		getEditorComponent: () => undefined,
	}, { get: (target: any, key: string) => key in target ? target[key] : () => undefined });
	const ctx: any = {
		ui, hasUI: true, mode: "tui", cwd: agentDir, isIdle: () => true,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: { getEntries: () => [], getBranch: () => [], getCwd: () => agentDir, getSessionId: () => "native-entry", getSessionName: () => undefined },
		getContextUsage: () => undefined,
	};
	const fire = async (name: string) => { for (const fn of handlers.get(name) ?? []) await fn({ type: name, reason: "reload" }, ctx); };
	try {
		const { default: entry } = await import("../src/index.ts");
		entry(pi as never);
		assert.deepEqual(registered, []);
		assert.ok(handlers.get("tool_call")?.length, "native edit policy is wired to the actual entry");
		await fire("session_start");
		assert.deepEqual(registered, []);
		assert.ok(footerFactory, "actual Cockpit footer is mounted");
		const footer = footerFactory({ terminal: { columns: 100, rows: 30 }, requestRender() {} }, ui.theme, {
			onBranchChange: () => () => {}, getGitBranch: () => undefined, getExtensionStatuses: () => new Map(),
		});
		try {
			const old = footer.render(100);
			assert.match(old.join("\n"), /\x1b\[31m/);
			assert.strictEqual(footer.render(100), old);
			palette = "32";
			footer.invalidate();
			assert.match(footer.render(100).join("\n"), /\x1b\[32m/);
			assert.doesNotMatch(footer.render(100).join("\n"), /\x1b\[31m/);
		} finally { footer.dispose(); }
		assert.equal(commands.get("theme").getArgumentCompletions("d"), null);
		for (const args of ["", "light"]) {
			draft = "";
			await commands.get("theme").handler(args, ctx);
			assert.equal(draft, "/settings");
		}
		ui.custom = async (factory: any) => {
			const component = factory({ requestRender() {} }, ui.theme, {}, () => {});
			component.handleInput("q"); // Quiet row: exercise the live off -> on path.
			component.handleInput("q");
			const prior = themeWrites;
			component.handleInput("h"); // Theme row: close, then offer native /settings.
			overlayThemeWrites = themeWrites - prior;
			component.dispose?.();
		};
		draft = "";
		await commands.get("cockpit").handler("", ctx);
		assert.equal(draft, "/settings");
		assert.equal(overlayThemeWrites, 0);
		assert.equal(syncEnabled, true);
		assert.equal(themeWrites, 0);
		assert.deepEqual(registered, []);
		await fire("session_shutdown");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
