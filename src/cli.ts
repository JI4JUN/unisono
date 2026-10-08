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

import { AGENT_IDS, scorePath } from "./paths";
import { inspectAgent, type AgentReport } from "./agent";
import { loadScore } from "./score";
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

function reportLine(report: AgentReport): void {
  if (report.state === "skipped") {
    line("warn", report.agent.toUpperCase(), report.path, "Skipped (not installed)");
    return;
  }
  if (report.state === "failed") {
    line("fail", report.agent.toUpperCase(), report.path, `Failed: ${report.reason}`);
    return;
  }
  line("ok", report.agent.toUpperCase(), report.path, `${report.providers} providers, ${report.models} models`);
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

/** `unis list` — the Score in use, then per-Agent path, presence, and size. */
async function commandList(): Promise<number> {
  const reports: AgentReport[] = [];
  for (const agent of AGENT_IDS) {
    reports.push(await inspectAgent(agent));
  }

  writeOut(`🎼 Unisono — one Score, two Agents in unison.`);
  writeOut(`  Score: ${scorePath()}`);
  for (const report of reports) {
    reportLine(report);
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command) exitWithUsage();

  switch (command) {
    case "list":
      return await commandList();
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
