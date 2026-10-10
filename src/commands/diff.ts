/**
 * `unis diff` — the Score-compiled Catalog against each Agent's on-disk one.
 */

import { defineCommand } from "citty";
import { writeOut } from "../output";
import { AGENT_IDS } from "../paths";
import { compareAgent, loadValidScore, reportCompare } from "./shared";

export const diffCommand = defineCommand({
  meta: {
    name: "diff",
    description: "Score-compiled Catalog vs the on-disk Catalogs",
  },
  async run() {
    const loaded = await loadValidScore();
    if (loaded === null) return;

    writeOut(`🎼 Unisono — one Score, two Agents in unison.`);
    let drifting = 0;
    let failed = false;
    for (const agent of AGENT_IDS) {
      const reported = reportCompare(
        await compareAgent(agent, loaded.score),
        "Unchanged",
      );
      failed = failed || reported.failed;
      if (reported.writable) drifting += 1;
    }

    if (drifting === 0 && !failed) {
      writeOut("Catalogs are unchanged; a sync would write nothing.");
    }
    if (failed) process.exitCode = 1;
  },
});
