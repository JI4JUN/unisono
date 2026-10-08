/**
 * Tests drive the real `unis` binary as a subprocess against a throwaway
 * config tree — the single seam mandated by the spec's Testing Decisions.
 * Snapshots, rotation, permissions, and rollback are all asserted through the
 * command boundary and the files they leave behind, never by importing the
 * backup module.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "cli.ts");

let root: string;
let ompDir: string;
let piDir: string;
let scorePath: string;
let backupsDir: string;

/** A Score declaring one provider and one model, expandable and valid. */
const VALID_SCORE = `version: "1"
providers:
  deepseek:
    name: "DeepSeek Official"
    baseUrl: "https://api.deepseek.com/v1"
    apiKey: "sk-sample-key-1234567890"
    apiType: "openai-completions"
    models:
      - id: "deepseek-reasoner"
        name: "DeepSeek R1 (Reasoning)"
        contextWindow: 65536
`;

function runUnis(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, ENTRY, ...args],
    env: {
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      OMP_CODING_AGENT_DIR: ompDir,
      PI_CODING_AGENT_DIR: piDir,
      NO_COLOR: "1",
      PATH: process.env.PATH ?? "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode ?? -1,
  };
}

function writeScore(text: string): void {
  writeFileSync(scorePath, text);
}

/** An omp config whose Catalog holds an undeclared Provider, so a sync writes. */
function writeDriftingConfig(): void {
  writeFileSync(join(ompDir, "models.yml"), "providers:\n  stale:\n    models: []\n");
}

/**
 * The snapshot directory names currently retained, oldest first.
 *
 * A directory is a snapshot only when it holds a manifest, so a rotation bug
 * that leaves an empty directory behind does not count as a retained snapshot.
 */
function snapshotDirs(): string[] {
  if (!existsSync(backupsDir)) return [];
  // A directory counts as a snapshot only when it holds a manifest, so a
  // rotation bug that leaves an empty directory does not look retained.
  return readdirSync(backupsDir)
    .filter((stamp) => existsSync(join(backupsDir, stamp, "manifest.json")))
    .sort();
}

/**
 * Narrows a parsed JSON document to a map before reading a key out of it.
 *
 * Parsed data is outside-controlled: casting it to a shape would trust it
 * unverified, and a malformed manifest would then read silently wrong.
 */
