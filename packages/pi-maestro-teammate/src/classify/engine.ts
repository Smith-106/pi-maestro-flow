/**
 * Unified classifier engine — layered pipeline shared by every classification
 * domain in the plugin.
 *
 * Pipeline per call:
 *   L0 rules  → deterministic verdict; `terminal` hits short-circuit.
 *   L1 JEV    → semantic decision via the System One model (choice/score/noul
 *               with probabilities + confidence), reached only when rules were
 *               absent or non-terminal AND the domain is in "jev" mode.
 *   degraded  → any transport/parse/budget failure resolves to the provisional
 *               rule label (or the domain's own fallback) — never throws.
 *
 * Modes per domain:
 *   "off"    — L0 only; identical to today's behavior.
 *   "shadow" — L0 decides synchronously; JEV judges the same input in the
 *              background and the pair is reported via `onShadow` so real
 *              traffic builds an eval corpus before adjudication is trusted.
 *   "jev"    — L0 → L1 adjudication for async callers. Sync callers still get
 *              the L0 result plus a shadow observation (they cannot await).
 *
 * Host-free: config (incl. API keys) is injected via {@link configureClassifier};
 * the engine never reads files, the env, or UI surfaces itself — except the
 * two documented env lookups delegated to `resolveJevEndpoint`.
 */

import { createHash } from "node:crypto";
import {
  createJevClient,
  resolveJevEndpoint,
  type JevClient,
  type JevClientOptions,
  type JevEndpoint,
} from "./client.ts";
import type {
  ClassifierDomainMode,
  ClassifierLayer,
  ClassifyDomain,
  ClassifyResult,
  ClassifyShadowRecord,
  JevResponse,
  RuleVerdict,
} from "./types.ts";

export interface ClassifierConfig {
  /** Master switch. When false, every call is L0-only regardless of domain modes. */
  enabled: boolean;
  /** Preferred endpoint; when absent, inferred from which API key env exists. */
  endpoint?: JevEndpoint;
  /** Explicit API key; when absent, read from the endpoint's env var. */
  apiKey?: string;
  /** Model override (e.g. `jev-latest`, `typesafe/jev-1.13`). */
  model?: string;
  /** Test seam: override the endpoint URL. */
  baseUrl?: string;
  /** Per-call timeout (default 4000ms; JEV is a low-latency decision model). */
  timeoutMs?: number;
  /** Answer cache TTL (default 10min — error text repeats heavily). */
  cacheTtlMs?: number;
  /** Max JEV calls per configure cycle (default 30). */
  maxCallsPerSession?: number;
  /** domain name → mode. Absent = "off". */
  domains?: Record<string, ClassifierDomainMode>;
  /** Test seam for HTTP. */
  fetchFn?: typeof fetch;
  /** Shadow observation sink (host decides where/how to persist). */
  onShadow?: (record: ClassifyShadowRecord) => void;
}

export interface ClassifierDomainStatus {
  mode: ClassifierDomainMode;
  supportedModes: readonly ClassifierDomainMode[];
}

