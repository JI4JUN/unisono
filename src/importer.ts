/**
 * Generating a Score draft from an Agent's existing Catalog.
 *
 * The import is the inverse of the compile (`src/compiler.ts`), and its
 * purpose is to give a new user something to edit rather than a blank file:
 * read what an Agent already holds, produce the Score that declares it, and
 * stop there. Nothing is written to either Agent — an import is what makes the
 * first-takeover gate passable by declaration, and silently writing both
 * Catalogs would take the decision away from the operator the gate exists to
 * protect.
 *
 * The hoisting is the part that makes the draft lossless. The common Score
 * schema names a fixed set of fields (spec §2), and an Agent's Catalog carries
 * more than those — omp's `compat`, `cost`, `thinking`, and input declarations
 * are the documented case. A field the schema cannot express goes into
 * `overrides.<agent>` on the node it came from, exactly where the compiler
 * reads it back from, so `import → sync` reconstitutes the Catalog byte for
 * byte in meaning (criterion 6).
 *
 * Every standard field — including `apiKey` — is preserved directly from the
 * Catalog (with pi's on-disk escape form reversed first). How credentials are
 * stored or templated in `score.yaml` is the user's own decision.
 */

import type { Catalog } from "./agent";
import { isListNode, isObjectNode } from "./guards";
import type { AgentId } from "./paths";

/**
 * Catalog provider keys that keep their own name in the Score.
 *
 * These are the Catalog's spellings, not the Score's: `api` is where the
 * Score says `apiType`, and the compiler maps between them. The mirror table
 * in `src/score.ts` is the Score side of the same line and must be read
 * alongside it.
 */
const CATALOG_PROVIDER_FIELDS: Record<string, true> = {
  baseUrl: true,
  api: true,
  apiKey: true,
  headers: true,
  models: true,
};

/** Catalog model keys that keep their own name in the Score. */
const CATALOG_MODEL_FIELDS: Record<string, true> = {
  id: true,
  name: true,
  contextWindow: true,
  maxTokens: true,
  reasoning: true,
};

/** Why a Catalog could not be turned into a Score draft. */
export type ImportFailure = {
  /** The provider whose Catalog entry could not be expressed. */
  provider: string;
  reason: string;
};

export type ImportResult =
  | { ok: true; draft: string; providers: number; models: number }
  | { ok: false; failures: ImportFailure[] };

/**
 * Splits one Catalog node into the fields the Score names and the ones it
 * does not.
 *
 * The split is by key, not by depth: an agent-specific field is hoisted
 * whole, whatever it holds, because a compiled Override can hold any shape and
 * the Score schema says nothing about it.
 */
function splitNode(
  node: Record<string, unknown>,
  known: Record<string, true>,
): {
  standard: Record<string, unknown>;
  override: Record<string, unknown>;
} {
  const standard: Record<string, unknown> = {};
  const override: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (key in known) standard[key] = value;
    else override[key] = value;
  }
  return { standard, override };
}

/** One Catalog model as a Score model. */
function toModel(
  agent: AgentId,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const { standard, override } = splitNode(entry, CATALOG_MODEL_FIELDS);
  return Object.keys(override).length === 0
    ? standard
    : { ...standard, overrides: { [agent]: override } };
}

/**
 * One Catalog provider as a Score provider, or why it could not be expressed.
 *
 * A model entry that is not a map cannot become a Score model, and dropping it
 * silently would produce a draft `unis validate` rejects (spec §2.1 requires at
 * least one model) — an import that exits 0 has claimed the draft is usable,
 * and a provider emptied this way is the one case where that claim is false.
 * So it is reported rather than skipped, exactly like a provider with no models
 * at all.
 *
 * `api` becomes `apiType`, because that is the Score's name for it (spec §3.4);
 * the hoisted fields keep their Catalog names, because the Override is merged
 * onto the compiled entry and those names are what the Agent reads.
 */
