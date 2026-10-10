#!/usr/bin/env bun
/**
 * `unis` — one Score, two Agents in unison.
 *
 * Driven by `citty` (`defineCommand` + `runMain`), with each subcommand living
 * under `src/commands/`. Exit codes: 0 success or
 * all-Unchanged, 1 validation failure / missing variable / write failure, 2
 * unconfirmed first takeover.
 */

import { defineCommand, runMain, showUsage, type ArgsDef, type CommandDef } from "citty";
import pkg from "../package.json";
import { diffCommand } from "./commands/diff";
import { importCommand } from "./commands/import";
import { listCommand } from "./commands/list";
import { rollbackCommand } from "./commands/rollback";
import { findUnknownFlag } from "./commands/shared";
import { syncCommand } from "./commands/sync";
import { validateCommand } from "./commands/validate";
import { errorLine } from "./output";

const subCommands: Record<string, CommandDef<any>> = {
  sync: syncCommand,
  diff: diffCommand,
  validate: validateCommand,
  list: listCommand,
  import: importCommand,
  rollback: rollbackCommand,
};

const mainCommand = defineCommand({
  meta: {
    name: "unis",
    version: pkg.version,
    description: "One Score, two Agents in unison.",
  },
  subCommands,
  async setup({ rawArgs }) {
    const first = rawArgs[0];
    if (first === undefined) return;
    if (first.startsWith("-")) {
      errorLine(`unknown flag: ${first}`);
      await showUsage(mainCommand);
      process.exit(1);
    }
    const sub = subCommands[first];
    if (sub !== undefined) {
      const argsDef = (typeof sub.args === "function" ? await sub.args() : await sub.args) as ArgsDef | undefined;
      const unknown = findUnknownFlag(rawArgs.slice(1), argsDef);
      if (unknown !== undefined) {
        errorLine(`unknown flag: ${unknown}`);
        await showUsage(sub, mainCommand);
        process.exit(1);
      }
    }
  },
});

if (import.meta.main) {
  await runMain(mainCommand, { rawArgs: Bun.argv.slice(2) });
}
