/**
 * `unis sync` — take both Agents' Catalogs over with the compiled one.
 */

import { defineCommand } from "citty";
import { readCatalog } from "../agent";
import { rotateSnapshots, snapshotDir, takeSnapshot } from "../backup";
import { compileCatalog } from "../compiler";
import { errorLine, line, writeErr, writeOut } from "../output";
import { AGENT_IDS, configBase } from "../paths";
import { replacePiCatalogNode } from "../pi-write";
import { replaceCatalogNode } from "../sync";
import {
  UNREADABLE_CONFIG_MESSAGE,
  compareAgent,
  danglingWarnings,
  loadValidScore,
  reportCompare,
  writeFile,
  type AgentCompare,
} from "./shared";

export const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description: "Compile the Score into both Agents' Catalogs",
  },
  args: {
    yes: {
      type: "boolean",
      description: "Confirm a first takeover",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description: "Preview the change without writing",
      default: false,
    },
  },
  async run({ args }) {
    const dryRun = Boolean(args["dry-run"]);
    const yes = Boolean(args.yes);

    const loaded = await loadValidScore();
    if (loaded === null) return;

    writeOut(`🎼 Unisono — one Score, two Agents in unison.`);
    let failed = false;

    const gated: string[] = [];
    const writable: AgentCompare[] = [];
    for (const agent of AGENT_IDS) {
      const compare = await compareAgent(agent, loaded.score);
      const reported = reportCompare(compare, "Unchanged");
      failed = failed || reported.failed;
      if (reported.writable) {
        const doomedEntries = Object.entries(compare.doomed);
        if (doomedEntries.length > 0) {
          const doomedList = doomedEntries
            .map(([id, models]) => (models.length === 0 ? id : `${id} (models: ${models.join(", ")})`))
            .join(", ");
          gated.push(`${agent.toUpperCase()}: ${doomedList}`);
        }
        writable.push(compare);
      }
    }

    if (gated.length > 0 && !dryRun && !yes) {
      const refusals = [
        `first takeover would delete Providers not declared in the Score: ${gated.join("; ")}`,
        `a takeover replaces each Catalog wholesale, so those entries are lost`,
        `add them to the Score first, or re-run "unis sync --yes" to confirm the deletion`,
      ];
      for (const refusal of refusals) await writeErr(refusal);
      process.exitCode = 2;
      return;
    }

    for (const warning of danglingWarnings(loaded.score)) writeErr(`⚠ ${warning}`);

    const targets = writable.filter(() => !dryRun);

    if (targets.length > 0) {
      let stamp: string;
      try {
        stamp = takeSnapshot(
          configBase(),
          Object.fromEntries(targets.map((compare) => [compare.agent, compare.path])),
        );
      } catch (error) {
        errorLine(`cannot snapshot before write: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }
      line("ok", "Snapshot", snapshotDir(configBase(), stamp), "taken before write");
      rotateSnapshots(configBase());
    }

    for (const compare of targets) {
      const read = await readCatalog(compare.agent);
      if (!read.ok) {
        line("fail", compare.agent.toUpperCase(), compare.path, UNREADABLE_CONFIG_MESSAGE);
        failed = true;
        continue;
      }
      const compiled = compileCatalog(loaded.score, compare.agent);
      const content =
        compare.agent === "omp"
          ? replaceCatalogNode(read.text, compiled)
          : replacePiCatalogNode(read.text, compiled);
      const written = writeFile(compare.path, content, read.sha256);
      if (!written.wrote) {
        if (written.reason === "changed-underneath") {
          errorLine(
            `[${compare.agent.toUpperCase()}] ${compare.path} changed underneath this sync; nothing was written`,
          );
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

    if (failed) process.exitCode = 1;
  },
});
