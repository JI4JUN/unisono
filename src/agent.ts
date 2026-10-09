/**
 * Reading an Agent's Catalog.
 *
 * The Catalog is the top-level `providers` map of the Agent's native config.
 * Parsing is the only place that knows omp speaks YAML and pi speaks JSONC:
 * pi tolerates `//` comments and trailing commas, which is why the built-in
 * JSONC parser is used rather than a comment stripper plus `JSON.parse` (the
 * latter throws on a trailing comma that pi accepts).
 */

import { agentConfigPath, isAgentInstalled, type AgentId } from "./paths";
import { isObjectNode } from "./guards";
import { hashText } from "./writer";

/** A Catalog as parsed from disk: unknown-shaped, but `providers` must be a map. */
export type RawConfig = Record<string, unknown>;

export type Catalog = Record<string, Record<string, unknown>>;

/**
 * Parses an Agent's whole config document.
 *
 * This is the one place that knows omp speaks YAML and pi speaks JSONC: pi
 * tolerates `//` comments and trailing commas, which is why the built-in JSONC
 * parser is used rather than a comment stripper plus `JSON.parse` (the latter
 * throws on a trailing comma that pi accepts). Shared with the sibling-file
 * reads in `src/dangling.ts`, so the format rule is written once — two copies
 * of it would drift the moment one Agent gained a tolerance the other lacks.
 *
 * A document that parses to something other than a map is a throw, not an
 * empty one: the caller is about to read keys out of it, and an empty map
 * would read as "no providers" rather than "this is not a config".
 */
export function parseAgentDocument(agent: AgentId, text: string): RawConfig {
  const parsed: unknown = agent === "omp" ? Bun.YAML.parse(text) : Bun.JSONC.parse(text);
  if (parsed === null || parsed === undefined) return {};
  if (!isObjectNode(parsed)) throw new Error("expected a config object at top level");
  return parsed;
}

/** The `providers` subtree, or an empty Catalog when absent or malformed. */
function catalogOf(config: RawConfig): Catalog {
  const providers = config["providers"];
  if (providers === null || providers === undefined) return {};
  if (typeof providers !== "object" || Array.isArray(providers)) return {};
  return providers as Catalog;
}

function modelsOf(provider: Record<string, unknown> | undefined): number {
  const models = provider?.["models"];
  if (!Array.isArray(models)) return 0;
  return models.length;
}

/** Provider and model counts of a Catalog, for reports and comparisons alike. */
export function countCatalog(catalog: Catalog): { providers: number; models: number } {
  const providers = Object.keys(catalog);
  return {
    providers: providers.length,
    models: providers.reduce((total, id) => total + modelsOf(catalog[id]), 0),
  };
}

/**
 * Reads an Agent's Catalog as parsed data, or reports why it could not be read.
 *
 * Every command that compares, writes, or restores a config parses it through
 * this one function, so `diff` and `sync` agree on what is on disk. A config
 * that cannot be parsed is reported as `failed` with its reason rather than
 * thrown, so one broken Agent does not blind the other.
 */
export async function readCatalog(
  agent: AgentId,
): Promise<
  { ok: true; path: string; catalog: Catalog; text: string; sha256: string | null } |
  { ok: false; path: string; reason: string }
> {
  const path = agentConfigPath(agent);
  if (!isAgentInstalled(agent)) {
    return { ok: false, path, reason: "not installed" };
  }

  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    // The file was expected — `isAgentInstalled` said so — but could not be
    // read. That is this Agent's failure to report, not a crash.
    return { ok: false, path, reason: "cannot be read" };
  }

  // The lock token is hashed from the snapshot text this function just read,
  // never from a second read of the path: an edit landing between the two
  // would be hashed into the token, and the §5.3 re-check would then compare
  // disk against disk and let a stale write through.
  try {
    const config = parseAgentDocument(agent, text);
    return { ok: true, path, catalog: catalogOf(config), text, sha256: hashText(text) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, path, reason };
  }
}
