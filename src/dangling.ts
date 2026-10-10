/**
 * Dangling default-model references.
 *
 * A default model lives outside the Catalog — omp keeps it in the sibling
 * `config.yml`, pi in its sibling `settings.json` — and a takeover replaces
 * the Catalog wholesale (ADR 0001). So a sync can leave a default pointing at
 * a Provider or Model that no longer exists, and the only honest thing a
 * compiler can say about that is: say it.
 *
 * That is the whole of the behavior. These settings are the user's, not the
 * compiler's, so nothing here edits anything; the checks read the sibling
 * files and report what no longer resolves. Both Agents' checks run on every
 * surface that compares, so an orphaning change is visible before a sync
 * writes it and after one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentDocument } from "./agent";
import { isListNode, isObjectNode } from "./guards";

/** A reference that no longer resolves, for the warning surface. */
export type DanglingReference = {
  /** The Agent the reference belongs to, for the warning's prefix. */
  agent: "omp" | "pi";
  /** Which setting carried it, e.g. `modelRoles` or `defaultModel`. */
  setting: string;
  /** The reference as written, e.g. `old-proxy/m1`. */
  reference: string;
  /** The provider id it names, whether or not one survived. */
  provider: string;
};

/**
 * Reads and parses one sibling config file, or yields no defaults at all.
 *
 * The sibling is read with the tolerance its own Agent has — YAML for omp,
 * JSONC for pi — and a file that is absent or unparseable yields an empty
 * document rather than an error. A default that cannot be read is not a
 * dangling one, so treating an unreadable sibling as "no defaults" is the
 * only answer that does not invent a problem. The file is only ever read: the
 * takeover replaces a Catalog, and this file holds no Catalog.
 *
 * The format dispatch is `parseAgentDocument`'s, the same one `readCatalog`
 * uses: a sibling and a config for the same Agent are read the same way, and
 * two copies of that rule would drift the moment one gained a tolerance the
 * other lacked.
 */
function readSibling(
  agent: "omp" | "pi",
  path: string,
): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = parseAgentDocument(agent, text);
  } catch {
    return {};
  }
  return isObjectNode(parsed) ? parsed : {};
}

/** Whether `reference` names a provider the Catalog still declares. */
function survivesProvider(
  reference: string,
  providers: Record<string, unknown>,
): boolean {
  return Object.hasOwn(providers, reference);
}

/** The provider half of a `<provider>/<model>[:thinking]` reference. */
function providerOf(reference: string): string {
  return reference.split("/")[0] ?? "";
}

/**
 * One setting's references as strings, in whichever of the three shapes the
 * Agent writes them: a lone string, a map keyed by reference, or a list of
 * references.
 */
function referencesOf(entry: unknown): string[] {
  if (typeof entry === "string") return [entry];
  if (isListNode(entry))
    return entry.filter((item): item is string => typeof item === "string");
  if (isObjectNode(entry)) return Object.keys(entry);
  return [];
}

/**
 * omp's dangling defaults, from `config.yml`'s `modelRoles` and `enabledModels`.
 *
 * A `modelRoles` entry reads `<provider>/<model>[:thinking]`, and both
 * settings may be written either as a map of references or as a list of
 * them. The provider half is the half that resolves: a reference whose
 * provider was removed is dangling whatever its model, and naming the
 * provider is what a reader can act on.
 */
export function ompDanglingReferences(
  dir: string,
  providers: Record<string, unknown>,
): DanglingReference[] {
  const config = readSibling("omp", join(dir, "config.yml"));
  const found: DanglingReference[] = [];

  for (const setting of ["modelRoles", "enabledModels"]) {
    for (const reference of referencesOf(config[setting])) {
      const provider = providerOf(reference);
      if (!survivesProvider(provider, providers)) {
        found.push({ agent: "omp", setting, reference, provider });
      }
    }
  }

  return found;
}

/**
 * pi's dangling defaults, from `settings.json`'s `defaultProvider` and
 * `defaultModel`.
 *
 * `defaultProvider` names a provider directly; `defaultModel` reads
 * `<provider>/<model>`, so its provider half is the half that is checked —
 * the model half cannot dangle without the provider it hangs from having
 * already gone, which the check on the provider half reports.
 */
export function piDanglingReferences(
  dir: string,
  providers: Record<string, unknown>,
): DanglingReference[] {
  const settings = readSibling("pi", join(dir, "settings.json"));
  const found: DanglingReference[] = [];

  const direct = settings["defaultProvider"];
  if (typeof direct === "string" && !survivesProvider(direct, providers)) {
    found.push({
      agent: "pi",
      setting: "defaultProvider",
      reference: direct,
      provider: direct,
    });
  }

  const model = settings["defaultModel"];
  if (typeof model === "string") {
    const provider = providerOf(model);
    if (!survivesProvider(provider, providers)) {
      found.push({
        agent: "pi",
        setting: "defaultModel",
        reference: model,
        provider,
      });
    }
  }

  return found;
}

/** One warning line per dangling reference, as the warning surface prints it. */
export function formatDangling(reference: DanglingReference): string {
  return `[${reference.agent.toUpperCase()}] ${reference.setting} references removed provider '${reference.provider}'`;
}
