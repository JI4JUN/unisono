/**
 * `unis list` — the Score in use, then per-Agent path, presence, and size.
 */

import { defineCommand } from "citty";
import { writeErr, writeOut } from "../output";
import { AGENT_IDS, scorePath } from "../paths";
import { loadScore } from "../score";
import { compareAgent, reportCompare } from "./shared";

export const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "Show each Agent's path, presence, and Catalog counts",
  },
  async run() {
    writeOut(`🎼 Unisono — one Score, two Agents in unison.`);
    writeOut(`  Score: ${scorePath()}`);

    const scoreResult = await loadScore(scorePath());
    if (!scoreResult.ok) {
      writeErr(`⚠ [Score] not comparable: ${scoreResult.errors[0]}`);
      for (const agent of AGENT_IDS) reportCompare(await compareAgent(agent), "Synced");
      return;
    }

    for (const agent of AGENT_IDS) {
      reportCompare(await compareAgent(agent, scoreResult.score), "Synced");
    }
  },
});
