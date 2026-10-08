/**
 * Tests drive the real `unis` binary as a subprocess against a throwaway
 * config tree — the single seam mandated by the spec's Testing Decisions.
 * No internal module is imported; path resolution, parsing, output, and exit
 * codes are all asserted through the command boundary.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "cli.ts");

let root: string;
let ompDir: string;
let piDir: string;

/** Runs `unis` with the given argument in an environment pointed at `root`. */
function runUnis(
  arg: string,
  env: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, ENTRY, arg],
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

/** Presence of a C0/CSI escape sequence. */
function hasAnsi(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[][\[0-9;]*[A-Za-z]/.test(text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "unis-test-"));
  ompDir = join(root, "omp", "agent");
  piDir = join(root, "pi", "agent");
  mkdirSync(ompDir, { recursive: true });
  mkdirSync(piDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("unis list", () => {
  test("reports each Agent as skipped when not installed, exiting 0", () => {
    const { stdout, exitCode } = runUnis("list");

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`[OMP] ${ompDir}/models.yml Skipped (not installed)`);
    expect(stdout).toContain(`[PI] ${piDir}/models.json Skipped (not installed)`);
  });

  test("reports the resolved path with provider and model counts", () => {
    writeFileSync(
      join(ompDir, "models.yml"),
      [
        "providers:",
        "  deepseek:",
        "    models:",
        "      - id: a",
        "      - id: b",
        "  other:",
        "    models:",
        "      - id: c",
      ].join("\n"),
    );
    writeFileSync(
      join(piDir, "models.json"),
      JSON.stringify({
        providers: { deepseek: { models: [{ id: "a" }] } },
      }),
    );

    const { stdout, exitCode } = runUnis("list");

    expect(exitCode).toBe(0);
    const ompLine = stdout.split("\n").find((line) => line.includes("[OMP]"));
    expect(ompLine).toContain(`${ompDir}/models.yml`);
    expect(ompLine).toContain("2 providers, 3 models");
    const piLine = stdout.split("\n").find((line) => line.includes("[PI]"));
    expect(piLine).toContain(`${piDir}/models.json`);
    expect(piLine).toContain("1 providers, 1 models");
  });

  test("honors each Agent's directory environment variable", () => {
    const custom = join(root, "custom-omp");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "models.yml"), "providers: {}\n");

    const { stdout, exitCode } = runUnis("list", { OMP_CODING_AGENT_DIR: custom });

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`[OMP] ${custom}/models.yml`);
  });

  test("finds an omp config written as models.yaml", () => {
    const custom = join(root, "yaml-only");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "models.yaml"), "providers: {}\n");

    const { stdout, exitCode } = runUnis("list", { OMP_CODING_AGENT_DIR: custom });

    expect(exitCode).toBe(0);
    const ompLine = stdout.split("\n").find((line) => line.includes("[OMP]"));
    expect(ompLine).toContain(`${custom}/models.yaml`);
    expect(ompLine).not.toContain("Skipped (not installed)");
  });

  test("prefers models.yml over models.yaml when both exist", () => {
    const custom = join(root, "both-ext");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "models.yml"), "providers: { a: { models: [] } }\n");
    writeFileSync(join(custom, "models.yaml"), "providers: {}\n");

    const { stdout, exitCode } = runUnis("list", { OMP_CODING_AGENT_DIR: custom });

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`[OMP] ${custom}/models.yml`);
    expect(stdout).toContain("1 providers, 0 models");
  });

  test("falls back to the default location when the Agent's env var is empty", () => {
    const homeDir = join(root, "home");
    mkdirSync(join(homeDir, ".omp", "agent"), { recursive: true });
    writeFileSync(join(homeDir, ".omp", "agent", "models.yml"), "providers: {}\n");

    const { stdout, exitCode } = runUnis("list", {
      HOME: homeDir,
      OMP_CODING_AGENT_DIR: "",
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`[OMP] ${homeDir}/.omp/agent/models.yml`);
    expect(stdout).toContain("0 providers, 0 models");
  });

  test("reads a pi config with comments and a trailing comma", () => {
    writeFileSync(
      join(piDir, "models.json"),
      `{
      // a comment pi tolerates
      "providers": {
        "deepseek": { "models": [{ "id": "a" },] },
      },
    }`,
    );

    const { stdout, exitCode } = runUnis("list");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("[PI]");
    expect(stdout).toContain("1 providers, 1 models");
    expect(stdout).not.toContain("Failed");
  });

  test("reports a malformed config as Failed for that Agent only", () => {
    writeFileSync(join(ompDir, "models.yml"), "providers: [unclosed\n");
    writeFileSync(join(piDir, "models.json"), JSON.stringify({ providers: {} }));

    const { stdout, exitCode } = runUnis("list");

    const ompLine = stdout.split("\n").find((line) => line.includes("[OMP]"));
    expect(ompLine).toContain("Failed");
    expect(stdout).toContain("[PI]");
    expect(exitCode).not.toBe(2);
  });
});

describe("output and exit-code conventions", () => {
  test("prints line-oriented text with no ANSI escapes when piped", () => {
    writeFileSync(join(ompDir, "models.yml"), "providers: {}\n");

    const { stdout, exitCode } = runUnis("list");

    expect(exitCode).toBe(0);
    expect(hasAnsi(stdout)).toBe(false);
    expect(stdout.endsWith("\n")).toBe(true);
  });

  test("suppresses ANSI when NO_COLOR is set", () => {
    writeFileSync(join(ompDir, "models.yml"), "providers: {}\n");

    const { stdout } = runUnis("list", { NO_COLOR: "1" });

    expect(hasAnsi(stdout)).toBe(false);
  });

  test("an unknown command prints usage and exits non-zero", () => {
    const { exitCode } = runUnis("bogus");

    expect(exitCode).not.toBe(0);
  });

  test("a command with no arguments prints usage and exits non-zero", () => {
    const { exitCode } = runUnis("");
    expect(exitCode).not.toBe(0);
  });
});
