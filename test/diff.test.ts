/**
 * Tests drive the real `unis` binary as a subprocess against a throwaway
 * config tree — the single seam mandated by the spec's Testing Decisions.
 * No internal module is imported; compilation, Override merging, equality,
 * masking, and exit codes are all asserted through the command boundary.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "cli.ts");

let root: string;
let ompDir: string;
let piDir: string;
let scorePath: string;

/** A Score declaring one provider and one reasoner model, expandable and valid. */
const VALID_SCORE = `version: "1"
providers:
  deepseek:
    name: "DeepSeek Official"
    baseUrl: "https://api.deepseek.com/v1"
    apiKey: "sk-sample-key-1234567890"
    apiType: "openai-completions"
    headers:
      User-Agent: "Unisono-Sync/1.0"
    models:
      - id: "deepseek-reasoner"
        name: "DeepSeek R1 (Reasoning)"
        contextWindow: 65536
        maxTokens: 8192
        reasoning: true
`;

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

function writeScore(text: string): void {
  writeFileSync(scorePath, text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "unis-diff-"));
  ompDir = join(root, "omp", "agent");
  piDir = join(root, "pi", "agent");
  scorePath = join(root, "config", "unisono", "score.yaml");
  mkdirSync(ompDir, { recursive: true });
  mkdirSync(piDir, { recursive: true });
  mkdirSync(join(root, "config", "unisono"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The omp Catalog the plain VALID_SCORE compiles to. */
const MAPPED_CATALOG = `    name: "DeepSeek Official"
    baseUrl: "https://api.deepseek.com/v1"
    api: "openai-completions"
    apiKey: "sk-sample-key-1234567890"
    headers:
      User-Agent: "Unisono-Sync/1.0"
    models:
      - id: "deepseek-reasoner"
        name: "DeepSeek R1 (Reasoning)"
        contextWindow: 65536
        maxTokens: 8192
        reasoning: true`;

describe("unis diff", () => {
  test("reports nothing to change when omp already holds the compiled Catalog, exiting 0", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(ompDir, "models.yml"), `providers:\n  deepseek:\n${MAPPED_CATALOG}\n`);

    const { stdout, exitCode } = runUnis("diff");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("[OMP]");
    expect(stdout).toContain("Unchanged");
    expect(stdout).not.toContain("drifts");
  });

  test("treats key order and indentation as no difference", () => {
    // Semantic equality, not textual: every key is deliberately out of the
    // order the compiler emits, and indentation differs.
    writeScore(VALID_SCORE);
    writeFileSync(
      join(ompDir, "models.yml"),
      [
        "providers:",
        "  deepseek:",
        "      models:",
        '        - id: "deepseek-reasoner"',
        '          reasoning: true',
        "          maxTokens: 8192",
        "          contextWindow: 65536",
        '          name: "DeepSeek R1 (Reasoning)"',
        "      headers:",
        '        User-Agent: "Unisono-Sync/1.0"',
        '      apiKey: "sk-sample-key-1234567890"',
        '      api: "openai-completions"',
        '      baseUrl: "https://api.deepseek.com/v1"',
        '      name: "DeepSeek Official"',
      ].join("\n"),
    );

    const { stdout, exitCode } = runUnis("diff");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Unchanged");
  });

  test("names each differing field and shows what each side holds", () => {
    writeScore(VALID_SCORE);
    writeFileSync(
      join(ompDir, "models.yml"),
      [
        "providers:",
        "  deepseek:",
        '    name: "DeepSeek Official"',
        '    baseUrl: "https://api.deepseek.com/v1"',
        '    api: "openai-completions"',
        '    apiKey: "sk-sample-key-1234567890"',
        "    headers:",
        '      User-Agent: "Unisono-Sync/1.0"',
        "    models:",
        "      - id: deepseek-reasoner",
        '        name: "Old Model Name"',
        "        contextWindow: 4096",
        "        reasoning: true",
      ].join("\n"),
    );

    const { stdout, exitCode } = runUnis("diff");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("drifts in 3 field(s)");
    expect(stdout).toContain("deepseek.models[0].name");
    expect(stdout).toContain("Old Model Name");
    expect(stdout).toContain("DeepSeek R1 (Reasoning)");
    expect(stdout).toContain("deepseek.models[0].contextWindow");
    expect(stdout).toContain("4096");
    expect(stdout).toContain("deepseek.models[0].maxTokens");
  });

  test("reports a Provider missing from disk as an addition and an extra one as a removal", () => {
    writeScore(VALID_SCORE);
    writeFileSync(
      join(ompDir, "models.yml"),
      ["providers:", "  stale:", "    models: []", `    name: "Stale"`].join("\n"),
    );

    const { stdout, exitCode } = runUnis("diff");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("deepseek");
    expect(stdout).toContain("will be added");
    expect(stdout).toContain("stale");
    expect(stdout).toContain("will be removed");
  });

  test("masks apiKey inside a whole-Provider addition and removal", () => {
    // A whole-Provider render is the other place a credential surfaces: the
    // line dumps the entire Provider map, key included.
    writeScore(VALID_SCORE);
    writeFileSync(
      join(ompDir, "models.yml"),
      [
        "providers:",
        "  stale:",
        '    apiKey: "sk-on-disk-key-1234567890"',
        "    models: []",
      ].join("\n"),
    );

    const { stdout } = runUnis("diff");

    expect(stdout).not.toContain("sk-sample-key-1234567890");
    expect(stdout).not.toContain("sk-on-disk-key-1234567890");
    expect(stdout).toContain("will be added");
    expect(stdout).toContain("will be removed");
  });

  test("masks apiKey as the first five and last four characters", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(ompDir, "models.yml"), "providers:\n  deepseek:\n    models: []\n");

    const { stdout } = runUnis("diff");

    expect(stdout).toContain("sk-sa***7890");
    expect(stdout).not.toContain("sk-sample-key-1234567890");
  });

  test("fully stars an apiKey too short to split", () => {
    writeScore(
      VALID_SCORE.replace('    apiKey: "sk-sample-key-1234567890"\n', '    apiKey: "short"\n'),
    );
    writeFileSync(join(ompDir, "models.yml"), "providers:\n  deepseek:\n    models: []\n");

    const { stdout } = runUnis("diff");

    expect(stdout).not.toContain("shortkey");
  });

  test("leaves every file byte-identical", () => {
    writeScore(VALID_SCORE);
    const before = `providers:\n  deepseek:\n${MAPPED_CATALOG}\n`;
    writeFileSync(join(ompDir, "models.yml"), before);

    const { exitCode } = runUnis("diff");

    expect(exitCode).toBe(0);
    expect(readFileSync(join(ompDir, "models.yml"), "utf8")).toBe(before);
  });

  test("reports a config that cannot be parsed as Failed and exits 1", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(ompDir, "models.yml"), "providers: [unclosed\n");

    const { stdout, exitCode } = runUnis("diff");

    expect(stdout).toContain("[OMP]");
    expect(stdout).toContain("Failed");
    expect(exitCode).toBe(1);
  });

  test("inspects the other Agent even when one cannot be parsed", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(ompDir, "models.yml"), "providers: [unclosed\n");
    writeFileSync(join(piDir, "models.json"), "{ broken");

    const { stdout, exitCode } = runUnis("diff");

    // A broken Agent must not blind the other one: both are reported.
    expect(stdout).toContain("[OMP]");
    expect(stdout).toContain("[PI]");
    expect(stdout).not.toContain("Skipped");
    expect(exitCode).toBe(1);
  });

  test("still reports the good Agent when the other one is unparseable", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(ompDir, "models.yml"), "providers: [unclosed\n");
    writeFileSync(
      join(piDir, "models.json"),
      JSON.stringify({
        providers: {
          deepseek: {
            name: "DeepSeek Official",
            baseUrl: "https://api.deepseek.com/v1",
            api: "openai-completions",
            apiKey: "sk-sample-key-1234567890",
            headers: { "User-Agent": "Unisono-Sync/1.0" },
            models: [
              {
                id: "deepseek-reasoner",
                name: "DeepSeek R1 (Reasoning)",
                contextWindow: 65536,
                maxTokens: 8192,
                reasoning: true,
              },
            ],
          },
        },
      }),
    );

    const { stdout, exitCode } = runUnis("diff");

    expect(stdout).toContain("[OMP]");
    expect(stdout).toContain("Failed");
    expect(stdout).toContain("[PI]");
    expect(stdout).toContain("Unchanged");
    expect(exitCode).toBe(1);
  });

  test("reports a missing Agent as Skipped without failing", () => {
    writeScore(VALID_SCORE);

    const { stdout, exitCode } = runUnis("diff");

    expect(stdout).toContain("[OMP]");
    expect(stdout).toContain("Skipped (not installed)");
    expect(stdout).toContain("[PI]");
    expect(exitCode).toBe(0);
  });

  test("exits 1 with the reason when the Score itself is invalid", () => {
    writeScore("version: \"2\"\nproviders: {}\n");

    const { stderr, exitCode } = runUnis("diff");

    expect(exitCode).toBe(1);
    expect(stderr).toContain("version");
  });
});

