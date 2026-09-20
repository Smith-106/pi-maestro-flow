/**
 * Classifier configuration — `.pi/classifier.json` load/save/normalize,
 * mirroring the self-evolve workspace-config pattern.
 *
 * Resolution order (same convention as self-evolve):
 *   1. `PI_CLASSIFIER=1` env force-enables;
 *   2. `.pi/classifier.json` `{ "enabled": true }`;
 *   3. `/classifier on` writes the config file.
 *
 * API keys never live in this file — the engine resolves
 * `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` from the environment.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ClassifierDomainMode, JevEndpoint } from "pi-maestro-teammate/v1/classify";

export interface FlowClassifierConfig {
  enabled: boolean;
  endpoint?: JevEndpoint;
  model?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxCallsPerSession?: number;
  /** domain name → mode; absent = "off". */
  domains: Record<string, ClassifierDomainMode>;
}

export const DEFAULT_CLASSIFIER_CONFIG: FlowClassifierConfig = {
  enabled: false,
  domains: {
    "retry-error": "shadow",
    "file-value": "off",
    "signal-type": "shadow",
  },
};

export const CLASSIFIER_ENV_FLAG = "PI_CLASSIFIER";
export const CLASSIFIER_ENDPOINT_ENV = "PI_CLASSIFIER_ENDPOINT";
export const CLASSIFIER_MODEL_ENV = "PI_CLASSIFIER_MODEL";

/** Project-scoped config path (`.pi/classifier.json`), mirroring self-evolve. */
export function classifierConfigPath(cwd = process.cwd()): string {
  return resolve(cwd, ".pi", "classifier.json");
}

/** Parse the `PI_CLASSIFIER` env flag; undefined when unset. */
export function envOverrideForClassifier(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

const DOMAIN_MODES: readonly ClassifierDomainMode[] = ["off", "shadow", "jev"];

export function normalizeClassifierConfig(raw: unknown): FlowClassifierConfig {
  const config: FlowClassifierConfig = {
    ...DEFAULT_CLASSIFIER_CONFIG,
    domains: { ...DEFAULT_CLASSIFIER_CONFIG.domains },
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return config;
  const record = raw as Record<string, unknown>;
  if (typeof record.enabled === "boolean") config.enabled = record.enabled;
  if (record.endpoint === "typesafe" || record.endpoint === "openrouter") config.endpoint = record.endpoint;
  if (typeof record.model === "string" && record.model.trim()) config.model = record.model.trim();
  if (typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs) && record.timeoutMs > 0) {
    config.timeoutMs = Math.floor(record.timeoutMs);
  }
  if (typeof record.cacheTtlMs === "number" && Number.isFinite(record.cacheTtlMs) && record.cacheTtlMs > 0) {
    config.cacheTtlMs = Math.floor(record.cacheTtlMs);
  }
  if (typeof record.maxCallsPerSession === "number" && Number.isInteger(record.maxCallsPerSession) && record.maxCallsPerSession > 0) {
    config.maxCallsPerSession = record.maxCallsPerSession;
  }
  if (record.domains && typeof record.domains === "object" && !Array.isArray(record.domains)) {
    for (const [name, mode] of Object.entries(record.domains as Record<string, unknown>)) {
      if (typeof mode === "string" && (DOMAIN_MODES as readonly string[]).includes(mode)) {
        config.domains[name] = mode as ClassifierDomainMode;
      }
    }
  }
  return config;
}

export async function loadClassifierConfig(cwd: string): Promise<FlowClassifierConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(classifierConfigPath(cwd), "utf8"));
  } catch {
    raw = undefined;
  }
  const config = normalizeClassifierConfig(raw);
  const envEnabled = envOverrideForClassifier(process.env[CLASSIFIER_ENV_FLAG]);
  if (envEnabled !== undefined) config.enabled = envEnabled;
  return config;
}

export async function saveClassifierConfig(config: FlowClassifierConfig, cwd: string): Promise<void> {
  const path = classifierConfigPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Apply env-var model/endpoint overrides on top of the file config. */
export function applyClassifierEnvOverrides(config: FlowClassifierConfig): FlowClassifierConfig {
  const next = { ...config, domains: { ...config.domains } };
  const endpoint = process.env[CLASSIFIER_ENDPOINT_ENV]?.trim();
  if (endpoint === "typesafe" || endpoint === "openrouter") next.endpoint = endpoint;
  const model = process.env[CLASSIFIER_MODEL_ENV]?.trim();
  if (model) next.model = model;
  return next;
}
