/**
 * `unis validate` — check the Score and write nothing.
 */

import { defineCommand } from "citty";
import { line, writeErr } from "../output";
import { danglingWarnings, loadValidScore } from "./shared";

export const validateCommand = defineCommand({
  meta: {
    name: "validate",
    description: "Check the Score and expand credential references",
  },
  async run() {
    const loaded = await loadValidScore();
    if (loaded === null) return;

    for (const warning of danglingWarnings(loaded.score))
      writeErr(`⚠ ${warning}`);

    const providers = Object.values(loaded.score.providers);
    const models = providers.reduce(
      (total, provider) => total + provider.models.length,
      0,
    );
    line(
      "ok",
      "Score",
      loaded.path,
      `valid (${providers.length} providers, ${models} models)`,
    );
  },
});