describe("Override deep-merge", () => {
  test("an Override key wins on a name collision with the standard mapping", () => {
    writeScore(
      `version: "1"
providers:
  p:
    name: "Score Name"
    baseUrl: "https://x"
    apiKey: "k"
    apiType: "openai-completions"
    overrides:
      omp:
        name: "Override Name"
    models:
      - id: m
        name: "Score Model"
        contextWindow: 10
        overrides:
          omp:
            contextWindow: 1
`,
    );
    // On disk exactly the merge result; if the Score's value won instead,
    // two fields would drift.
    writeFileSync(
      join(ompDir, "models.yml"),
      [
        "providers:",
        "  p:",
        '    name: "Override Name"',
        '    baseUrl: "https://x"',
        '    api: "openai-completions"',
        '    apiKey: "k"',
        "    models:",
        "      - id: m",
        '        name: "Score Model"',
        "        contextWindow: 1",
      ].join("\n"),
    );

    const { stdout, exitCode } = runUnis("diff");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Unchanged");
  });

  test("overriding one nested key preserves its siblings", () => {
    writeScore(
      `version: "1"
providers:
  p:
    name: "Score Name"
    baseUrl: "https://x"
    apiKey: "k"
    apiType: "openai-completions"
    overrides:
      omp:
        compat:
          supportsDeveloperRole: false
          supportsStreaming: true
    models:
      - id: m
        name: M
        contextWindow: 10
`,
    );
    // The sibling is present, so a shallow merge — which would wipe it — is
    // rejected rather than reported as unchanged.
    writeFileSync(
      join(ompDir, "models.yml"),
      [
        "providers:",
        "  p:",
        '    name: "Score Name"',
        '    baseUrl: "https://x"',
        '    api: "openai-completions"',
        '    apiKey: "k"',
        "    compat:",
        "      supportsDeveloperRole: false",
        "      supportsStreaming: true",
        "    models:",
        "      - id: m",
        "        name: M",
        "        contextWindow: 10",
      ].join("\n"),
    );

    const { stdout, exitCode } = runUnis("diff");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Unchanged");
  });

  test("reports a dropped sibling as a drift", () => {
    writeScore(
      `version: "1"
providers:
  p:
    name: "Score Name"
    baseUrl: "https://x"
    apiKey: "k"
    apiType: "openai-completions"
    overrides:
      omp:
        compat:
          supportsDeveloperRole: false
    models:
      - id: m
        name: M
        contextWindow: 10
`,
    );
    writeFileSync(
      join(ompDir, "models.yml"),
      [
        "providers:",
        "  p:",
        '    name: "Score Name"',
        '    baseUrl: "https://x"',
        '    api: "openai-completions"',
        '    apiKey: "k"',
        "    compat:",
        "      supportsDeveloperRole: false",
        "      extra: keep",
        "    models:",
        "      - id: m",
        "        name: M",
        "        contextWindow: 10",
      ].join("\n"),
    );

    const { stdout, exitCode } = runUnis("diff");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("drifts");
    expect(stdout).toContain("p.compat.extra");
  });

  test("an Override under a different Agent id is not merged into this one", () => {
    writeScore(
      `version: "1"
providers:
  p:
    name: "Score Name"
    baseUrl: "https://x"
    apiKey: "k"
    apiType: "openai-completions"
    overrides:
      pi:
        piOnly: true
    models:
      - id: m
        name: M
        contextWindow: 10
`,
    );
    writeFileSync(
      join(ompDir, "models.yml"),
      [
        "providers:",
        "  p:",
        '    name: "Score Name"',
        '    baseUrl: "https://x"',
        '    api: "openai-completions"',
        '    apiKey: "k"',
        "    models:",
        "      - id: m",
        "        name: M",
        "        contextWindow: 10",
      ].join("\n"),
    );

    const { stdout, exitCode } = runUnis("diff");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Unchanged");
  });
});

describe("unis list Catalog comparison", () => {
  test("reports Synced when omp holds the compiled Catalog", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(ompDir, "models.yml"), `providers:\n  deepseek:\n${MAPPED_CATALOG}\n`);

    const { stdout, exitCode } = runUnis("list");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("[OMP]");
    expect(stdout).toContain("Synced");
  });

  test("reports drifting when the on-disk Catalog differs", () => {
    writeScore(VALID_SCORE);
    writeFileSync(
      join(ompDir, "models.yml"),
      ["providers:", "  deepseek:", "    models: []", "    name: X"].join("\n"),
    );

    const { stdout, exitCode } = runUnis("list");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("drifts");
    expect(stdout).not.toContain("Synced");
  });

  test("reports Failed when the config cannot be parsed", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(ompDir, "models.yml"), "providers: [unclosed\n");

    const { stdout, exitCode } = runUnis("list");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Failed");
  });

  test("does not claim Synced when no Score could be read", () => {
    writeScore("");

    const { stdout, exitCode } = runUnis("list");

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("Synced");
    expect(stdout).toContain("[OMP]");
    expect(stdout).toContain("[PI]");
  });
});
