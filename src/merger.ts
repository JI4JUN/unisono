/**
 * Catalog comparison.
 *
 * The comparison is semantic: it walks the parsed
 * Catalog, so key order and indentation are never differences. That is what
 * makes a second `unis sync` report `Unchanged` instead of churning the file,
 * and what lets `unis diff` be read at any time without writing anything.
 *
 * A difference is a name — the provider id, the model id, the field, not a
 * line number, because the two sides may not even be written in the same
 * format: one is YAML, the other could be JSON.
 */

import type { Catalog } from "./agent";
import { isListNode, isObjectNode } from "./guards";
import { renderValue } from "./mask";

/**
 * Deep-merges `overlay` onto `base`, returning a new value.
 *
 * Maps merge recursively; anything else — lists, primitives — is replaced
 * wholesale rather than concatenated, so a model entry's Override can replace
 * a standard field without inheriting the old value's parts. An Override key
 * always wins on a name collision.
 */
export function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = merged[key];
    merged[key] =
      isObjectNode(existing) && isObjectNode(value)
        ? deepMerge(existing, value)
        : value;
  }
  return merged;
}

/** One discovered difference: where it is, and what each side holds. */
export type CatalogDiff = {
  /** A dotted path within the Catalog, e.g. `deepseek.models[1].maxTokens`. */
  at: string;
  /** Compile result line for display, with credentials masked. */
  expected: string;
  /** On-disk line for display, with credentials masked. */
  actual: string;
};

function isSameScalar(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // A typed number against an identical string literal is not a difference:
  // YAML and JSON disagree about these spellings, and so may two Agents.
  if (typeof a === "number" && typeof b === "string") return String(a) === b;
  if (typeof a === "string" && typeof b === "number") return a === String(b);
  return false;
}

/**
 * Collects the differences between two already-parsed Catalogs.
 *
 * Ordering of keys and entries of lists is compared positionally — a list of
 * Models is an ordered Agent-facing sequence, and reordering it is a real
 * change to what the Agent offers.
 */
export function diffCatalog(expected: Catalog, actual: Catalog): CatalogDiff[] {
  const diffs: CatalogDiff[] = [];
  collectProviderDiffs(expected, actual, diffs);
  return diffs;
}

/**
 * The Providers a wholesale takeover would delete, each with the model ids it carries.
 *
 * The gate is stated at Provider granularity (spec §5.1): a Provider the Score
 * does not declare is deleted, and its Models go with it — which is why the
 * model ids are projected alongside it, so the user sees the whole loss by id.
 * A Model dropped from a Provider that survives is not a deletion of a
 * Provider, so it does not gate the takeover; `diff` still reports it as drift.
 */
export function doomedProviders(
  compiled: Catalog,
  actual: Catalog,
): Record<string, string[]> {
  const doomed: Record<string, string[]> = {};
  for (const id of Object.keys(actual)) {
    // `Object.hasOwn`, not `in`: an id like `constructor` is an own key here,
    // and `in` would resolve it against Object.prototype and declare the Score
    // to have Providers it never declared — letting the gate stay shut over a
    // Provider the takeover then deletes silently.
    if (Object.hasOwn(compiled, id)) continue;
    doomed[id] = modelIdsOf(actual[id]);
  }
  return doomed;
}

/** The model ids a Provider's `models` list declares, in file order. */
function modelIdsOf(provider: Record<string, unknown> | undefined): string[] {
  const models = provider?.["models"];
  if (!isListNode(models)) return [];

  const ids: string[] = [];
  for (const model of models) {
    if (!isObjectNode(model)) continue;
    const id = model["id"];
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

/**
 * The Provider-level differences between the two Catalogs, by provider id.
 *
 * `Object.hasOwn` rather than `in` for every id test below: an Agent's Catalog
 * key names whatever the user wrote, so an id like `constructor` is an own key
 * that `in` would resolve against Object.prototype and mistake for being
 * declared on the other side — hiding the very difference being collected.
 */
function collectProviderDiffs(
  expected: Catalog,
  actual: Catalog,
  diffs: CatalogDiff[],
): void {
  for (const id of Object.keys(expected)) {
    if (Object.hasOwn(actual, id)) continue;
    diffs.push({
      at: id,
      expected: renderValue(expected[id], id),
      actual: "<absent — will be added>",
    });
  }
  for (const id of Object.keys(actual)) {
    if (Object.hasOwn(expected, id)) continue;
    diffs.push({
      at: id,
      expected: "<absent — will be removed>",
      actual: renderValue(actual[id], id),
    });
  }

  for (const id of Object.keys(expected)) {
    if (!Object.hasOwn(actual, id)) continue;
    collectNodeDiffs(expected[id], actual[id], id, diffs);
  }
}

function collectNodeDiffs(
  expected: unknown,
  actual: unknown,
  at: string,
  diffs: CatalogDiff[],
): void {
  if (isSameScalar(expected, actual)) return;

  if (isObjectNode(expected) && isObjectNode(actual)) {
    for (const key of new Set([
      ...Object.keys(expected),
      ...Object.keys(actual),
    ])) {
      collectNodeDiffs(
        expected[key],
        actual[key],
        at ? `${at}.${key}` : key,
        diffs,
      );
    }
    return;
  }

  if (isListNode(expected) && isListNode(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      collectNodeDiffs(
        expected[index],
        actual[index],
        `${at}[${index}]`,
        diffs,
      );
    }
    return;
  }

  diffs.push({
    at,
    expected: renderValue(expected, at),
    actual: renderValue(actual, at),
  });
}
