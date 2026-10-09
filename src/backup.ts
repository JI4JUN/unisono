/**
 * Snapshotting an Agent's config before a takeover, and restoring it.
 *
 * The takeover replaces a Catalog wholesale (ADR 0001), so the only way back
 * from a mistake is the state that existed before the write. A snapshot is
 * therefore taken for every Agent a sync is about to write, into a timestamped
 * directory under the Unisono config dir:
 *
 * ```
 * $XDG_CONFIG_HOME/unisono/backups/<ISO timestamp>/<agent>.<ext>
 * $XDG_CONFIG_HOME/unisono/backups/<ISO timestamp>/manifest.json
 * ```
 *
 * The manifest records what each Agent's file was *before* the sync, including
 * the case that matters most for restoring the prior state: a file that did
 * not exist. Restoring such a file means deleting it, not leaving the copy the
 * sync created — a rollback that leaves behind a newly created file has not
 * restored anything (docs/mvp-spec.md §5.2).
 *
 * Retention is the three most recent snapshots; the fourth rotates the oldest
 * out. More would be a memory of the past the tool does not need: a rollback
 * is a recover-from-just-now operation, and the Score in git is the long-term
 * record of what was intended.
 *
 * Permissions follow spec §5.5: the directory is `0700` and the snapshotted
 * files `0600`, because they hold expanded credentials.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isObjectNode } from "./guards";

/** How many snapshots are retained; the oldest beyond this count is removed. */
export const RETAINED_SNAPSHOTS = 3;

/**
 * An ISO timestamp safe to use as a directory name.
 *
 * `:` is a legal POSIX filename character but not a legal Windows one, and a
 * snapshot directory that cannot be created on some platform is a snapshot
 * that does not exist. Colons become dashes, and the milliseconds are kept so
 * two syncs in the same second do not collide.
 */
