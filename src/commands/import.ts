/**
 * `unis import` — interactively select an Agent and generate a Score draft
 * from its existing Catalog.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defineCommand } from "citty";
import { type CatalogRead, countCatalog, readCatalog } from "../agent";
import { generateDraft } from "../importer";
import { errorLine, line, writeErr, writeOut } from "../output";
import { AGENT_IDS, type AgentId, scorePath } from "../paths";
import { writeFile } from "./shared";

type AgentChoice = {
  agent: AgentId;
  read: CatalogRead;
  summary: string;
  url: string;
};

function renderChoices(choices: AgentChoice[], activeIndex: number): void {
  for (const [i, choice] of choices.entries()) {
    writeOut(
      `  ${i === activeIndex ? "❯" : " "} ${choice.agent.toUpperCase()} (${choice.summary}) — ${choice.url}`,
    );
  }
}

function stepKeystrokes(
  input: string,
  startIndex: number,
  count: number,
): { index: number; action: "confirm" | "cancel" | "none" } {
  let index = startIndex;
  let at = 0;
  while (at < input.length) {
    if (input.startsWith("\x1b[A", at) || input.startsWith("\x1bOA", at)) {
      index = (index - 1 + count) % count;
      at += 3;
    } else if (
      input.startsWith("\x1b[B", at) ||
      input.startsWith("\x1bOB", at)
    ) {
      index = (index + 1) % count;
      at += 3;
    } else if (input.startsWith("\x1b[", at) || input.startsWith("\x1bO", at)) {
      const rest = input.slice(at + 2);
      const match = /^[0-9;]*[A-Za-z~]/.exec(rest);
      at += 2 + (match ? match[0].length : 1);
    } else if (input[at] === "k") {
      index = (index - 1 + count) % count;
      at += 1;
    } else if (input[at] === "j") {
      index = (index + 1) % count;
      at += 1;
    } else if (input[at] === "\r" || input[at] === "\n") {
      return { index, action: "confirm" };
    } else if (input[at] === "\x03" || input[at] === "\x1b") {
      return { index, action: "cancel" };
    } else {
      at += 1;
    }
  }
  return { index, action: "none" };
}

async function selectAgent(
  choices: AgentChoice[],
): Promise<AgentChoice | null> {
  let index = 0;
  writeOut("? Select an Agent to import from (↑/↓ to move, Enter to confirm):");
  renderChoices(choices, index);

  if (!process.stdin.isTTY) {
    const stepped = stepKeystrokes(
      await Bun.stdin.text(),
      index,
      choices.length,
    );
    return stepped.action === "confirm"
      ? (choices[stepped.index] ?? null)
      : null;
  }

  return await new Promise<AgentChoice | null>((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.setEncoding("utf8");
    stdin.resume();

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };

    const onData = (text: string) => {
      const stepped = stepKeystrokes(text, index, choices.length);
      if (stepped.index !== index) {
        index = stepped.index;
        Bun.stdout.write(`\x1b[${choices.length}A\r\x1b[J`);
        renderChoices(choices, index);
      }
      if (stepped.action === "confirm") {
        cleanup();
        resolve(choices[index] ?? null);
      } else if (stepped.action === "cancel") {
        cleanup();
        resolve(null);
      }
    };

    stdin.on("data", onData);
  });
}

export const importCommand = defineCommand({
  meta: {
    name: "import",
    description: "Interactively select an Agent and generate a Score draft",
  },
  async run({ args }) {
    if (args._.length > 0) {
      errorLine(`usage: unis import`);
      process.exitCode = 1;
      return;
    }

    const path = scorePath();
    if (existsSync(path)) {
      errorLine(`${path} already exists`);
      writeErr(
        `an import writes a draft, and would replace the Score you already maintain`,
      );
      writeErr(`move it aside first if you want the draft instead`);
      process.exitCode = 1;
      return;
    }

    const choices: AgentChoice[] = await Promise.all(
      AGENT_IDS.map(async (agent) => {
        const read = await readCatalog(agent);
        const summary = read.ok
          ? (() => {
              const counts = countCatalog(read.catalog);
              return `${counts.providers} providers, ${counts.models} models`;
            })()
          : read.reason;
        return {
          agent,
          read,
          summary,
          url: Bun.pathToFileURL(read.path).href,
        };
      }),
    );

    const selected = await selectAgent(choices);
    if (selected === null) {
      errorLine(`import cancelled`);
      process.exitCode = 1;
      return;
    }

    const { agent: agentId, read } = selected;
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
        errorLine(
          `cannot import provider '${failure.provider}': ${failure.reason}`,
        );
      }
      process.exitCode = 1;
      return;
    }

    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    } catch (error) {
      errorLine(
        `cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      writeErr(
        `⚠ [Score] drafted from ${agentId.toUpperCase()} only — ${other.toUpperCase()}'s Catalog was not imported`,
      );
    }
    writeErr(
      `⚠ [Score] references credentials by variable name; run "unis validate" to see which are unset`,
    );
  },
});
