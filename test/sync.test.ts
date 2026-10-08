/**
 * Tests drive the real `unis` binary as a subprocess against a throwaway
 * config tree — the single seam mandated by the spec's Testing Decisions.
 * No internal module is imported; takeover, preservation, permissions, and
 * symlinks are all asserted through the command boundary and the files it
 * leaves behind.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "cli.ts");

let root: string;
let ompDir: string;
let piDir: string;
let scorePath: string;

/** A Score declaring one provider and one model, expandable and valid. */
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

/** The compiled Catalog as omp would read it back. */
const COMPILED_CATALOG = {
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
};

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

/** An omp config holding one unrelated provider, for a drifting start. */
function writeDriftingConfig(): void {
  writeFileSync(
    join(ompDir, "models.yml"),
    ["modelOverrides:", "  role: keep this", "providers:", "  stale:", "    models: []"].join("\n"),
  );
}

/**
 * Narrows a parsed YAML document to a map before reading a key out of it.
 *
 * Parsed YAML is outside-controlled data: casting it to a shape would trust it
 * unverified, and a malformed config would then read silently wrong. The guard
 * checks what it reads, and the key comes back `unknown` for the test to
 * compare rather than assume.
 */
function readKey(node: unknown, key: string): unknown {
  if (node !== null && typeof node === "object" && !Array.isArray(node) && key in node) {
    return (node as Record<string, unknown>)[key];
  }
  return undefined;
}

/** The `providers` map of an omp config, as parsed. */
function ompCatalog(): unknown {
  return readKey(Bun.YAML.parse(readFileSync(join(ompDir, "models.yml"), "utf8")), "providers");
}

/** The modified time of omp's config, for asserting a write did or did not happen. */
function ompMtime(): number {
  return statSync(join(ompDir, "models.yml")).mtimeMs;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "unis-sync-"));
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

describe("unis sync — takeover and preservation", () => {
  test("replaces the Catalog wholesale, so it holds exactly the compiled providers", () => {
    writeScore(VALID_SCORE);
    writeDriftingConfig();

    const { stdout, exitCode } = runUnis(["sync"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Synced (1 providers, 1 models)");
    expect(JSON.stringify(ompCatalog())).toBe(JSON.stringify(COMPILED_CATALOG));
  });

  test("preserves every non-Catalog top-level key byte-for-byte", () => {
    writeScore(VALID_SCORE);
    writeFileSync(
      join(ompDir, "models.yml"),
      [
        "# a leading comment",
        "modelOverrides:",
        "  role: 'keep this exactly'",
        'quoted: "double"',
        "providers:",
        "  stale:",
        "    models: []",
      ].join("\n"),
    );

    runUnis(["sync"]);

    const written = readFileSync(join(ompDir, "models.yml"), "utf8");
    // The user's own text — quoting, commentary, and all — is untouched.
    expect(written).toContain("# a leading comment");
    expect(written).toContain("modelOverrides:");
    expect(written).toContain("role: 'keep this exactly'");
    expect(written).toContain('quoted: "double"');
    // Blocks keep their place rather than being reordered by the replace.
    expect(written.indexOf("modelOverrides:")).toBeLessThan(written.indexOf("providers:"));
    // And what it wrote is the compiled Catalog, which the user's text surrounds.
    expect(JSON.stringify(ompCatalog())).toBe(JSON.stringify(COMPILED_CATALOG));
  });

  test("appends the Catalog when the config has none", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(ompDir, "models.yml"), "modelOverrides:\n  role: keep\n");

    const { exitCode } = runUnis(["sync"]);

    expect(exitCode).toBe(0);
    expect(readKey(Bun.YAML.parse(readFileSync(join(ompDir, "models.yml"), "utf8")), "modelOverrides")).toEqual({
      role: "keep",
    });
    expect(JSON.stringify(ompCatalog())).toBe(JSON.stringify(COMPILED_CATALOG));
  });
});

