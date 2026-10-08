#!/usr/bin/env bun
/**
 * `unis` — one Score, two Agents in unison.
 *
 * Command surface (docs/mvp-spec.md §4): `sync`, `diff`, `validate`, `list`,
 * `import`, `rollback`. Routing is hand-written on `Bun.argv`; the command set
 * is small and a framework would add weight without adding capability.
 *
 * Exit codes (§4.2): 0 success or all-Unchanged, 1 validation failure /
 * missing variable / write failure, 2 unconfirmed first takeover.
 */

import { AGENT_IDS, scorePath, type AgentId } from "./paths";
import { countCatalog, inspectAgent, readCatalog, type AgentReport } from "./agent";
import { loadScore, type Score } from "./score";
import { compileCatalog } from "./compiler";
import { replaceCatalogNode } from "./sync";
import { atomicWrite, type WriteResult } from "./writer";
import { diffCatalog, type CatalogDiff } from "./merger";
import { errorLine, line, writeErr, writeOut } from "./output";

const USAGE = `unis — one Score, two Agents in unison.

Usage:
  unis sync            Compile the Score into both Agents' Catalogs
  unis sync --yes      Confirm a first takeover
  unis sync --dry-run  Preview the change without writing
  unis diff            Score-compiled Catalog vs the on-disk Catalogs
  unis validate        Check the Score and expand credential references
  unis list            Show each Agent's path, presence, and Catalog counts
  unis import <agent>  Generate a Score draft from an Agent's Catalog (omp | pi)
  unis rollback        Restore the most recent snapshot
  unis rollback --list List retained snapshots
  unis rollback <ts>   Restore a specific snapshot

Exit codes: 0 ok or unchanged, 1 failure, 2 takeover refused`;

function exitWithUsage(): never {
  writeOut("");
  for (const usageLine of USAGE.split("\n")) writeOut(usageLine);
  process.exit(1);
}

/**
 * One report line for an Agent.
 *
 * The state words come from the spec's output contract (§4.1): `Skipped
 * (not installed)`, `Failed`, and — when a Score was readable — `Synced` for a
 * Catalog that already equals the compiled one, otherwise `drifts in N
 * field(s)`. `Unchanged` is kept for `unis sync`, where it names the effect
 * of the write that did not happen.
 */
function reportLine(compare: AgentCompare): void {
  const tag = compare.agent.toUpperCase();

  if (compare.state === "skipped") {
    line("warn", tag, compare.path, "Skipped (not installed)");
    return;
  }
  if (compare.state === "failed") {
    line("fail", tag, compare.path, "Failed: config cannot be parsed");
    return;
  }

  const counts = compare.disk;
  if (compare.state === "uncomparable") {
    line("warn", tag, compare.path, `${counts.providers} providers, ${counts.models} models`);
    return;
  }

  if (compare.state === "synced") {
    line("ok", tag, compare.path, `Synced (${counts.providers} providers, ${counts.models} models)`);
    return;
  }
  line(
    "warn",
    tag,
    compare.path,
    `drifts in ${compare.diffs.length} field(s) (${counts.providers} providers, ${counts.models} models)`,
  );
}

/**
 * The count-only report used when no Score could be read.
 *
 * There is nothing to compare against, so the state is `uncomparable` and the
 * line reports presence, parse failure, and size — what `unis list` reported
 * before a compare existed. `uncomparable` deliberately does not say the
 * Agent is in sync; no comparison was made.
 */
function countOnly(report: AgentReport): AgentCompare {
  return {
    agent: report.agent,
    path: report.path,
    state: report.state === "skipped" ? "skipped" : report.state === "failed" ? "failed" : "uncomparable",
    disk: { providers: report.providers, models: report.models },
    compiled: { providers: 0, models: 0 },
    diffs: [],
  };
}

/**
 * `unis validate` — check the Score and write nothing.
 *
 * A Score with only warnings exits 0; any error exits 1. Environment
 * expansion happens here, so a missing credential is caught before any
 * sync could write a blank key. Dangling-reference warnings arrive with
 * their own ticket; this command reports only Score problems.
 */