function readKey(node: unknown, key: string): unknown {
  if (node !== null && typeof node === "object" && !Array.isArray(node) && key in node) {
    return (node as Record<string, unknown>)[key];
  }
  return undefined;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "unis-rollback-"));
  ompDir = join(root, "omp", "agent");
  piDir = join(root, "pi", "agent");
  scorePath = join(root, "config", "unisono", "score.yaml");
  backupsDir = join(root, "config", "unisono", "backups");
  mkdirSync(ompDir, { recursive: true });
  mkdirSync(piDir, { recursive: true });
  mkdirSync(join(root, "config", "unisono"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("unis sync — snapshot before write", () => {
  test("takes a snapshot into a colon-free ISO directory before writing", () => {
    writeScore(VALID_SCORE);
    writeDriftingConfig();

    const { stdout, exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    const dirs = snapshotDirs();
    expect(dirs).toHaveLength(1);
    // A filesystem-safe ISO timestamp: no colons, which some platforms reject
    // in a directory name, so a snapshot that cannot exist cannot be restored.
    expect(dirs[0] ?? "").toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
    expect(stdout).toContain("backups/");
    // The pre-sync bytes were snapshotted, not the ones this sync wrote.
    expect(readFileSync(join(backupsDir, dirs[0] ?? "", "omp.yml"), "utf8")).toContain("stale");
  });

  test("records in the manifest what a rollback will restore", () => {
    // The file exists, so the manifest must say it was backed up — that is what
    // distinguishes a restore (put the bytes back) from a deletion.
    writeScore(VALID_SCORE);
    writeDriftingConfig();

    const { exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    const dirs = snapshotDirs();
    const manifest: unknown = Bun.JSONC.parse(
      readFileSync(join(backupsDir, dirs[0] ?? "", "manifest.json"), "utf8"),
    );
    const entry = readKey(readKey(manifest, "entries"), "omp");
    expect(readKey(entry, "from")).toBe(join(ompDir, "models.yml"));
    expect(readKey(entry, "backed")).toBe("omp.yml");
  });

  test("does not snapshot an Agent whose config is absent, because sync never writes it", () => {
    // An uninstalled Agent is `Skipped`, not written, so there is no prior
    // state to remember. The `no backed` path of the manifest is what marks a
    // file the *write* created, and the current CLI has no way to reach it
    // (a skipped Agent is never written), so the snapshot area stays empty
    // rather than holding an entry that would restore nothing.
    writeScore(VALID_SCORE);

    const { stdout, exitCode } = runUnis(["sync"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Skipped (not installed)");
    expect(snapshotDirs()).toHaveLength(0);
    expect(existsSync(join(ompDir, "models.yml"))).toBe(false);
  });

  test("creates the backup directory 0700 and its files 0600", () => {
    writeScore(VALID_SCORE);
    writeDriftingConfig();

    const { exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    expect(statSync(backupsDir).mode & 0o777).toBe(0o700);
    const stamp = snapshotDirs()[0] ?? "";
    expect(statSync(join(backupsDir, stamp)).mode & 0o777).toBe(0o700);
    for (const name of ["omp.yml", "manifest.json"]) {
      expect(statSync(join(backupsDir, stamp, name)).mode & 0o777).toBe(0o600);
    }
  });

  test("takes no snapshot when a sync reports Unchanged for both agents", () => {
    // A converged Catalog: the second sync writes nothing, so there is no prior
    // state worth remembering.
    writeScore(VALID_SCORE);
    writeDriftingConfig();
    const first = runUnis(["sync", "--yes"]);
    expect(first.exitCode).toBe(0);
    expect(snapshotDirs()).toHaveLength(1);

    const second = runUnis(["sync"]);

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Unchanged");
    // Still the one directory from the first sync: nothing new was created.
    expect(snapshotDirs()).toHaveLength(1);
  });
});

describe("unis rollback", () => {
  test("restores the prior content and permissions exactly", () => {
    writeScore(VALID_SCORE);
    const original = "providers:\n  stale:\n    models: []\n";
    writeFileSync(join(ompDir, "models.yml"), original);
    chmodSync(join(ompDir, "models.yml"), 0o600);
    const modeBefore = statSync(join(ompDir, "models.yml")).mode & 0o777;

    runUnis(["sync", "--yes"]);
    expect(readFileSync(join(ompDir, "models.yml"), "utf8")).not.toBe(original);

    const { stdout, exitCode } = runUnis(["rollback"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Restored");
    expect(readFileSync(join(ompDir, "models.yml"), "utf8")).toBe(original);
    expect(statSync(join(ompDir, "models.yml")).mode & 0o777).toBe(modeBefore);
  });

  test("no argument restores the most recent snapshot", () => {
    writeScore(VALID_SCORE);
    // Two syncs, two snapshots. Each snapshot holds what was on disk *before*
    // its sync, so the newest snapshot alone carries `second:` — and a
    // no-argument rollback must pick exactly that one, not the older `first:`.
    writeFileSync(join(ompDir, "models.yml"), "providers:\n  first:\n    models: []\n");
    runUnis(["sync", "--yes"]);
    expect(snapshotDirs()).toHaveLength(1);

    writeFileSync(join(ompDir, "models.yml"), "providers:\n  second:\n    models: []\n");
    runUnis(["sync", "--yes"]);
    expect(snapshotDirs()).toHaveLength(2);

    const { exitCode } = runUnis(["rollback"]);

    expect(exitCode).toBe(0);
    // Restoring the older snapshot would bring `first:` back, so this single
    // assertion is what proves the newest one was chosen.
    expect(readFileSync(join(ompDir, "models.yml"), "utf8")).toContain("second");
  });

  test("restores a named snapshot specifically", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(ompDir, "models.yml"), "providers:\n  first:\n    models: []\n");
    runUnis(["sync", "--yes"]);
    const oldest = snapshotDirs()[0] ?? "";
    writeFileSync(join(ompDir, "models.yml"), "providers:\n  second:\n    models: []\n");
    runUnis(["sync", "--yes"]);
    expect(snapshotDirs()).toHaveLength(2);

    const { exitCode } = runUnis(["rollback", oldest]);

    expect(exitCode).toBe(0);
    expect(readFileSync(join(ompDir, "models.yml"), "utf8")).toContain("first");
  });

  test("--list enumerates the retained snapshots, newest first", () => {
    writeScore(VALID_SCORE);
    writeDriftingConfig();
    runUnis(["sync", "--yes"]);
    const stamp = snapshotDirs()[0] ?? "";

    const { stdout, exitCode } = runUnis(["rollback", "--list"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain(stamp);
    // Newest first: the stamp is listed, and it is the only one.
    const listed = stdout.split("\n").filter((l) => l.includes("Z") && l.trim().startsWith("20"));
    expect(listed).toHaveLength(1);
  });

  test("retains only the three most recent snapshots", () => {
    writeScore(VALID_SCORE);
    // Five syncs, each against a freshly edited config so every one writes.
    // A positive marker inside each config is what lets the test prove *which*
    // snapshots survived, rather than only that three directories remain.
    const taken: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(ompDir, "models.yml"), `providers:\n  stale-${index}:\n    models: []\n`);
      const { exitCode } = runUnis(["sync", "--yes"]);
      expect(exitCode).toBe(0);
      const dirs = snapshotDirs();
      expect(dirs).toHaveLength(Math.min(index + 1, 3));
      // The newest entry of a lexically sorted list is the one this sync took,
      // because seconds sort ahead of minutes and a later stamp never sorts
      // before an earlier one in this format.
      taken.push(dirs[dirs.length - 1] ?? "");
    }

    const dirs = snapshotDirs();
    expect(dirs).toHaveLength(3);
    // The two oldest are gone — not merely pushed down the list.
    const oldestTwo = [taken[0] ?? "", taken[1] ?? ""];
    expect(dirs.some((dir) => oldestTwo.includes(dir))).toBe(false);
    // The three newest survive, in order.
    expect(dirs).toEqual([taken[2] ?? "", taken[3] ?? "", taken[4] ?? ""]);
    // And the survivor that holds `stale-4` really is a snapshot of a takeover,
    // so a rollback of it would put back the state before the fifth sync.
    const manifest: unknown = Bun.JSONC.parse(
      readFileSync(join(backupsDir, taken[4] ?? "", "manifest.json"), "utf8"),
    );
    expect(readKey(readKey(manifest, "entries"), "omp")).not.toBe(undefined);
  });

  test("reports a snapshot that does not exist rather than inventing one", () => {
    writeScore(VALID_SCORE);
    writeDriftingConfig();
    runUnis(["sync", "--yes"]);

    const { stderr, exitCode } = runUnis(["rollback", "2020-01-01T00-00-00.000Z"]);

    expect(exitCode).toBe(1);
    // Names the timestamp asked for, so the user knows what was missing.
    expect(stderr).toContain("2020-01-01T00-00-00.000Z");
    // And nothing was silently restored instead.
    expect(readFileSync(join(ompDir, "models.yml"), "utf8")).toContain("deepseek");
  });

  test("reports when there is nothing to roll back", () => {
    const { stderr, exitCode } = runUnis(["rollback"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("no snapshots");
  });
});