describe("unis sync — idempotence", () => {
  test("writes nothing when the Catalog already equals the compiled result", () => {
    writeScore(VALID_SCORE);
    const converged = Bun.YAML.stringify(
      { modelOverrides: { role: "keep" }, providers: COMPILED_CATALOG },
      null,
      2,
    );
    writeFileSync(join(ompDir, "models.yml"), converged);
    const mtimeBefore = ompMtime();

    const { stdout, exitCode } = runUnis(["sync"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Unchanged (1 providers, 1 models)");
    expect(stdout).not.toContain("drifts");
    // No snapshot and no write: contents and mtime are as they were.
    expect(readFileSync(join(ompDir, "models.yml"), "utf8")).toBe(converged);
    expect(ompMtime()).toBe(mtimeBefore);
  });

  test("does not rewrite a file that differs only in key order or indentation", () => {
    writeScore(VALID_SCORE);
    const reformatted = [
      "providers:",
      "  deepseek:",
      "      models:",
      '        - id: "deepseek-reasoner"',
      "          reasoning: true",
      "          maxTokens: 8192",
      "          contextWindow: 65536",
      '          name: "DeepSeek R1 (Reasoning)"',
      "      headers:",
      '        User-Agent: "Unisono-Sync/1.0"',
      '      apiKey: "sk-sample-key-1234567890"',
      '      api: "openai-completions"',
      '      baseUrl: "https://api.deepseek.com/v1"',
      '      name: "DeepSeek Official"',
    ].join("\n");
    writeFileSync(join(ompDir, "models.yml"), reformatted);
    const mtimeBefore = ompMtime();

    const { stdout, exitCode } = runUnis(["sync"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Unchanged");
    // Semantic equality drives the decision, so the formatting is left alone.
    expect(readFileSync(join(ompDir, "models.yml"), "utf8")).toBe(reformatted);
    expect(ompMtime()).toBe(mtimeBefore);
  });
});

describe("unis sync — write safety", () => {
  test("writes the target config with 0600 permissions", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(ompDir, "models.yml"), "providers: {}\n");
    // Start world-readable, as a hand-written config often is.
    chmodSync(join(ompDir, "models.yml"), 0o644);

    const { exitCode } = runUnis(["sync"]);

    expect(exitCode).toBe(0);
    expect(statSync(join(ompDir, "models.yml")).mode & 0o777).toBe(0o600);
  });

  test("writes through a symlink, replacing the real file and keeping the link", () => {
    writeScore(VALID_SCORE);
    const real = join(root, "real-models.yml");
    const linked = join(root, "linked", "agent");
    mkdirSync(linked, { recursive: true });
    writeFileSync(real, "providers:\n  stale: {}\n");
    symlinkSync(real, join(linked, "models.yml"));

    const { stdout, exitCode } = runUnis(["sync"], { OMP_CODING_AGENT_DIR: linked });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Synced");
    // The link survives and still points at the real file, which was replaced
    // in place — so nothing that points at the user's config is left dangling.
    expect(lstatSync(join(linked, "models.yml")).isSymbolicLink()).toBe(true);
    const written = Bun.YAML.parse(readFileSync(real, "utf8"));
    expect(JSON.stringify(readKey(written, "providers"))).toBe(JSON.stringify(COMPILED_CATALOG));
  });

  test("leaves no temporary files behind", () => {
    writeScore(VALID_SCORE);
    writeDriftingConfig();

    const { exitCode } = runUnis(["sync"]);

    expect(exitCode).toBe(0);
    expect(readdirSync(ompDir)).toEqual(["models.yml"]);
  });

  test("does not overwrite a config that changed after the sync read it", () => {
    // Two syncs run back to back: the second sees what the first wrote, so it
    // converges and never fights it. A file edited *between* a sync's read and
    // its write is the case the hash re-check refuses, and it cannot be
    // produced from outside the process — the test drives the real command
    // twice, which is the boundary this suite asserts through.
    writeScore(VALID_SCORE);
    writeDriftingConfig();

    const first = runUnis(["sync"]);
    const afterFirst = readFileSync(join(ompDir, "models.yml"), "utf8");

    const second = runUnis(["sync"]);

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("Synced");
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Unchanged");
    // The second sync made no write, so what the first wrote stands.
    expect(readFileSync(join(ompDir, "models.yml"), "utf8")).toBe(afterFirst);
  });
});

describe("unis sync --dry-run", () => {
  test("previews the takeover and writes nothing", () => {
    writeScore(VALID_SCORE);
    writeDriftingConfig();
    const before = readFileSync(join(ompDir, "models.yml"), "utf8");
    const mtimeBefore = ompMtime();

    const { stdout, exitCode } = runUnis(["sync", "--dry-run"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("drifts");
    expect(stdout).not.toContain("Synced");
    expect(readFileSync(join(ompDir, "models.yml"), "utf8")).toBe(before);
    expect(ompMtime()).toBe(mtimeBefore);
  });
});

describe("unis sync — reporting", () => {
  test("reports each Agent's state and exits 1 when one cannot be parsed", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(ompDir, "models.yml"), "providers: [unclosed\n");
    writeFileSync(join(piDir, "models.json"), "{ broken");

    const { stdout, exitCode } = runUnis(["sync"]);

    // One broken Agent must not blind the other.
    expect(stdout).toContain("[OMP]");
    expect(stdout).toContain("[PI]");
    expect(stdout).toContain("Failed");
    expect(exitCode).toBe(1);
  });

  test("exits 1 with the reason when the Score itself is invalid", () => {
    writeScore('version: "2"\nproviders: {}\n');

    const { stderr, exitCode } = runUnis(["sync"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("version");
  });

  test("rejects an unknown flag rather than syncing with it", () => {
    writeScore(VALID_SCORE);
    writeDriftingConfig();

    const { exitCode } = runUnis(["sync", "--yolo"]);

    expect(exitCode).not.toBe(0);
    // Nothing was written while the flag was being rejected.
    expect(readFileSync(join(ompDir, "models.yml"), "utf8")).toContain("stale");
  });
});