async function commandValidate(): Promise<number> {
  const path = scorePath();
  const result = await loadScore(path);
  if (!result.ok) {
    for (const error of result.errors) errorLine(`${path}: ${error}`);
    return 1;
  }

  for (const warning of result.warnings) writeErr(`⚠ ${warning}`);

  const providers = Object.values(result.score.providers);
  const models = providers.reduce((total, provider) => total + provider.models.length, 0);
  line("ok", "Score", path, `valid (${providers.length} providers, ${models} models)`);
  return 0;
}

/**
 * One Agent's Catalog compared against the Score's compiled one.
 *
 * `state` is the state word this Agent's report line will carry, so the line
 * cannot claim a comparison that never happened.
 */
type AgentCompare = {
  agent: AgentId;
  path: string;
  state: "synced" | "drifts" | "skipped" | "failed" | "uncomparable";
  /** Provider and model counts of the on-disk Catalog. */
  disk: { providers: number; models: number };
  /** Provider and model counts of the compiled Catalog. */
  compiled: { providers: number; models: number };
  /** The semantic differences, empty unless the state is `synced` or `drifts`. */
  diffs: CatalogDiff[];
  /** The takeover content to write, when there is anything to take over. */
  write?: { content: string; sha256: string | null };
};

/** Compares one Agent's Catalog against the Score's, reporting rather than throwing. */
async function compareAgent(agent: AgentId, score: Score): Promise<AgentCompare> {
  const read = await readCatalog(agent);

  if (!read.ok) {
    // `not installed` is a supported state, not a fault; anything else is a
    // config this command could not parse.
    return {
      agent,
      path: read.path,
      state: read.reason === "not installed" ? "skipped" : "failed",
      disk: { providers: 0, models: 0 },
      compiled: { providers: 0, models: 0 },
      diffs: [],
    };
  }

  const compiled = compileCatalog(score, agent);
  const diffs = diffCatalog(compiled, read.catalog);
  if (diffs.length === 0) {
    return {
      agent,
      path: read.path,
      state: "synced",
      disk: countCatalog(read.catalog),
      compiled: countCatalog(compiled),
      diffs,
    };
  }

  return {
    agent,
    path: read.path,
    state: "drifts",
    disk: countCatalog(read.catalog),
    compiled: countCatalog(compiled),
    diffs,
    write: {
      content: replaceCatalogNode(read.text, compiled),
      sha256: read.sha256,
    },
  };
}

/**
 * `unis diff` — the Score-compiled Catalog against each Agent's on-disk one.
 *
 * Writes nothing: it is the read-only proof that the compiler and the Override
 * rules are right, and the surface a user can run at any time to audit drift.
 */
async function commandDiff(): Promise<number> {
  const path = scorePath();
  const result = await loadScore(path);
  if (!result.ok) {
    for (const error of result.errors) errorLine(`${path}: ${error}`);
    return 1;
  }
  for (const warning of result.warnings) writeErr(`⚠ ${warning}`);

  writeOut(`🎼 Unisono — one Score, two Agents in unison.`);
  let drifting = 0;
  let failed = false;
  for (const agent of AGENT_IDS) {
    const compare = await compareAgent(agent, result.score);
    const tag = agent.toUpperCase();

    if (compare.state === "skipped") {
      line("warn", tag, compare.path, "Skipped (not installed)");
      continue;
    }
    if (compare.state === "failed") {
      line("fail", tag, compare.path, "Failed: config cannot be parsed");
      failed = true;
      continue;
    }

    if (compare.state === "synced") {
      line(
        "ok",
        tag,
        compare.path,
        `Unchanged (${compare.compiled.providers} providers, ${compare.compiled.models} models)`,
      );
      continue;
    }

    drifting += 1;
    line("warn", tag, compare.path, `drifts in ${compare.diffs.length} field(s)`);
    for (const diff of compare.diffs) {
      writeOut(`    ${diff.at}`);
      writeOut(`      Score says  ${diff.expected}`);
      writeOut(`      on disk     ${diff.actual}`);
    }
  }

  if (drifting === 0 && !failed) {
    writeOut("Catalogs are unchanged; a sync would write nothing.");
  }
  return failed ? 1 : 0;
}

