/**
 * Tests drive the real `unis` binary as a subprocess against a throwaway
 * config tree — the single seam mandated by the spec's Testing Decisions.
 * No internal module is imported; path resolution, parsing, output, and exit
 * codes are all asserted through the command boundary. The seam itself, the
 * sandbox, and the per-test teardown come from `test/harness.ts`.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runUnis, useSandbox, type Sandbox } from "./harness";

const sandbox: Sandbox = useSandbox();

/** Presence of a C0 or CSI escape sequence. */
function hasAnsi(text: string): boolean {
  return text.includes("\x1b[");
}

/** Writes an unparseable Score so `unis list` has nothing to compare against. */
function writeNoScore(): void {
  writeFileSync(join(sandbox.root, "config", "unisono", "score.yaml"), "");
}

describe("unis list", () => {

  test("reports each Agent as skipped when not installed, exiting 0", () => {
    const { stdout, exitCode } = runUnis(sandbox, ["list"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`[OMP] ${sandbox.ompDir}/models.yml Skipped (not installed)`);
    expect(stdout).toContain(`[PI] ${sandbox.piDir}/models.json Skipped (not installed)`);
  });

  test("reports the resolved path with provider and model counts", () => {
    writeFileSync(
      join(sandbox.ompDir, "models.yml"),
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
      join(sandbox.piDir, "models.json"),
      JSON.stringify({
        providers: { deepseek: { models: [{ id: "a" }] } },
      }),
    );
    // With no Score on disk there is nothing to compare against, so the
    // report falls back to counting what each config holds.
    writeNoScore();

    const { stdout, exitCode } = runUnis(sandbox, ["list"]);

    expect(exitCode).toBe(0);
    const ompLine = stdout.split("\n").find((line) => line.includes("[OMP]"));
    expect(ompLine).toContain(`${sandbox.ompDir}/models.yml`);
    expect(ompLine).toContain("2 providers, 3 models");
    const piLine = stdout.split("\n").find((line) => line.includes("[PI]"));
    expect(piLine).toContain(`${sandbox.piDir}/models.json`);
    expect(piLine).toContain("1 providers, 1 models");
  });

  test("honors each Agent's directory environment variable", () => {
    const custom = join(sandbox.root, "custom-omp");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "models.yml"), "providers: {}\n");

    const { stdout, exitCode } = runUnis(sandbox, ["list"], { OMP_CODING_AGENT_DIR: custom });

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`[OMP] ${custom}/models.yml`);
  });

  test("finds an omp config written as models.yaml", () => {
    const custom = join(sandbox.root, "yaml-only");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "models.yaml"), "providers: {}\n");

    const { stdout, exitCode } = runUnis(sandbox, ["list"], { OMP_CODING_AGENT_DIR: custom });

    expect(exitCode).toBe(0);
    const ompLine = stdout.split("\n").find((line) => line.includes("[OMP]"));
    expect(ompLine).toContain(`${custom}/models.yaml`);
    expect(ompLine).not.toContain("Skipped (not installed)");
  });

  test("prefers models.yml over models.yaml when both exist", () => {
    const custom = join(sandbox.root, "both-ext");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "models.yml"), "providers: { a: { models: [] } }\n");
    writeFileSync(join(custom, "models.yaml"), "providers: {}\n");

    // No Score on disk: the report counts what each config holds.
    writeNoScore();
    const { stdout, exitCode } = runUnis(sandbox, ["list"], { OMP_CODING_AGENT_DIR: custom });

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`[OMP] ${custom}/models.yml`);
    expect(stdout).toContain("1 providers, 0 models");
  });

  test("falls back to the default location when the Agent's env var is empty", () => {
    const homeDir = join(sandbox.root, "home");
    mkdirSync(join(homeDir, ".omp", "agent"), { recursive: true });
    writeFileSync(join(homeDir, ".omp", "agent", "models.yml"), "providers: {}\n");
    writeNoScore();

    const { stdout, exitCode } = runUnis(sandbox, ["list"], {
      HOME: homeDir,
      OMP_CODING_AGENT_DIR: "",
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`[OMP] ${homeDir}/.omp/agent/models.yml`);
    expect(stdout).toContain("0 providers, 0 models");
  });

  test("reads a pi config with comments and a trailing comma", () => {
    writeFileSync(
      join(sandbox.piDir, "models.json"),
      `{
      // a comment pi tolerates
      "providers": {
        "deepseek": { "models": [{ "id": "a" },] },
      },
    }`,
    );
    writeNoScore();

    const { stdout, exitCode } = runUnis(sandbox, ["list"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("[PI]");
    expect(stdout).toContain("1 providers, 1 models");
    expect(stdout).not.toContain("Failed");
  });

  test("reports a malformed config as Failed for that Agent only", () => {
    writeFileSync(join(sandbox.ompDir, "models.yml"), "providers: [unclosed\n");
    writeFileSync(join(sandbox.piDir, "models.json"), JSON.stringify({ providers: {} }));

    const { stdout, exitCode } = runUnis(sandbox, ["list"]);

    const ompLine = stdout.split("\n").find((line) => line.includes("[OMP]"));
    expect(ompLine).toContain("Failed");
    expect(stdout).toContain("[PI]");
    expect(exitCode).not.toBe(2);
  });
});

describe("output and exit-code conventions", () => {
  test("prints line-oriented text with no ANSI escapes when piped", () => {
    writeFileSync(join(sandbox.ompDir, "models.yml"), "providers: {}\n");

    const { stdout, exitCode } = runUnis(sandbox, ["list"]);

    expect(exitCode).toBe(0);
    expect(hasAnsi(stdout)).toBe(false);
    expect(stdout.endsWith("\n")).toBe(true);
  });

  test("suppresses ANSI when NO_COLOR is set", () => {
    writeFileSync(join(sandbox.ompDir, "models.yml"), "providers: {}\n");

    const { stdout } = runUnis(sandbox, ["list"], { NO_COLOR: "1" });

    expect(hasAnsi(stdout)).toBe(false);
  });

  test("an unknown command prints usage and exits non-zero", () => {
    const { exitCode } = runUnis(sandbox, ["bogus"]);

    expect(exitCode).not.toBe(0);
  });

  test("a command with no arguments prints usage and exits non-zero", () => {
    const { exitCode } = runUnis(sandbox, []);
    expect(exitCode).not.toBe(0);
  });
});
