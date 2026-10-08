/**
 * The Score contract.
 *
 * The Score is one YAML document holding a `version` and a `providers` map.
 * This module reads and checks it (docs/mvp-spec.md §2.1) — required fields
 * present, values of the right kind, every referenced credential variable
 * actually exported. `unis validate` and `unis sync` share these checks.
 *
 * `${VAR_NAME}` is the only template syntax. It is expanded at read time into
 * plaintext; a variable that is undefined or empty aborts the operation before
 * anything is written, so an Agent is never handed a blank key.
 */

import { isListNode, isObjectNode } from "./guards";
import { scorePath } from "./paths";

/** The one accepted Score version. */
const SCORE_VERSION = "1";

const API_TYPES: Record<string, true> = {
  "openai-completions": true,
  "openai-responses": true,
  "anthropic-messages": true,
};

/** Fields the common Score schema defines; anything else is a suspicious key. */
const PROVIDER_FIELDS: Record<string, true> = {
  name: true,
  baseUrl: true,
  apiKey: true,
  apiType: true,
  headers: true,
  overrides: true,
  models: true,
};

const MODEL_FIELDS: Record<string, true> = {
  id: true,
  name: true,
  contextWindow: true,
  maxTokens: true,
  reasoning: true,
  overrides: true,
};

const TOP_LEVEL_FIELDS: Record<string, true> = {
  version: true,
  providers: true,
};

export type Model = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens?: number;
  reasoning?: boolean;
  overrides?: Record<string, unknown>;
};

export type Provider = {
  name: string;
  baseUrl: string;
  apiKey: string;
  apiType: string;
  headers?: Record<string, unknown>;
  models: Model[];
  overrides?: Record<string, unknown>;
};

/** A Score that passed every check, with `apiKey`s expanded to plaintext. */
export type Score = {
  version: string;
  providers: Record<string, Provider>;
};

export type ScoreResult =
  | { ok: true; score: Score; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** Collects problems so one run reports all of them, not just the first. */
type Report = {
  fail: (message: string) => void;
  warn: (message: string) => void;
};

function unknownKeys(node: Record<string, unknown>, known: Record<string, true>): string[] {
  return Object.keys(node).filter((key) => !(key in known));
}

/**
 * Expands `${VAR_NAME}` to the variable's value.
 *
 * Returns an error naming the variable when it is undefined or empty — an
 * empty credential must never reach a config. The second pass only expands
 * `apiKey`s that already validated, so it reports rather than re-fails.
 */
function expandEnvReferences(
  value: string,
  onMissing: (name: string) => void,
): string {
  return value.replace(/\$\{(\w+)\}/g, (match, name: string) => {
    const resolved = Bun.env[name]?.trim() ?? "";
    if (!resolved) {
      onMissing(name);
      return match;
    }
    return resolved;
  });
}

/** Expands credential references that have already passed validation. */
function expandKey(value: string): string {
  return expandEnvReferences(value, () => {});
}

function checkProvider(id: string, value: unknown, report: Report): void {
  const label = `provider '${id}'`;
  if (!isObjectNode(value)) {
    report.fail(`${label} must be a map`);
    return;
  }

  for (const field of ["name", "baseUrl", "apiKey", "apiType", "models"]) {
    if (value[field] === undefined || value[field] === null) {
      report.fail(`${label}.${field} is required`);
    }
  }

  for (const key of unknownKeys(value, PROVIDER_FIELDS)) {
    report.warn(`unknown field '${key}' in ${label} — possible typo`);
  }

  const apiType = value["apiType"];
  if (apiType !== undefined && apiType !== null) {
    if (typeof apiType !== "string" || !(apiType in API_TYPES)) {
      report.fail(`${label}.apiType ${JSON.stringify(apiType)} is not one of ${Object.keys(API_TYPES).join(", ")}`);
    }
  }

  if (typeof value["apiKey"] === "string") {
    expandEnvReferences(value["apiKey"], (name) =>
      report.fail(`${label}.apiKey references environment variable ${name}, which is not defined or is empty`),
    );
  }

  const models = value["models"];
  if (models === undefined || models === null) return;
  if (!isListNode(models)) {
    report.fail(`${label}.models must be a list`);
    return;
  }
  if (models.length === 0) {
    report.fail(`${label}.models is empty — a provider must declare at least one model`);
    return;
  }

  const seen: Record<string, true> = {};
  for (const [index, entry] of models.entries()) {
    checkModel(`${label}.models[${index}]`, index, entry, id, seen, report);
  }
}

function checkModel(
  at: string,
  index: number,
  entry: unknown,
  providerId: string,
  seen: Record<string, true>,
  report: Report,
): void {
  if (!isObjectNode(entry)) {
    report.fail(`${at} must be a map`);
    return;
  }

  for (const field of ["id", "name", "contextWindow"]) {
    if (entry[field] === undefined || entry[field] === null) {
      report.fail(`${at}.${field} is required (provider '${providerId}', model ${index})`);
    }
  }

  for (const key of unknownKeys(entry, MODEL_FIELDS)) {
    report.warn(`unknown field '${key}' in ${at} — possible typo`);
  }

  const id = entry["id"];
  if (typeof id === "string") {
    if (id in seen) report.fail(`${at}.id '${id}' is duplicated within provider '${providerId}'`);
    seen[id] = true;
  }

  for (const field of ["contextWindow", "maxTokens"]) {
    const value = entry[field];
    if (value !== undefined && value !== null && !Number.isInteger(value)) {
      report.fail(`${at}.${field} must be an integer, got ${JSON.stringify(value)}`);
    } else if (typeof value === "number" && value <= 0) {
      report.fail(`${at}.${field} must be positive, got ${JSON.stringify(value)}`);
    }
  }
}

/** Builds the valid Score, expanding every credential reference to plaintext. */
function toScore(providers: Record<string, Provider>): Score {
  const expanded: Record<string, Provider> = {};
  for (const [id, provider] of Object.entries(providers)) {
    expanded[id] = { ...provider, apiKey: expandKey(provider.apiKey) };
  }
  return { version: SCORE_VERSION, providers: expanded };
}

/**
 * Reads and checks the Score at the given path.
 *
 * Every error is collected rather than thrown, so one run reports every
 * problem instead of the first. A Score with only warnings is `ok`.
 */
export async function loadScore(path = scorePath()): Promise<ScoreResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const report: Report = {
    fail: (message) => errors.push(message),
    warn: (message) => warnings.push(message),
  };

  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return { ok: false, errors: [`cannot read Score: ${path}`], warnings };
  }

  let document: unknown;
  try {
    document = Bun.YAML.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`Score is not valid YAML: ${reason}`], warnings };
  }

  if (!isObjectNode(document)) {
    return { ok: false, errors: ["Score must be a map at the top level"], warnings };
  }

  for (const key of unknownKeys(document, TOP_LEVEL_FIELDS)) {
    report.warn(`unknown top-level key '${key}' — possible typo`);
  }

  const version = document["version"];
  if (version === undefined || version === null) report.fail("version is required");
  else if (String(version) !== SCORE_VERSION) {
    report.fail(`version must be "${SCORE_VERSION}", got ${JSON.stringify(version)}`);
  }

  const providers = document["providers"];
  if (providers === undefined || providers === null) report.fail("providers is required");
  else if (!isObjectNode(providers)) report.fail("providers must be a map of provider id to provider");
  else if (Object.keys(providers).length === 0) report.fail("providers is empty");
  else for (const [id, value] of Object.entries(providers)) checkProvider(id, value, report);

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, score: toScore(providers as Record<string, Provider>), warnings };
}