/**
 * `unis sync` — take both Agents' Catalogs over with the compiled one.
 *
 * The comparison is the switch: an Agent whose Catalog already equals what the
 * Score compiles to is left completely alone — no snapshot, no write, mtime
 * untouched — and reports `Unchanged`. Only a real difference reaches the write
 * path, so a second sync of an unchanged Score is a no-op rather than a
 * churn of bytes.
 *
 * `--dry-run` performs the same comparison and reports the same differences
 * without writing, which is what makes it safe to run before a takeover.
 */
async function commandSync(dryRun: boolean): Promise<number> {
  const path = scorePath();
  const result = await loadScore(path);
  if (!result.ok) {
    for (const error of result.errors) errorLine(`${path}: ${error}`);
    return 1;
  }
  for (const warning of result.warnings) writeErr(`⚠ ${warning}`);

  writeOut(`🎼 Unisono — one Score, two Agents in unison.`);
  let drifting = 0;
  let failed = false;
  for (const agent of AGENT_IDS) {
    const compare = await compareAgent(agent, result.score);
    const tag = agent.toUpperCase();

    if (compare.state === "skipped") {
      line("warn", tag, compare.path, "Skipped (not installed)");
      continue;
    }
    if (compare.state === "failed") {
      line("fail", tag, compare.path, "Failed: config cannot be parsed");
      failed = true;
      continue;
    }

    if (compare.state === "synced") {
      line(
        "ok",
        tag,
        compare.path,
        `Unchanged (${compare.compiled.providers} providers, ${compare.compiled.models} models)`,
      );
      continue;
    }

    const write = compare.write;
    if (write === undefined) continue;

    drifting += 1;
    line("warn", tag, compare.path, `drifts in ${compare.diffs.length} field(s)`);
    for (const diff of compare.diffs) {
      writeOut(`    ${diff.at}`);
      writeOut(`      Score says  ${diff.expected}`);
      writeOut(`      on disk     ${diff.actual}`);
    }
    if (dryRun) continue;

    const written = writeFile(compare.path, write.content, write.sha256);
    if (!written.wrote) {
      errorLine(`[${tag}] ${compare.path} changed underneath this sync; nothing was written`);
      failed = true;
      continue;
    }
    line(
      "ok",
      tag,
      compare.path,
      `Synced (${compare.compiled.providers} providers, ${compare.compiled.models} models)`,
    );
  }

  return failed ? 1 : 0;
}

/**
 * Writes an Agent's config atomically, reporting what happened.
 *
 * The file's hash is re-checked inside the write, so a concurrent edit aborts
 * rather than being silently overwritten.
 */
function writeFile(path: string, content: string, sha256: string | null): WriteResult {
  try {
    return atomicWrite(path, content, sha256);
  } catch (error) {
    errorLine(`cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return { wrote: false, reason: "changed-underneath" };
  }
}

/**
 * `unis list` — the Score in use, then per-Agent path, presence, and size.
 *
 * When the Score can be read, each Agent is compared against its compiled
 * Catalog and reported `Synced`, or drifting. Without a readable Score there
 * is nothing to compare against, so presence and size are all that can be
 * reported — which is what `unis list` did before this ticket.
 */
async function commandList(): Promise<number> {
  writeOut(`🎼 Unisono — one Score, two Agents in unison.`);
  writeOut(`  Score: ${scorePath()}`);

  const scoreResult = await loadScore(scorePath());
  if (!scoreResult.ok) {
    writeErr(`⚠ [Score] not comparable: ${scoreResult.errors[0]}`);
    for (const agent of AGENT_IDS) reportLine(countOnly(await inspectAgent(agent)));
    return 0;
  }

  for (const agent of AGENT_IDS) reportLine(await compareAgent(agent, scoreResult.score));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command) exitWithUsage();

  switch (command) {
    case "sync": {
      // `--dry-run` previews the same takeover without writing; any other
      // flag is a typo the user should hear about, not silence to ignore.
      const dryRun = argv[1] === "--dry-run";
      if (argv[1] !== undefined && !dryRun) {
        errorLine(`unknown flag: ${argv[1]}`);
        exitWithUsage();
      }
      return await commandSync(dryRun);
    }
    case "list":
      return await commandList();
    case "diff":
      return await commandDiff();
    case "validate":
      return await commandValidate();
    default:
      errorLine(`unknown command: ${command}`);
      exitWithUsage();
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