function timestamp(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

/** The snapshot directory a sync's backups belong in. */
export function snapshotDir(configBase: string, stamp: string): string {
  return join(configBase, "backups", stamp);
}

/** What one Agent's config was before a sync, as far as a restore needs to know. */
export type SnapshotEntry = {
  /** The Agent this entry belongs to, as the restore line reports it. */
  id: string;
  /** Path the snapshot was taken from, so a restore can put it back. */
  from: string;
  /** File name inside the snapshot directory, or null when there was no file. */
  backed?: string;
  /** Permissions the file carried, restored alongside its contents. */
  mode?: number;
};

/**
 * What a sync snapshotted, and what a rollback restores.
 *
 * One directory holds every Agent this sync wrote, so a rollback of the sync
 * undoes the whole sync rather than an arbitrary subset of it.
 */
export type Manifest = {
  /** ISO timestamp with the colons already replaced, matching the directory. */
  stamp: string;
  entries: Record<string, SnapshotEntry>;
};

function manifestPath(stamp: string, configBase: string): string {
  return join(snapshotDir(configBase, stamp), "manifest.json");
}

/**
 * Snapshots each Agent's config before it is written.
 *
 * A file that does not exist yet is recorded as absent and *not* created in the
 * snapshot: backing up a missing file would invent bytes that were never on
 * disk, and a restore would then leave those bytes behind instead of removing
 * the file the sync created. The manifest entry for it carries no `backed`.
 *
 * Returns the stamp, which the caller reports as `Backup saved: <dir>`.
 */
export function takeSnapshot(configBase: string, files: Record<string, string>): string {
  const stamp = timestamp();
  const dir = snapshotDir(configBase, stamp);
  // A stamp is only safe to reuse because it is time-derived, so a collision is
  // a real hazard rather than a curiosity: two syncs in the same millisecond
  // would otherwise share a directory, and the second would overwrite the
  // first's files silently — losing a state with no error and no trace in
  // `rollback --list`. Refusing keeps each snapshot a distinct state.
  if (existsSync(dir)) throw new Error(`snapshot ${stamp} already exists`);
  mkdirSync(dir, { recursive: true });
  // Credentials land in these files, so the directories holding them are
  // private to the user (spec §5.5): `mkdirSync`'s mode argument is subject to
  // the process umask, and a group-writable backup directory is a credential
  // leak. Both levels are corrected, because the `backups` parent is created by
  // this same recursive call.
  chmodSync(join(configBase, "backups"), 0o700);
  chmodSync(dir, 0o700);

  const entries: Record<string, SnapshotEntry> = {};
  for (const [id, path] of Object.entries(files)) {
    if (!existsSync(path)) {
      entries[id] = { id, from: path };
      continue;
    }
    // Both the contents and the mode are snapshotted: a restore must put back
    // each, so a file that was 0600 before the sync does not come back
    // world-readable.
    const snapshot = `${id}.${extensionOf(path)}`;
    copyContents(path, join(dir, snapshot));
    entries[id] = { id, from: path, backed: snapshot, mode: statSync(path).mode & 0o777 };
  }

  writeFileSync(manifestPath(stamp, configBase), JSON.stringify({ stamp, entries }, null, 2), {
    mode: 0o600,
  });
  return stamp;
}

function copyContents(from: string, to: string): void {
  writeFileSync(to, readFileSync(from, "utf8"));
  chmodSync(to, 0o600);
}

/** The extension of a config path, so a snapshot keeps the shape of its source. */
function extensionOf(path: string): string {
  const parts = path.split(".");
  return parts.length > 1 ? (parts[parts.length - 1] ?? "bak") : "bak";
}

/** The retained snapshot stamps, newest first. */
export function listSnapshots(configBase: string): string[] {
  const dir = join(configBase, "backups");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((stamp) => existsSync(manifestPath(stamp, configBase)))
    .sort()
    .reverse();
}

/** Reads a snapshot's manifest, or null when it is gone or unreadable. */
export function readManifest(configBase: string, stamp: string): Manifest | null {
  let parsed: unknown;
  try {
    parsed = Bun.JSONC.parse(readFileSync(manifestPath(stamp, configBase), "utf8"));
  } catch {
    return null;
  }
  if (!isObjectNode(parsed)) return null;
  if (!isObjectNode(parsed["entries"]) || typeof parsed["stamp"] !== "string") return null;
  return parsed as unknown as Manifest;
}

/**
 * Restores the snapshotted files of one snapshot, and reports what each one was.
 *
 * The stamp is chosen by the caller: no argument means the newest, an argument
 * selects one. A restore puts back the exact bytes and mode it snapshotted, and
 * deletes the files that did not exist — so the state before that sync is
 * genuinely restored, not merely merged with it.
 *
 * The entries are returned rather than just the ids, so the caller reports what
 * happened without reading the manifest a second time. Reading it again would
 * be a second opinion about the same snapshot, and a rollback line that
 * disagreed with what was actually restored is worse than no line at all.
 */
export function restoreSnapshot(configBase: string, stamp: string): SnapshotEntry[] {
  const manifest = readManifest(configBase, stamp);
  if (manifest === null) throw new Error(`no snapshot for ${stamp}`);

  const dir = snapshotDir(configBase, stamp);
  const restored: SnapshotEntry[] = [];
  for (const entry of Object.values(manifest.entries)) {
    if (entry.backed === undefined) {
      // The sync created this file, so restoring the prior state means it goes.
      rmSync(entry.from, { force: true });
      restored.push(entry);
      continue;
    }
    // Created 0600 before the recorded mode is applied: the restored file holds
    // expanded credentials, and `writeFileSync` without a mode would make it
    // world-readable for the window before the chmod — the same exposure the
    // sync write path closes by writing its temporary file 0600.
    writeFileSync(entry.from, readFileSync(join(dir, entry.backed), "utf8"), { mode: 0o600 });
    if (entry.mode !== undefined) chmodSync(entry.from, entry.mode);
    restored.push(entry);
  }
  return restored;
}

/**
 * Keeps only the most recent snapshots.
 *
 * Called after a new snapshot is taken, so the count includes it: a sync that
 * finds three retained snapshots rotates the oldest out and keeps three.
 */
export function rotateSnapshots(configBase: string): void {
  for (const stamp of listSnapshots(configBase).slice(RETAINED_SNAPSHOTS)) {
    rmSync(snapshotDir(configBase, stamp), { recursive: true, force: true });
  }
}
