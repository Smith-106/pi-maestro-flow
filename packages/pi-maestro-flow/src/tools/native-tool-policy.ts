import { matchesGlob } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getPiHostMode } from "pi-maestro-settings-core/v1";

const DEFERRED_TOOLS = new Set([
  "browser", "computer_use", "conflict", "loop", "lsp", "model-availability",
  "smart_search", "source_check", "teammate-session-routing",
]);
const CONTROL_TOOLS = new Set([
  "maestro", "goal", "todo", "run-control", "ask-user-question", "new_context",
  "board", "device", "workspace", "endpoint", "route",
]);

export interface NativeDiscoverySelection {
  defaultTools?: readonly string[];
  extensions?: readonly string[];
  cli?: {
    tools?: readonly string[];
    excludeTools?: readonly string[];
    extensions?: readonly string[];
    noExtensions?: boolean;
    noTools?: boolean;
  };
}

function extensionSelection(entries: readonly string[] | undefined): boolean | undefined {
  let selected: boolean | undefined;
  for (const entry of entries ?? []) {
    const prefix = /^[!+-]/.test(entry) ? entry[0] : "";
    const pattern = prefix ? entry.slice(1) : entry;
    if (!pattern || !matchesGlob("builtin:tool-search", pattern)) continue;
    selected = prefix !== "!" && prefix !== "-";
  }
  return selected;
}

/** Discovery opt-in never overrides a CLI allowlist or a disabled builtin. */
export function isNativeDiscoverySelected(selection: NativeDiscoverySelection): boolean {
  const cli = selection.cli;
  const cliBuiltin = extensionSelection(cli?.extensions);
  if (cliBuiltin !== true && cli?.noExtensions) return false;
  if (cliBuiltin === false) return false;
  if (cliBuiltin !== true && extensionSelection(selection.extensions) === false) return false;
  if (cli?.noTools || cli?.excludeTools?.includes("tool_search")) return false;
  if (cli?.tools) return cli.tools.includes("tool_search");
  let selected = false;
  for (const entry of selection.defaultTools ?? []) {
    if (entry === "tool_search" || entry === "+tool_search") selected = true;
    if (entry === "-tool_search") selected = false;
  }
  return selected;
}

export function applyNativeToolPolicy<T extends ToolDefinition>(
  tool: T,
  discoveryEnabled: boolean,
): T {
  const control = CONTROL_TOOLS.has(tool.name) || tool.name.startsWith("plan-");
  return {
    ...tool,
    namespace: tool.namespace ?? { name: "maestro", description: "Maestro workflow and developer tools" },
    exposure: tool.exposure ?? (control ? "model-only" : discoveryEnabled && DEFERRED_TOOLS.has(tool.name) ? "deferred" : "direct"),
  };
}

/** Decorate only this extension's registrations; the host owns its loadout and tools. */
export function withNativeToolPolicy(
  pi: ExtensionAPI,
  hostVersion: unknown,
  discoveryEnabled: boolean,
): ExtensionAPI {
  if (getPiHostMode(hostVersion) !== "native") return pi;
  const originalRegister = pi.registerTool.bind(pi);
  let registerTool = (tool: ToolDefinition): void => originalRegister(applyNativeToolPolicy(tool, discoveryEnabled));
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") return registerTool;
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      if (property === "registerTool") {
        registerTool = value;
        return true;
      }
      return Reflect.set(target, property, value, receiver);
    },
  });
}
