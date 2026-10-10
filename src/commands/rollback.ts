/**
 * `unis rollback` — restore the state a sync replaced.
 */

import { defineCommand } from "citty";
import { listSnapshots, RETAINED_SNAPSHOTS, restoreSnapshot } from "../backup";
import { errorLine, line, writeErr, writeOut } from "../output";
import { configBase } from "../paths";

export const rollbackCommand = defineCommand({
  meta: {
    name: "rollback",
    description: "Restore the most recent or a specific snapshot",
  },
  args: {
    list: {
      type: "boolean",
      description: "List retained snapshots",
      default: false,
    },
    timestamp: {
      type: "positional",
      description: "Snapshot timestamp to restore",
      required: false,
    },
  },
  async run({ args }) {
    const base = configBase();
    if (args._.length > 1 || (args.list && args.timestamp !== undefined)) {
      errorLine(
        `usage: unis rollback | unis rollback --list | unis rollback <timestamp>`,
      );
      process.exitCode = 1;
      return;
    }

    const stamps = listSnapshots(base);

    if (args.list) {
      writeOut(`Snapshots (newest first, ${RETAINED_SNAPSHOTS} retained):`);
      for (const stamp of stamps) writeOut(`  ${stamp}`);
      return;
    }

    if (stamps.length === 0) {
      writeErr("⚠ no snapshots retained");
      process.exitCode = 1;
      return;
    }

    const requested = args.timestamp;
    const stamp = requested ?? stamps[0] ?? "";
    if (requested !== undefined && !stamps.includes(requested)) {
      errorLine(`no retained snapshot for ${requested}`);
      for (const retained of stamps) writeErr(`  ${retained}`);
      process.exitCode = 1;
      return;
    }

    try {
      for (const entry of restoreSnapshot(base, stamp)) {
        if (entry.backed === undefined) {
          line(
            "ok",
            entry.id.toUpperCase(),
            entry.from,
            "Removed (did not exist before the sync)",
          );
          continue;
        }
        line("ok", entry.id.toUpperCase(), entry.from, "Restored");
      }
    } catch (error) {
      errorLine(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
    writeOut(`✨ Rolled back to ${stamp}`);
  },
});
