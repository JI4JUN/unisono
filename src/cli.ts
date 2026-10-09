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

import { agentBaseDir, agentConfigPath, AGENT_IDS, configBase, scorePath, type AgentId } from "./paths";
import { existsSync } from "node:fs";
import { countCatalog, readCatalog } from "./agent";
import { loadScore, type Score } from "./score";
import { compileCatalog } from "./compiler";
import { replaceCatalogNode } from "./sync";
import { escapePiCatalog, replacePiCatalogNode } from "./pi-write";
import { atomicWrite, type WriteResult } from "./writer";
import {
  listSnapshots,
  restoreSnapshot,
  rotateSnapshots,
  RETAINED_SNAPSHOTS,
  snapshotDir,
  takeSnapshot,
} from "./backup";
import { diffCatalog, doomedProviders, type CatalogDiff } from "./merger";
import { formatDangling, ompDanglingReferences, piDanglingReferences } from "./dangling";
import { generateDraft } from "./importer";
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
 * The `Failed` status line for an Agent whose config could not be used.
 *
 * Reading and parsing both fail here, and the reason names which: a config
 * that cannot be parsed is a different fault from one that cannot be read.
 */
function failedLine(tag: string, path: string): void {
  line("fail", tag, path, "Failed: config cannot be read or parsed");
}

/**
 * Reports one Agent's comparison, and says whether it needs writing.
 *
 * Both `unis diff` and `unis sync` open with the same per-Agent pass: read,
 * compare, print. The wording of a state is one decision, not two — a run that
 * says `Unchanged` for a Catalog another command calls `Synced` is a bug in
 * the output, not in the state. So the printing lives here and the two
 * commands differ only in what they do with the answer.
 *
 * The two spellings of the equal state are the one difference: `unis list`
 * reports `Synced` (spec §4.1 lists both words), because it answers "is this
 * Agent in the state the Score describes", while `unis diff` and `unis sync`
 * report `Unchanged`, because they answer "would a write change anything".
 *
 * The three states that carry no comparison are the ones a report cannot make
 * a claim about: `skipped` (not installed), `failed` (unreadable), and
 * `uncomparable` (no Score to compare against). `drifts` prints the
 * differences themselves, masked.
 *
 * Returns whether this Agent still needs a write, so the caller does not
 * re-derive it from the state words.
 */
