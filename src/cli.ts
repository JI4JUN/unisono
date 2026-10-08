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
import { errorLine, line, writeOut } from "./output";

const USAGE = `unis — one Score, two Agents in unison.

Usage:
  unis sync            Compile the Score into both Agents' Catalogs
  unis sync --yes      Confirm a first takeover
  unis sync --dry-run  Preview the change without writing
  unis diff            Score-compiled Catalog vs the on-disk Catalogs
  unis validate        Check the Score, expand variables, warn on dangling refs
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
  if (!report.installed) {
    line("warn", report.agent.toUpperCase(), report.path, `Skipped (not installed)`);
    return;
  }
  if (report.state === "failed") {
    line("fail", report.agent.toUpperCase(), report.path, `Failed: ${report.reason}`);
    return;
  }
  line("ok", report.agent.toUpperCase(), report.path, `${report.providers} providers, ${report.models} models`);
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
    default:
      errorLine(`unknown command: ${command}`);
      exitWithUsage();
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
