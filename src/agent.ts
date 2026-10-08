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

/** A Catalog as parsed from disk: unknown-shaped, but `providers` must be a map. */
export type RawConfig = Record<string, unknown>;

export type Catalog = Record<string, Record<string, unknown>>;

/**
 * An Agent's on-disk state.
 *
 * `skipped` means the config file is absent, which is a normal supported state
 * when only one of the two Agents is installed (spec §1.1, story 20).
 */
export type AgentReport = {
  agent: AgentId;
  path: string;
  state: "installed" | "skipped" | "failed";
  providers: number;
  models: number;
  /** Set for `failed`; why parsing the config went wrong. */
  reason?: string;
};

function parseConfig(agent: AgentId, text: string): RawConfig {
  const parsed = agent === "omp" ? Bun.YAML.parse(text) : Bun.JSONC.parse(text);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected a config object at top level");
  }
  return parsed as RawConfig;
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

/**
 * Reads an Agent's config and counts what its Catalog holds.
 *
 * Whether the Catalog matches the Score is a later ticket's question (#3) and
 * is deliberately absent here: `unis list` currently reports presence and size
 * only. A config that cannot be parsed is reported as `failed` with its reason
 * rather than thrown, so one broken Agent does not blind the other.
 */
export async function inspectAgent(agent: AgentId): Promise<AgentReport> {
  const path = agentConfigPath(agent);
  if (!isAgentInstalled(agent)) {
    return { agent, path, state: "skipped", providers: 0, models: 0 };
  }

  let config: RawConfig;
  try {
    config = parseConfig(agent, await Bun.file(path).text());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { agent, path, state: "failed", providers: 0, models: 0, reason };
  }

  const catalog = catalogOf(config);
  const providers = Object.keys(catalog);
  return {
    agent,
    path,
    state: "installed",
    providers: providers.length,
    models: providers.reduce((total, id) => total + modelsOf(catalog[id]), 0),
  };
}
