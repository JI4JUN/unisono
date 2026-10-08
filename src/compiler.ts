/**
 * Compiling a Score into the shape an Agent's Catalog holds.
 *
 * Both Agents carry the same Catalog tree (docs/mvp-spec.md §3.1): a
 * `providers` map whose entries hold the native Provider fields and a `models`
 * list. The Score's own fields become those native fields, and the field names
 * differ in exactly one place — the Score says `apiType`, the Catalog says
 * `api`. Everything else in a compiled entry comes from that Agent's Override.
 *
 * The compiled Catalog is plain data. Serialization and path resolution belong
 * to the Agent adapters; this module is shared and format-agnostic, which is
 * what lets `unis diff` reason about "what would omp read" without a write.
 */

import { isObjectNode } from "./guards";
import { deepMerge } from "./merger";
import type { Catalog } from "./agent";
import type { Score } from "./score";

/**
 * An Agent's Override block out of the Score, when it declared one.
 *
 * `overrides` is optional, so its absence is not an error: the compiled entry
 * is then the standard mapping alone. An Override that is not a map has no
 * fields to merge and is ignored.
 */
function overridesFor(node: { overrides?: Record<string, unknown> }, agent: string): Record<string, unknown> {
  const block = node.overrides?.[agent];
  return isObjectNode(block) ? block : {};
}

/**
 * Compiles the Score into the Catalog one Agent would end up with.
 *
 * The standard mapping is built first and the Agent's Override is deep-merged
 * on top, which is why the compiled shape can carry Agent-specific fields
 * (`compat`, `cost`, `input`) the Score never names. Non-optional fields are
 * written only when present, so an absent `maxTokens` stays absent rather
 * than appearing as an explicit null.
 */
export function compileCatalog(score: Score, agent: string): Catalog {
  const compiled: Catalog = {};

  for (const [id, provider] of Object.entries(score.providers)) {
    const standard: Record<string, unknown> = {
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.apiType,
      apiKey: provider.apiKey,
    };
    if (provider.headers !== undefined) standard["headers"] = provider.headers;

    const models = provider.models.map((model) => {
      const entry: Record<string, unknown> = {
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
      };
      if (model.maxTokens !== undefined) entry["maxTokens"] = model.maxTokens;
      if (model.reasoning !== undefined) entry["reasoning"] = model.reasoning;
      return deepMerge(entry, overridesFor(model, agent));
    });

    compiled[id] = deepMerge(standard, overridesFor(provider, agent));
    compiled[id]["models"] = models;
  }

  return compiled;
}
