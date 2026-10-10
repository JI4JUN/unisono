/**
 * The one test seam every command's tests drive through.
 *
 * Tests spawn the real `unis` binary as a subprocess against a throwaway
 * config tree, and assert the files, permissions, output, and exit codes it
 * leaves behind — never the internals. That is the spec's Testing Decisions,
 * and it means the spawning, the environment, and the per-test tree are the
 * same for all seven command files. They live here once rather than eight
 * times, so a change to the seam — a new environment variable, a different
 * `NO_COLOR` contract — is one edit rather than eight.
 *
 * The tree is created per test and removed after it: nothing in this harness
 * points at a real Agent config or the real home directory, so a suite run
 * cannot touch one.
 */

import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The binary under test, as a source entry the Bun runtime runs directly. */
const ENTRY = join(import.meta.dir, "..", "src", "cli.ts");

/** What a command run produced, as the only observable surface. */
export type RunResult = { stdout: string; stderr: string; exitCode: number };

/** The throwaway tree this file's tests run against. */
export type Sandbox = {
  /** The test's root, holding everything the tool is allowed to see. */
  root: string;
  /** `$XDG_CONFIG_HOME`, whose `unisono/` holds the Score and the backups. */
  configDir: string;
  ompDir: string;
  piDir: string;
  /** The Score's single location. */
  scorePath: string;
  /** The backup area, so a test can count or inspect snapshots. */
  backupsDir: string;
};

/**
 * Creates a fresh sandbox and its directories, per test.
 *
 * The directories are made rather than merely named, because a config the tool
 * finds absent is one it reports `Skipped (not installed)` for — a different
 * contract from a config that is present but empty. Each test decides which of
 * the two it wants by writing files or not.
 */
export function useSandbox(): Sandbox {
  const sandbox: Sandbox = {
    root: "",
    configDir: "",
    ompDir: "",
    piDir: "",
    scorePath: "",
    backupsDir: "",
  };

  beforeEach(() => {
    sandbox.root = mkdtempSync(join(tmpdir(), "unis-"));
    sandbox.configDir = join(sandbox.root, "config");
    sandbox.ompDir = join(sandbox.root, "omp", "agent");
    sandbox.piDir = join(sandbox.root, "pi", "agent");
    sandbox.scorePath = join(sandbox.configDir, "unisono", "score.yaml");
    sandbox.backupsDir = join(sandbox.configDir, "unisono", "backups");
    mkdirSync(sandbox.ompDir, { recursive: true });
    mkdirSync(sandbox.piDir, { recursive: true });
    mkdirSync(join(sandbox.configDir, "unisono"), { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox.root, { recursive: true, force: true });
  });

  return sandbox;
}

/**
 * Runs `unis` in the sandbox, with any extra environment on top.
 *
 * The environment is replaced rather than inherited, because the tool reads
 * `HOME`, `XDG_CONFIG_HOME`, and both Agents' directory variables to find its
 * files: a real `~/.omp` in the environment would make a test write to it.
 * `PATH` is the one exception — the runtime is invoked by absolute path, but a
 * child that shells out still needs to find things, and `NO_COLOR` keeps the
 * output assertable.
 */
export function runUnis(
  sandbox: Sandbox,
  args: string[],
  envExtra: Record<string, string> = {},
  stdin?: string,
): RunResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, ENTRY, ...args],
    env: {
      HOME: sandbox.root,
      XDG_CONFIG_HOME: sandbox.configDir,
      OMP_CODING_AGENT_DIR: sandbox.ompDir,
      PI_CODING_AGENT_DIR: sandbox.piDir,
      NO_COLOR: "1",
      PATH: process.env.PATH ?? "",
      ...envExtra,
    },
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode ?? -1,
  };
}