export interface ClassifierStatus {
  enabled: boolean;
  endpoint?: JevEndpoint;
  apiKeyPresent: boolean;
  model?: string;
  callsUsed: number;
  maxCalls: number;
  cacheSize: number;
  domains: Record<string, ClassifierDomainStatus>;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CALLS = 30;

let config: ClassifierConfig = { enabled: false };
let client: JevClient | undefined;
let callsUsed = 0;
const registry = new Map<string, ClassifyDomain<string, unknown>>();
const cache = new Map<string, { response: JevResponse; at: number }>();

/** Inject classifier configuration (host loads `.pi/classifier.json` / env). */
export function configureClassifier(next: ClassifierConfig): void {
  config = { ...next };
  callsUsed = 0;
  const resolved = next.apiKey?.trim()
    ? { endpoint: next.endpoint ?? "typesafe", apiKey: next.apiKey.trim() }
    : resolveJevEndpoint(next.endpoint);
  client = config.enabled && resolved
    ? createJevClient({
      endpoint: resolved.endpoint,
      apiKey: resolved.apiKey,
      ...(next.model ? { model: next.model } : {}),
      ...(next.baseUrl ? { baseUrl: next.baseUrl } : {}),
      ...(next.timeoutMs !== undefined ? { timeoutMs: next.timeoutMs } : {}),
      ...(next.fetchFn ? { fetchFn: next.fetchFn } : {}),
    } as JevClientOptions)
    : undefined;
}

export function classifierConfig(): ClassifierConfig {
  return { ...config };
}

/** @internal Test seam: restore the disabled-by-default engine state. */
export function resetClassifierForTest(): void {
  config = { enabled: false };
  client = undefined;
  callsUsed = 0;
  registry.clear();
  cache.clear();
}

export function registerClassifyDomain<D extends string, I>(domain: ClassifyDomain<D, I>): void {
  registry.set(domain.name, domain as unknown as ClassifyDomain<string, unknown>);
}

export function classifyDomain(name: string): ClassifyDomain<string, unknown> | undefined {
  return registry.get(name);
}

export function listClassifyDomains(): string[] {
  return [...registry.keys()].sort();
}

export function classifierStatus(): ClassifierStatus {
  const domains: Record<string, ClassifierDomainStatus> = {};
  for (const [name, domain] of registry) {
    domains[name] = { mode: effectiveMode(domain), supportedModes: domain.modes };
  }
  return {
    enabled: config.enabled === true,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    apiKeyPresent: client !== undefined,
    ...(config.model ? { model: config.model } : {}),
    callsUsed,
    maxCalls: config.maxCallsPerSession ?? DEFAULT_MAX_CALLS,
    cacheSize: cache.size,
    domains,
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function effectiveMode(domain: ClassifyDomain<string, unknown>): ClassifierDomainMode {
  const requested = config.domains?.[domain.name] ?? "off";
  return domain.modes.includes(requested) ? requested : "off";
}

function safeRules<D extends string, I>(
  domain: ClassifyDomain<D, I>,
  input: I,
): RuleVerdict<D> | undefined {
  try {
    return domain.rules(input);
  } catch {
    return undefined;
  }
}

function degraded<D extends string, I>(
  domain: ClassifyDomain<D, I>,
  provisional: RuleVerdict<D> | undefined,
  reason: string,
): ClassifyResult<D> {
  if (provisional) {
    return { label: provisional.label, confidence: 0, layer: "degraded", degradedReason: reason };
  }
  const fallback = domain.fallback(reason);
  return { label: fallback.label, confidence: fallback.confidence, layer: "degraded", degradedReason: reason };
}

function cacheKey(domain: ClassifyDomain<string, unknown>, state: string): string {
  const questions = Object.keys(domain.questions()).sort().join(",");
  return createHash("sha256")
    .update(`${domain.name}${config.model ?? ""}${questions}\0${state}`)
    .digest("hex");
}

function cachedResponse(key: string): JevResponse | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > (config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)) {
    cache.delete(key);
    return undefined;
  }
  return entry.response;
}

async function jevDecide<D extends string, I>(
  domain: ClassifyDomain<D, I>,
  state: string,
): Promise<JevResponse> {
  if (!client) throw new Error("JEV client unavailable (disabled or missing API key)");
  if (callsUsed >= (config.maxCallsPerSession ?? DEFAULT_MAX_CALLS)) {
    throw new Error("JEV session call budget exhausted");
  }
  callsUsed += 1;
  return client.decide({ state, questions: domain.questions() });
}

/**
 * Shadow path: rules stay authoritative; JEV judges the same state in the
 * background and the pair goes to `onShadow`. Never throws, never blocks.
 */
function fireShadow<D extends string, I>(
  domain: ClassifyDomain<D, I>,
  input: I,
  verdict: RuleVerdict<D> | undefined,
  mode: ClassifierDomainMode,
): void {
  const record: ClassifyShadowRecord = {
    domain: domain.name,
    at: new Date().toISOString(),
    state: "",
    rule: verdict ? { label: verdict.label, terminal: verdict.terminal } : null,
  };
  void (async () => {
    try {
      record.state = domain.state(input).slice(0, 4_000);
      const key = cacheKey(domain, record.state);
      let response = cachedResponse(key);
      if (!response) {
        response = await jevDecide(domain, record.state);
        cache.set(key, { response, at: Date.now() });
      }
      const decided = domain.decide(response.answers);
      if (!decided) {
        record.error = "JEV answers did not map to a domain label";
      } else {
        record.jev = {
          label: decided.label,
          confidence: decided.confidence,
          ...(response.model ? { model: response.model } : {}),
        };
        record.agree = decided.label === verdict?.label;
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
    }
    try {
      config.onShadow?.(record);
    } catch {
      // Shadow reporting must never break the caller.
    }
  })();
}

/**
 * Synchronous classification — the only path sync call sites (e.g. the retry
 * boundary inside `classifyRetryError`) can use. L0 rules always answer; when
 * enabled and the domain is not "off", a background JEV shadow observation is
 * fired for eval purposes. The returned label is always the rule/fallback one.
 */
export function classifySync<D extends string, I>(
  domainOrName: ClassifyDomain<D, I> | string,
  input: I,
): ClassifyResult<D> {
  const domain = (typeof domainOrName === "string" ? registry.get(domainOrName) : domainOrName) as
    | ClassifyDomain<D, I>
    | undefined;
  if (!domain) throw new Error(`Unknown classifier domain: ${String(domainOrName)}`);
  const verdict = safeRules(domain, input);
  const mode = config.enabled === true ? effectiveMode(domain as ClassifyDomain<string, unknown>) : "off";
  if (mode !== "off") fireShadow(domain, input, verdict, mode);
  if (verdict) {
    return {
      label: verdict.label,
      confidence: verdict.terminal ? 1 : 0,
      layer: "rule",
      ...(verdict.terminal ? {} : { degradedReason: "rule default branch" }),
    };
  }
  const fallback = domain.fallback(mode === "off" ? "classifier disabled" : "no rule verdict");
  return { label: fallback.label, confidence: fallback.confidence, layer: "degraded", degradedReason: mode === "off" ? "classifier disabled" : "no rule verdict" };
}

/**
 * Async classification — full L0 → L1 pipeline for callers that can await.
 * Never throws: failures degrade to the provisional rule label or the domain
 * fallback with `layer: "degraded"` and a `degradedReason`.
 */
export async function classify<D extends string, I>(
  domainOrName: ClassifyDomain<D, I> | string,
  input: I,
): Promise<ClassifyResult<D>> {
  const domain = (typeof domainOrName === "string" ? registry.get(domainOrName) : domainOrName) as
    | ClassifyDomain<D, I>
    | undefined;
  if (!domain) throw new Error(`Unknown classifier domain: ${String(domainOrName)}`);
  const verdict = safeRules(domain, input);
  const mode = config.enabled === true ? effectiveMode(domain as ClassifyDomain<string, unknown>) : "off";
  if (verdict?.terminal === true) {
    return { label: verdict.label, confidence: 1, layer: "rule" };
  }
  if (mode !== "jev") {
    if (mode === "shadow") fireShadow(domain, input, verdict, mode);
    if (verdict) {
      return {
        label: verdict.label,
        confidence: 0,
        layer: "rule",
        degradedReason: "rule default branch",
      };
    }
    const fallback = domain.fallback(mode === "off" ? "classifier disabled" : "no rule verdict");
    return { label: fallback.label, confidence: fallback.confidence, layer: "degraded", degradedReason: mode === "off" ? "classifier disabled" : "no rule verdict" };
  }
  const state = domain.state(input);
  const key = cacheKey(domain, state);
  try {
    let response = cachedResponse(key);
    if (!response) {
      response = await jevDecide(domain, state);
      cache.set(key, { response, at: Date.now() });
    }
    const decided = domain.decide(response.answers);
    if (!decided) return degraded(domain, verdict, "JEV answers did not map to a domain label");
    return {
      label: decided.label,
      confidence: decided.confidence,
      layer: "jev",
      ...(decided.probabilities ? { probabilities: decided.probabilities } : {}),
      ...(response.model ? { model: response.model } : {}),
    };
  } catch (error) {
    return degraded(domain, verdict, error instanceof Error ? error.message : String(error));
  }
}
