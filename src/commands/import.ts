/**
 * `unis import <agent>` — a Score draft from an Agent's existing Catalog.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { readCatalog } from "../agent";
import { generateDraft } from "../importer";
import { errorLine, line, writeErr } from "../output";
import { AGENT_IDS, scorePath, type AgentId } from "../paths";
import { writeFile } from "./shared";

export const importCommand = defineCommand({
  meta: {
    name: "import",
    description: "Generate a Score draft from an Agent's Catalog (omp | pi)",
  },
  args: {
    agent: {
      type: "positional",
      description: "Agent to import from (omp | pi)",
      required: true,
    },
  },
  async run({ args }) {
    const agent = args.agent;
    if (!AGENT_IDS.includes(agent as AgentId)) {
      errorLine(`usage: unis import <agent>   (agent is ${AGENT_IDS.join(" or ")})`);
      process.exitCode = 1;
      return;
    }
    const agentId = agent as AgentId;

    const path = scorePath();
    if (existsSync(path)) {
      errorLine(`${path} already exists`);
      writeErr(`an import writes a draft, and would replace the Score you already maintain`);
      writeErr(`move it aside first if you want the draft instead`);
      process.exitCode = 1;
      return;
    }

    const read = await readCatalog(agentId);
    if (!read.ok) {
      if (read.reason === "not installed") {
        errorLine(`${agentId} is not installed at ${read.path}`);
        process.exitCode = 1;
        return;
      }
      errorLine(`cannot read ${read.path}: ${read.reason}`);
      process.exitCode = 1;
      return;
    }

    const result = generateDraft(agentId, read.catalog);
    if (!result.ok) {
      for (const failure of result.failures) {
        errorLine(`cannot import provider '${failure.provider}': ${failure.reason}`);
      }
      process.exitCode = 1;
      return;
    }

    const written = writeFile(path, result.draft, null);
    if (!written.wrote) {
      errorLine(`cannot write ${path}`);
      process.exitCode = 1;
      return;
    }

    line(
      "ok",
      "Score",
      path,
      `drafted from ${agentId.toUpperCase()} (${result.providers} providers, ${result.models} models)`,
    );
    const other = AGENT_IDS.find((id) => id !== agentId);
    if (other !== undefined) {
      writeErr(`⚠ [Score] drafted from ${agentId.toUpperCase()} only — ${other.toUpperCase()}'s Catalog was not imported`);
    }
    writeErr(`⚠ [Score] references credentials by variable name; run "unis validate" to see which are unset`);
  },
});
