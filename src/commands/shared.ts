/**
 * Shared Catalog comparison, reporting, Score loading, and argument validation
 * helpers used across the CLI subcommands.
 */

import type { ArgsDef } from "citty";
import { compileCatalog } from "../compiler";
import { countCatalog, readCatalog } from "../agent";
import { formatDangling, ompDanglingReferences, piDanglingReferences } from "../dangling";
import { diffCatalog, doomedProviders, type CatalogDiff } from "../merger";
import { errorLine, line, writeErr, writeOut } from "../output";
import { agentBaseDir, scorePath, type AgentId } from "../paths";
import { escapePiCatalog } from "../pi-write";
import { loadScore, type Score } from "../score";
import { atomicWrite, type WriteResult } from "../writer";

export const UNREADABLE_CONFIG_MESSAGE = "Failed: config cannot be read or parsed";

/**
 * One Agent's Catalog compared against the Score's compiled one.
 *
 * `state` is the state word this Agent's report line will carry, so the line
 * cannot claim a comparison that never happened.
 */
export type AgentCompare = {
  agent: AgentId;
  path: string;
  state: "synced" | "drifts" | "skipped" | "failed" | "uncomparable";
  /** Provider and model counts of the on-disk Catalog. */
  disk: { providers: number; models: number };
  /** Provider and model counts of the compiled Catalog. */
  compiled: { providers: number; models: number };
  /** The semantic differences, empty unless the state is `synced` or `drifts`. */
  diffs: CatalogDiff[];
  /** Providers a takeover would delete, empty unless the state is `drifts`. */
  doomed: Record<string, string[]>;
};

/**
 * Reports one Agent's comparison, and says whether it needs writing.
 */
export function reportCompare(
  compare: AgentCompare,
  equalWord: "Synced" | "Unchanged",
): {
  writable: boolean;
  failed: boolean;
} {
  const tag = compare.agent.toUpperCase();

  if (compare.state === "skipped") {
    line("warn", tag, compare.path, "Skipped (not installed)");
    return { writable: false, failed: false };
  }
  if (compare.state === "failed") {
    line("fail", tag, compare.path, UNREADABLE_CONFIG_MESSAGE);
    return { writable: false, failed: true };
  }
  if (compare.state === "uncomparable") {
    const counts = compare.disk;
    line("warn", tag, compare.path, `${counts.providers} providers, ${counts.models} models`);
    return { writable: false, failed: false };
  }

  const counts = compare.disk;
  if (compare.state === "synced") {
    line(
      "ok",
      tag,
      compare.path,
      `${equalWord} (${compare.compiled.providers} providers, ${compare.compiled.models} models)`,
    );
    return { writable: false, failed: false };
  }

  line(
    "warn",
    tag,
    compare.path,
    `drifts in ${compare.diffs.length} field(s) (${counts.providers} providers, ${counts.models} models)`,
  );
  for (const diff of compare.diffs) {
    writeOut(`    ${diff.at}`);
    writeOut(`      Score says  ${diff.expected}`);
    writeOut(`      on disk     ${diff.actual}`);
  }
  return { writable: true, failed: false };
}

/**
 * Loads the Score from its resolved path, printing any validation errors or
 * warnings and setting `process.exitCode = 1` on failure.
 */
export async function loadValidScore(): Promise<{ path: string; score: Score } | null> {
  const path = scorePath();
  const result = await loadScore(path);
  if (!result.ok) {
    for (const error of result.errors) errorLine(`${path}: ${error}`);
    process.exitCode = 1;
    return null;
  }
  for (const warning of result.warnings) writeErr(`⚠ ${warning}`);
  return { path, score: result.score };
}

/**
 * The dangling-reference warnings for both Agents, as printed lines.
 */
export function danglingWarnings(score: Score): string[] {
  return [
    ...ompDanglingReferences(agentBaseDir("omp"), score.providers).map(formatDangling),
    ...piDanglingReferences(agentBaseDir("pi"), score.providers).map(formatDangling),
  ];
}

/**
 * Compares one Agent's Catalog against the Score's when a Score is supplied,
 * or returns a count-only `uncomparable` report when no Score could be read.
 */
export async function compareAgent(agent: AgentId, score?: Score): Promise<AgentCompare> {
  const read = await readCatalog(agent);

  if (!read.ok) {
    return {
      agent,
      path: read.path,
      state: read.reason === "not installed" ? "skipped" : "failed",
      disk: { providers: 0, models: 0 },
      compiled: { providers: 0, models: 0 },
      diffs: [],
      doomed: {},
    };
  }

  const disk = countCatalog(read.catalog);
  if (score === undefined) {
    return {
      agent,
      path: read.path,
      state: "uncomparable",
      disk,
      compiled: { providers: 0, models: 0 },
      diffs: [],
      doomed: {},
    };
  }

  const compiled = compileCatalog(score, agent);
  const asOnDisk = agent === "pi" ? escapePiCatalog(compiled) : compiled;
  const diffs = diffCatalog(asOnDisk, read.catalog);
  const doomed = doomedProviders(asOnDisk, read.catalog);
  return {
    agent,
    path: read.path,
    state: diffs.length === 0 ? "synced" : "drifts",
    disk,
    compiled: countCatalog(compiled),
    diffs,
    doomed,
  };
}

/**
 * Writes an Agent's config atomically, reporting what happened.
 */
export function writeFile(path: string, content: string, sha256: string | null): WriteResult {
  try {
    return atomicWrite(path, content, sha256);
  } catch (error) {
    errorLine(`cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return { wrote: false, reason: "write-failed" };
  }
}

/**
 * Returns the first flag in `rawArgs` not declared in `argsDef`, or `undefined`.
 *
 * Allowed flag names are derived directly from the command's `citty` `args`
 * definition so flag declarations live in one place, while still rejecting
 * undeclared flags that `citty`'s `parseArgs({ strict: false })` would ignore.
 */
export function findUnknownFlag(rawArgs: string[], argsDef: ArgsDef = {}): string | undefined {
  const allowed: Record<string, true> = {};
  for (const [name, def] of Object.entries(argsDef)) {
    if (def.type === "positional") continue;
    allowed[`--${name}`] = true;
    if ("alias" in def && def.alias !== undefined) {
      const aliases = Array.isArray(def.alias) ? def.alias : [def.alias];
      for (const alias of aliases) {
        allowed[alias.length === 1 ? `-${alias}` : `--${alias}`] = true;
      }
    }
  }

  for (const arg of rawArgs) {
    if (arg === "--") break;
    if (!arg.startsWith("-")) continue;
    const flag = arg.split("=")[0] ?? arg;
    if (!allowed[flag]) return flag;
  }
  return undefined;
}