function reportCompare(compare: AgentCompare, equalWord: "Synced" | "Unchanged"): {
  writable: boolean;
  failed: boolean;
} {
  const tag = compare.agent.toUpperCase();

  if (compare.state === "skipped") {
    line("warn", tag, compare.path, "Skipped (not installed)");
    return { writable: false, failed: false };
  }
  if (compare.state === "failed") {
    failedLine(tag, compare.path);
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
 * The count-only report used when no Score could be read.
 *
 * There is nothing to compare against, so the state is `uncomparable` and the
 * line reports presence, parse failure, and size — what `unis list` reported
 * before a compare existed. `uncomparable` deliberately does not say the
 * Agent is in sync; no comparison was made.
 *
 * Built from the same `readCatalog` every other command reads through, so a
 * config this command reports as parseable is one `unis diff` would parse the
 * same way. A second read path here would be a second opinion about what is on
 * disk, and the two would drift.
 */
async function countOnly(agent: AgentId): Promise<AgentCompare> {
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

  const counts = countCatalog(read.catalog);
  return {
    agent,
    path: read.path,
    state: "uncomparable",
    disk: counts,
    compiled: { providers: 0, models: 0 },
    diffs: [],
    doomed: {},
  };
}

/**
 * The dangling-reference warnings for both Agents, as printed lines.
 *
 * Both Agents' siblings are read against the compiled Catalog, because a
 * takeover is what creates a dangling reference and a takeover targets both.
 * Running the checks only for the Agent that changed would hide a default on
 * the other side that the same write orphaned.
 */
function danglingWarnings(score: Score): string[] {
  return [
    ...ompDanglingReferences(agentBaseDir("omp"), score.providers).map(formatDangling),
    ...piDanglingReferences(agentBaseDir("pi"), score.providers).map(formatDangling),
  ];
}

/**
 * `unis validate` — check the Score and write nothing.
 *
 * A Score with only warnings exits 0; any error exits 1. Environment
 * expansion happens here, so a missing credential is caught before any
 * sync could write a blank key. The dangling-reference checks run here too,
 * so an orphaning change is visible before a sync writes it.
 */
async function commandValidate(): Promise<number> {
  const path = scorePath();
  const result = await loadScore(path);
  if (!result.ok) {
    for (const error of result.errors) errorLine(`${path}: ${error}`);
    return 1;
  }

  for (const warning of result.warnings) writeErr(`⚠ ${warning}`);
  for (const warning of danglingWarnings(result.score)) writeErr(`⚠ ${warning}`);

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
  /** Providers a takeover would delete, empty unless the state is `drifts`. */
  doomed: Record<string, string[]>;
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
      doomed: {},
    };
  }

  const compiled = compileCatalog(score, agent);
  // pi's on-disk Catalog is in write form: the escape is what puts it there, so
  // comparing against the unescaped compiled Catalog would report the escape
  // itself as drift on every sync forever — breaking convergence for any value
  // that needs one. The compiled side is escaped to match, so the difference is
  // a real difference in what the Score says, not a difference in encoding.
  const asOnDisk = agent === "pi" ? escapePiCatalog(compiled) : compiled;
  const diffs = diffCatalog(asOnDisk, read.catalog);
  const doomed = doomedProviders(asOnDisk, read.catalog);
  return {
    agent,
    path: read.path,
    state: diffs.length === 0 ? "synced" : "drifts",
    disk: countCatalog(read.catalog),
    compiled: countCatalog(compiled),
    diffs,
    doomed,
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
    const reported = reportCompare(await compareAgent(agent, result.score), "Unchanged");
    failed = failed || reported.failed;
    // Only a drifting Agent makes this command's closing line false, so the
    // count is of writable ones — the states that carry no comparison cannot
    // be drifting, because nothing was compared.
    if (reported.writable) drifting += 1;
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
async function commandSync(dryRun: boolean, yes: boolean): Promise<number> {
  const path = scorePath();
  const result = await loadScore(path);
  if (!result.ok) {
    for (const error of result.errors) errorLine(`${path}: ${error}`);
    return 1;
  }
  for (const warning of result.warnings) writeErr(`⚠ ${warning}`);

  writeOut(`🎼 Unisono — one Score, two Agents in unison.`);
  let failed = false;

  // Phase one compares every Agent and prints its state. Nothing is written
  // yet, so the wholesale-takeover gate can consider all of them: a single
  // Agent whose Catalog holds Providers the Score does not declare refuses the
  // whole sync, which is what stops an operator from losing a hand-written
  // entry on one Agent while a routine drift was being fixed on the other.
  const gated: string[] = [];
  const writable: AgentCompare[] = [];
  for (const agent of AGENT_IDS) {
    const compare = await compareAgent(agent, result.score);
    const reported = reportCompare(compare, "Unchanged");
    failed = failed || reported.failed;
    // A doomed Agent is written too when the gate is passed, because the
    // deletion is exactly what `--yes` confirms — so refusing to write it would
    // make the flag meaningless. The gate below decides whether this proceeds.
    if (reported.writable) {
      const doomedIds = Object.keys(compare.doomed);
      if (doomedIds.length > 0) gated.push(`${agent.toUpperCase()}: ${listDoomed(compare.doomed)}`);
      writable.push(compare);
    }
  }

  // `--dry-run` only previews, so it reports the deletions without demanding
  // the confirmation it will never act on. Refusing there would send a user who
  // ran the safe preview to exit 2, implying an imminent write. The gate is
  // therefore armed for a real sync unless explicitly confirmed with `--yes`,
  // and `unis import` clears it by putting those Providers in the Score.
  if (gated.length > 0 && !dryRun && !yes) {
    // Awaited, not fired: `main` ends in process.exit, which would cut the
    // stderr writes off mid-flight and leave an operator with a truncated
    // deletion list — the one message that must survive a redirected log.
    for (const refusal of takeoverRefusals(gated)) await writeErr(refusal);
    return 2;
  }

  // The warning surface runs after the status lines, on its own lines: a run
  // whose only problem is a warning still exits 0, which is why these are
  // warnings and not errors. Nothing here edits a sibling file — the default
  // is the user's setting, and the takeover replaces only a Catalog.
  for (const warning of danglingWarnings(result.score)) writeErr(`⚠ ${warning}`);

  // Phase two writes. The takeover content is built here rather than in
  // `compareAgent`, because a comparison is what `unis diff` and `unis list`
  // also want and they never write: splicing every drifting Catalog for them
  // would be work thrown away. Only this command pays for it.
  const targets = writable.filter((compare) => !dryRun);

  // The snapshot is taken before the first write, so the files it holds are the
  // ones a rollback must put back — never the ones this sync is replacing. An
  // `Unchanged` sync has no targets and takes no snapshot at all.
  if (targets.length > 0) {
    let stamp: string;
    try {
      stamp = takeSnapshot(
        configBase(),
        Object.fromEntries(targets.map((compare) => [compare.agent, compare.path])),
      );
    } catch (error) {
      // Fail closed: a takeover with no way back is the thing this whole path
      // exists to prevent, so a snapshot that cannot be taken stops the sync
      // rather than writing unrecoverably. The raw throw would surface as a
      // stack trace, which is not a report a user can act on.
      errorLine(`cannot snapshot before write: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    line("ok", "Snapshot", snapshotDir(configBase(), stamp), "taken before write");
    rotateSnapshots(configBase());
  }

  for (const compare of targets) {
    // omp splices its text so its own formatting survives; pi is parsed and
    // re-serialized, because its JSONC comments and trailing commas have no
    // text-splice equivalence. Both produce the same compiled Catalog, which
    // is what makes the two Agents' results semantically equal.
    const read = await readCatalog(compare.agent);
    if (!read.ok) {
      failedLine(compare.agent.toUpperCase(), compare.path);
      failed = true;
      continue;
    }
    const compiled = compileCatalog(result.score, compare.agent);
    const content =
      compare.agent === "omp"
        ? replaceCatalogNode(read.text, compiled)
        : replacePiCatalogNode(read.text, compiled);
    const written = writeFile(compare.path, content, read.sha256);
    if (!written.wrote) {
      if (written.reason === "changed-underneath") {
        errorLine(`[${compare.agent.toUpperCase()}] ${compare.path} changed underneath this sync; nothing was written`);
      }
      failed = true;
      continue;
    }
    line(
      "ok",
      compare.agent.toUpperCase(),
      compare.path,
      `Synced (${compare.compiled.providers} providers, ${compare.compiled.models} models)`,
    );
  }

  return failed ? 1 : 0;
}

/**
 * The takeover refusal, as lines to print.
 *
 * The gate exists because takeover is wholesale (ADR 0001): the Providers
 * listed here are gone the moment the Catalog is replaced. So the refusal
 * names them by id — and their models, since those go with them — then gives
 * the way forward: declare them in the Score, or confirm the deletion. Naming
 * `unis import` here would send the reader to a command that does not exist
 * yet, which is the least useful answer at the exact moment of data loss.
 */
function takeoverRefusals(gated: string[]): string[] {
  return [
    `first takeover would delete Providers not declared in the Score: ${gated.join("; ")}`,
    `a takeover replaces each Catalog wholesale, so those entries are lost`,
    `add them to the Score first, or re-run "unis sync --yes" to confirm the deletion`,
  ];
}

/**
 * `stale`, or `stale (models: a, b)` when the doomed Provider carries models.
 *
 * The models are what goes with the Provider, so they are named alongside it:
 * a reader can then tell a provider with models apart from an empty shell.
 */
function formatDoomed(id: string, models: string[]): string {
  return models.length === 0 ? id : `${id} (models: ${models.join(", ")})`;
}

/** The doomed ids of one Agent, as one line for the refusal. */
function listDoomed(doomed: Record<string, string[]>): string {
  return Object.entries(doomed).map(([id, models]) => formatDoomed(id, models)).join(", ");
}

/**
 * Writes an Agent's config atomically, reporting what happened.
 *
 * The file's hash is re-checked inside the write, so a concurrent edit aborts
 * with `changed-underneath` rather than being silently overwritten. A throw is
 * a different kind of failure — a permission, a full disk — and is reported as
 * such, so the message names the actual fault rather than implying a race that
 * never happened.
 */
function writeFile(path: string, content: string, sha256: string | null): WriteResult {
  try {
    return atomicWrite(path, content, sha256);
  } catch (error) {
    errorLine(`cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return { wrote: false, reason: "write-failed" };
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
    for (const agent of AGENT_IDS) reportCompare(await countOnly(agent), "Synced");
    return 0;
  }

  for (const agent of AGENT_IDS) {
    reportCompare(await compareAgent(agent, scoreResult.score), "Synced");
  }
  return 0;
}

/**
 * `unis import <agent>` — a Score draft from an Agent's existing Catalog.
 *
 * The draft is written to the Score path and to nothing else: an import never
 * writes either Agent's config, so the takeover stays a confirmed step. A
 * Score that already exists is never merged into or truncated, because it is
 * the Source of Truth the user has been maintaining and an import is a
 * convenience, not a migration the user did not ask for (criterion 7).
 *
 * This is also the documented way out of the first-takeover gate: declaring
 * the Providers a refusal lists is what makes the next `unis sync` proceed
 * without `--yes`.
 */
async function commandImport(args: string[]): Promise<number> {
  const agent = args[0];
  if (agent === undefined || !AGENT_IDS.includes(agent as AgentId)) {
    // `unis import` with no agent is the sync/rollback pattern: the usage line
    // names the accepted values, rather than a per-command help that would
    // duplicate the USAGE block a second time.
    errorLine(`usage: unis import <agent>   (agent is ${AGENT_IDS.join(" or ")})`);
    return 1;
  }
  const agentId = agent as AgentId;

  const path = scorePath();
  if (existsSync(path)) {
    errorLine(`${path} already exists`);
    writeErr(`an import writes a draft, and would replace the Score you already maintain`);
    writeErr(`move it aside first if you want the draft instead`);
    return 1;
  }

  const read = await readCatalog(agentId);
  if (!read.ok) {
    if (read.reason === "not installed") {
      errorLine(`${agentId} is not installed at ${read.path}`);
      return 1;
    }
    errorLine(`cannot read ${read.path}: ${read.reason}`);
    return 1;
  }

  const result = generateDraft(agentId, read.catalog);
  if (!result.ok) {
    for (const failure of result.failures) {
      errorLine(`cannot import provider '${failure.provider}': ${failure.reason}`);
    }
    return 1;
  }

  // 0600, per spec §5.5: the draft references credentials by variable name, and
  // the directory it lands in may hold ones already expanded.
  const written = writeFile(path, result.draft, null);
  if (!written.wrote) {
    errorLine(`cannot write ${path}`);
    return 1;
  }

  line("ok", "Score", path, `drafted from ${agentId.toUpperCase()} (${result.providers} providers, ${result.models} models)`);
  const other = AGENT_IDS.find((id) => id !== agentId);
  if (other !== undefined) writeErr(`⚠ [Score] drafted from ${agentId.toUpperCase()} only — ${other.toUpperCase()}'s Catalog was not imported`);
  writeErr(`⚠ [Score] references credentials by variable name; run "unis validate" to see which are unset`);
  return 0;
}

/**
 * `unis rollback` — restore the state a sync replaced.
 *
 * No argument restores the newest snapshot, `--list` enumerates the retained
 * timestamps, and a timestamp restores that specific one. All three forms read
 * only: nothing is snapshotted, so a rollback cannot consume an older snapshot.
 *
 * A restore puts back both the bytes and the mode of every file the snapshot
 * holds, and deletes the files that did not exist before that sync — a rollback
 * that leaves a newly created file behind has not restored the prior state.
 */
async function commandRollback(args: string[]): Promise<number> {
  const base = configBase();

  if (args.length > 1 || (args.length === 1 && args[0]?.startsWith("-") && args[0] !== "--list")) {
    errorLine(`usage: unis rollback | unis rollback --list | unis rollback <timestamp>`);
    return 1;
  }

  const stamps = listSnapshots(base);

  // Listing an empty set is a legitimate answer, so `--list` runs first and
  // reports nothing with exit 0; the error belongs to the restore forms, which
  // have a snapshot to find and cannot find one.
  if (args[0] === "--list") {
    writeOut(`Snapshots (newest first, ${RETAINED_SNAPSHOTS} retained):`);
    for (const stamp of stamps) writeOut(`  ${stamp}`);
    return 0;
  }

  if (stamps.length === 0) {
    writeErr("⚠ no snapshots retained");
    return 1;
  }

  const stamp = args[0] ?? stamps[0] ?? "";
  if (args[0] !== undefined && !stamps.includes(args[0])) {
    errorLine(`no retained snapshot for ${args[0]}`);
    for (const retained of stamps) writeErr(`  ${retained}`);
    return 1;
  }

  try {
    for (const entry of restoreSnapshot(base, stamp)) {
      if (entry.backed === undefined) {
        line("ok", entry.id.toUpperCase(), entry.from, "Removed (did not exist before the sync)");
        continue;
      }
      line("ok", entry.id.toUpperCase(), entry.from, "Restored");
    }
  } catch (error) {
    errorLine(error instanceof Error ? error.message : String(error));
    return 1;
  }
  writeOut(`✨ Rolled back to ${stamp}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command) exitWithUsage();

  switch (command) {
    case "sync": {
      // `--dry-run` previews the same takeover without writing; `--yes`
      // confirms the deletion a first takeover would cause (spec §4.1, §5.1).
      // Any other argument is a typo the user should hear about, in any
      // position, rather than silence the sync runs with.
      const known = ["--dry-run", "--yes"];
      const dryRun = argv.includes("--dry-run");
      const yes = argv.includes("--yes");
      const unknown = argv.filter((arg) => arg.startsWith("-") && !known.includes(arg));
      if (unknown.length > 0) {
        errorLine(`unknown flag: ${unknown[0]}`);
        exitWithUsage();
      }
      return await commandSync(dryRun, yes);
    }
    case "list":
      return await commandList();
    case "diff":
      return await commandDiff();
    case "validate":
      return await commandValidate();
    case "import":
      return await commandImport(argv.slice(1));
    case "rollback":
      return await commandRollback(argv.slice(1));
    default:
      errorLine(`unknown command: ${command}`);
      exitWithUsage();
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