function toProvider(
  agent: AgentId,
  entry: Record<string, unknown>,
): { provider: Record<string, unknown> } | { failed: string } {
  const { standard, override } = splitNode(entry, CATALOG_PROVIDER_FIELDS);

  const provider: Record<string, unknown> = {};
  if ("baseUrl" in standard) provider["baseUrl"] = standard["baseUrl"];
  if ("apiKey" in standard) provider["apiKey"] = standard["apiKey"];
  if ("api" in standard) provider["apiType"] = standard["api"];
  if ("headers" in standard) provider["headers"] = standard["headers"];
  if (Object.keys(override).length > 0)
    provider["overrides"] = { [agent]: override };

  const models: Record<string, unknown>[] = [];
  if (isListNode(standard["models"])) {
    for (const [index, item] of standard["models"].entries()) {
      if (!isObjectNode(item))
        return { failed: `models[${index}] is not a map` };
      models.push(toModel(agent, item));
    }
  }
  provider["models"] = models;

  return { provider };
}

/**
 * Reads pi's write form back into what the strings meant.
 *
 * pi's own resolver executes a `!`-leading value as a shell command and
 * expands `$VAR`, so the values on disk are escaped: every `$` doubled, and a
 * leading `!` prefixed with `$`. An import that did not reverse this would
 * put the escape itself into the Score, and the next sync would double it
 * again — every re-import cycling the value one step further from the
 * credential it was. Left to right, so the `$` in `$!` is consumed as part of
 * the prefix and never as the start of a `$$`.
 */
function unescapePi(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (!value.includes("$")) return value;

  let out = "";
  let at = 0;
  while (at < value.length) {
    const pair = value.slice(at, at + 2);
    if (pair === "$$") {
      out += "$";
      at += 2;
    } else if (pair === "$!") {
      out += "!";
      at += 2;
    } else {
      out += value[at];
      at += 1;
    }
  }
  return out;
}

/** The same walk, applied to a whole node. */
function unescapeNode(node: Record<string, unknown> | unknown[]): unknown {
  if (isListNode(node))
    return node.map((item) =>
      isObjectNode(item) ? unescapeNode(item) : unescapePi(item),
    );
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] =
      typeof value === "string"
        ? unescapePi(value)
        : isObjectNode(value) || isListNode(value)
          ? unescapeNode(value)
          : value;
  }
  return out;
}

/**
 * One node with the agent's write form reversed.
 *
 * Only pi escapes on write (`src/pi-write.ts`), so only pi's values carry a
 * write form to reverse. Running the reversal on omp's Catalog — which is
 * stored as written — would rewrite a value that legitimately held a `$` or a
 * leading `!`, and the next sync would write the mangled value back to omp:
 * a value that its own Score said nothing about, changed by the import that
 * was supposed to describe it faithfully.
 */
function fromAgent(
  agent: AgentId,
  node: Record<string, unknown>,
): Record<string, unknown> {
  if (agent !== "pi") return node;
  const walked = unescapeNode(node);
  // The walk was given a map, so it gives one back. Guarded rather than cast,
  // because what it returns is `unknown` by construction.
  return isObjectNode(walked) ? walked : {};
}

/**
 * Generates a Score draft from a parsed Catalog.
 *
 * A Catalog entry that is not a map, or that cannot be expressed at all, is a
 * failure rather than something to skip: a draft that silently drops a
 * provider is worse than one that reports it, because the reader cannot tell
 * what is missing from what they never had.
 */
export function generateDraft(agent: AgentId, catalog: Catalog): ImportResult {
  const providers: Record<string, Record<string, unknown>> = {};
  const failures: ImportFailure[] = [];

  for (const [id, entry] of Object.entries(catalog)) {
    if (!isObjectNode(entry)) {
      failures.push({ provider: id, reason: "catalog entry is not a map" });
      continue;
    }

    const node = fromAgent(agent, entry);
    if (!isListNode(node["models"]) || node["models"].length === 0) {
      failures.push({
        provider: id,
        reason: "a Score provider must declare at least one model",
      });
      continue;
    }

    const made = toProvider(agent, node);
    if ("failed" in made) {
      failures.push({ provider: id, reason: made.failed });
      continue;
    }
    providers[id] = made.provider;
  }

  if (failures.length > 0) return { ok: false, failures };

  let models = 0;
  for (const provider of Object.values(providers)) {
    if (isListNode(provider["models"])) models += provider["models"].length;
  }
  const draft = Bun.YAML.stringify({ version: "1", providers }, null, 2);
  return {
    ok: true,
    draft: `${draft.replace(/\s+$/, "")}\n`,
    providers: Object.keys(providers).length,
    models,
  };
}
