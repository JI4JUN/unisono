/**
 * The Score contract.
 *
 * The Score is one YAML document holding a `version` and a `providers` map.
 * This module reads and checks it — required fields
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

/** A required-or-optional text field must hold a string, and a present one must be non-empty. */
function checkStringField(at: string, value: unknown, report: Report): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    report.fail(`${at} must be a string, got ${JSON.stringify(value)}`);
  } else if (value === "") {
    report.fail(`${at} must not be empty`);
  }
}

/** A required-or-optional integer field must be a whole number above zero. */
function checkPositiveInteger(at: string, value: unknown, report: Report): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    report.fail(`${at} must be an integer, got ${JSON.stringify(value)}`);
  } else if (value <= 0) {
    report.fail(`${at} must be positive, got ${JSON.stringify(value)}`);
  }
}

/**
 * Expands `${VAR_NAME}` to the variable's value.
 *
 * Reports each variable that is undefined or empty — an empty credential must
 * never reach a config.
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

function checkProvider(id: string, value: unknown, report: Report): void {
  const label = `provider '${id}'`;
  if (!isObjectNode(value)) {
    report.fail(`${label} must be a map`);
    return;
  }

  for (const field of ["name", "baseUrl", "apiKey", "apiType", "models"]) {
    if (value[field] === undefined || value[field] === null) {
      report.fail(`${label}.${field} is required`);
    } else if (field !== "models" && value[field] === "") {
      report.fail(`${label}.${field} must not be empty`);
    }
  }

  for (const key of unknownKeys(value, PROVIDER_FIELDS)) {
    report.warn(`unknown field '${key}' in ${label} — possible typo`);
  }

  checkStringField(`${label}.name`, value["name"], report);
  checkStringField(`${label}.baseUrl`, value["baseUrl"], report);
  checkStringField(`${label}.apiKey`, value["apiKey"], report);

  const apiKey = value["apiKey"];
  if (typeof apiKey === "string") {
    expandEnvReferences(apiKey, (name) =>
      report.fail(`${label}.apiKey references environment variable ${name}, which is not defined or is empty`),
    );
  }

  const apiType = value["apiType"];
  if (apiType !== undefined && apiType !== null) {
    if (typeof apiType !== "string" || !(apiType in API_TYPES)) {
      report.fail(`${label}.apiType ${JSON.stringify(apiType)} is not one of ${Object.keys(API_TYPES).join(", ")}`);
    }
  }

  checkModels(label, id, value["models"], report);
}

/**
 * Checks a provider's `models` list.
 *
 * Called after the roster of checks that produced the node, so a provider
 * whose models are absent has already been reported as missing.
 */
function checkModels(label: string, providerId: string, models: unknown, report: Report): void {
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
    checkModel(`${label}.models[${index}]`, entry, providerId, seen, report);
  }
}

function checkModel(
  at: string,
  entry: unknown,
  providerId: string,
  seen: Record<string, true>,
  report: Report,
): void {
  if (!isObjectNode(entry)) {
    report.fail(`${at} must be a map`);
    return;
  }

  for (const field of ["id", "name"]) {
    if (entry[field] === undefined || entry[field] === null) {
      report.fail(`${at}.${field} is required (provider '${providerId}')`);
    } else if (entry[field] === "") {
      report.fail(`${at}.${field} must not be empty`);
    } else if (typeof entry[field] !== "string") {
      report.fail(`${at}.${field} must be a string, got ${JSON.stringify(entry[field])}`);
    }
  }
  if (entry["contextWindow"] === undefined || entry["contextWindow"] === null) {
    report.fail(`${at}.contextWindow is required (provider '${providerId}')`);
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
    checkPositiveInteger(`${at}.${field}`, entry[field], report);
  }
}

/**
 * Builds the valid Score from a node that has already passed every check,
 * so each field's type is established rather than asserted.
 */
function toScore(version: unknown, providers: Record<string, unknown>): Score {
  const built: Record<string, Provider> = {};

  for (const [id, node] of Object.entries(providers)) {
    const provider = node as Record<string, unknown>;
    const models = provider["models"] as Array<Record<string, unknown>>;
    built[id] = {
      name: provider["name"] as string,
      baseUrl: provider["baseUrl"] as string,
      // Already validated, so every reference resolved; expand silently.
      apiKey: expandEnvReferences(provider["apiKey"] as string, () => {}),
      apiType: provider["apiType"] as string,
      ...(isObjectNode(provider["headers"]) ? { headers: provider["headers"] } : {}),
      ...(isObjectNode(provider["overrides"]) ? { overrides: provider["overrides"] } : {}),
      models: models.map((model) => ({
        id: model["id"] as string,
        name: model["name"] as string,
        contextWindow: model["contextWindow"] as number,
        ...(model["maxTokens"] !== undefined ? { maxTokens: model["maxTokens"] as number } : {}),
        ...(model["reasoning"] !== undefined ? { reasoning: model["reasoning"] as boolean } : {}),
        ...(isObjectNode(model["overrides"]) ? { overrides: model["overrides"] } : {}),
      })),
    };
  }

  return { version: String(version), providers: built };
}

/**
 * Reads and checks the Score at the given path.
 *
 * Every error is collected rather than thrown, so one run reports every
 * problem instead of the first. A Score with only warnings is `ok`, and its
 * credentials have been expanded to plaintext.
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

  return errors.length > 0
    ? { ok: false, errors, warnings }
    : { ok: true, score: toScore(version, providers as Record<string, unknown>), warnings };
}
