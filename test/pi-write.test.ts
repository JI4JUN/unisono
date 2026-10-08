/**
 * Tests drive the real `unis` binary as a subprocess against a throwaway
 * config tree — the single seam mandated by the spec's Testing Decisions.
 * No internal module is imported: pi's takeover, its `!`/`$` escaping, its
 * comment-and-trailing-comma tolerance on read, and the preservation of its
 * non-Catalog nodes are all asserted through the command boundary and the
 * files it leaves behind.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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

/** The compiled Catalog as the Agents read it back, serialization aside. */
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

/** pi's config file path. */
function piConfigPath(): string {
  return join(piDir, "models.json");
}

/** pi's config as parsed text. */
function piConfigText(): string {
  return readFileSync(piConfigPath(), "utf8");
}

/**
 * Narrows a parsed document to a map before reading a key out of it.
 *
 * Parsed JSONC and YAML are outside-controlled data: casting them to a shape
 * would trust what they hold unverified, and a malformed config would then
 * read silently wrong. The guard checks what it reads, and the key comes back
 * `unknown` for the test to compare rather than assume.
 */
function readKey(node: unknown, key: string): unknown {
  if (node !== null && typeof node === "object" && !Array.isArray(node) && key in node) {
    return (node as Record<string, unknown>)[key];
  }
  return undefined;
}

/** The `providers` map of pi's config, as parsed. */
function piCatalog(): unknown {
  return readKey(Bun.JSONC.parse(piConfigText()), "providers");
}

/** pi's config's whole top-level document, as parsed. */
function piDocument(): unknown {
  return Bun.JSONC.parse(piConfigText());
}

/** A pi config holding one unrelated provider, for a drifting start. */
function writeDriftingConfig(): void {
  writeFileSync(piConfigPath(), JSON.stringify({ providers: { stale: { models: [] } } }, null, 2));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "unis-pi-"));
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

/**
 * pi's own reading of a value it was written.
 *
 * `$$` collapses back to `$`, and a leading `$!` means "this was not a
 * command, it was a literal `!`". The scan runs once, left to right, so the `$`
 * in `$!` is never mistaken for the start of a `$$` — which is why escaping
 * doubles first on write.
 */
function resolve(value: unknown): unknown {
  if (typeof value === "string") {
    let out = "";
    for (let at = 0; at < value.length; at += 1) {
      const pair = value.slice(at, at + 2);
      if (pair === "$$") {
        out += "$";
        at += 1;
      } else if (pair === "$!") {
        out += "!";
        at += 1;
      } else {
        out += value[at];
      }
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(resolve);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolve(item);
    return out;
  }
  return value;
}

describe("unis sync — pi takeover", () => {
  test("leaves omp and pi semantically equal after a two-provider, three-model sync", () => {
    writeScore(`version: "1"
providers:
  deepseek:
    name: "DeepSeek Official"
    baseUrl: "https://api.deepseek.com/v1"
    apiKey: "sk-abc$def"
    apiType: "openai-completions"
    models:
      - id: "chat"
        name: "V3"
        contextWindow: 65536
      - id: "reasoner"
        name: "R1"
        contextWindow: 65536
  anthropic:
    name: "Anthropic"
    baseUrl: "https://api.anthropic.com/v1"
    apiKey: "sk-ant"
    apiType: "anthropic-messages"
    models:
      - id: "sonnet"
        name: "Sonnet"
        contextWindow: 200000
`);
    writeFileSync(join(ompDir, "models.yml"), "providers: {}\n");
    writeFileSync(piConfigPath(), '{"providers":{}}');

    const { exitCode } = runUnis(["sync", "--yes"]);
    expect(exitCode).toBe(0);

    const omp = readKey(Bun.YAML.parse(readFileSync(join(ompDir, "models.yml"), "utf8")), "providers");
    const pi = readKey(piDocument(), "providers");
    // Semantically equal, not byte-equal: pi's values are in write form, where
    // a `$` is doubled, and its own reading collapses them back. So the
    // comparison is against what pi resolves, which is what the Score said.
    expect(JSON.stringify(omp)).toBe(JSON.stringify(resolve(pi)));
    const ompProviders = omp as Record<string, { models: unknown[] }>;
    const piProviders = pi as Record<string, { models: unknown[] }>;
    expect(Object.keys(ompProviders)).toHaveLength(2);
    const models = Object.values(piProviders).flatMap((provider) => provider.models);
    expect(models).toHaveLength(3);
  });
  test("takes over pi's providers map wholesale", () => {
    writeScore(VALID_SCORE);
    writeDriftingConfig();

    const { stdout, exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Synced (1 providers, 1 models)");
    expect(JSON.stringify(piCatalog())).toBe(JSON.stringify(COMPILED_CATALOG));
  });

  test("preserves every non-Catalog top-level node of pi's config, byte for byte", () => {
    writeScore(VALID_SCORE);
    // A comment, four-space indentation, and a trailing comma are all things
    // pi accepts and none are the tool's to reformat — so they are in the
    // starting config to prove they come back exactly.
    const settingsBlock = [
      '    "settings": {',
      '        "theme": "dark",',
      '        "defaultModel": "deepseek/deepseek-reasoner",',
      '    },',
    ].join("\n");
    writeFileSync(
      piConfigPath(),
      [
        "{",
        "  // a comment pi tolerates",
        settingsBlock,
        '    "providers": { "stale": { "models": [] } }',
        "}",
      ].join("\n"),
    );

    const { exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    const text = piConfigText();
    // Byte for byte: the comment, the indentation, and the trailing comma are
    // all still there, and the node still reads back as the same values.
    expect(text).toContain("// a comment pi tolerates");
    expect(text).toContain(settingsBlock);
    const document = readKey(piDocument(), "settings");
    expect(JSON.stringify(document)).toBe(
      JSON.stringify({ theme: "dark", defaultModel: "deepseek/deepseek-reasoner" }),
    );
  });

  test("keeps a user node's indentation and comment across a second sync", () => {
    writeScore(VALID_SCORE);
    const settings = [
      "  // keep me",
      '  "settings": {',
      '      "a": 1,',
      "  },",
    ].join("\n");
    writeFileSync(piConfigPath(), ["{", settings, '  "providers": {}', "}"].join("\n"));

    expect(runUnis(["sync", "--yes"]).exitCode).toBe(0);
    expect(runUnis(["sync", "--yes"]).stdout).toContain("Unchanged");

    expect(piConfigText()).toContain(settings);
  });

  test("reads a pi config carrying comments and a trailing comma", () => {
    writeScore(VALID_SCORE);
    // A comment stripper followed by `JSON.parse` would reject this: a trailing
    // comma is a syntax error that way. `Bun.JSONC.parse` is what pi itself
    // tolerates, so reading through it is the behavior under test.
    writeFileSync(
      piConfigPath(),
      [
        "{",
        '  "providers": {',
        '    "stale": { "models": [] }',
        "  },",
        '  "settings": { "theme": "dark" },',
        "}",
      ].join("\n"),
    );

    const { stdout, stderr, exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("Failed");
    expect(stderr).not.toContain("Failed");
  });

  test("leaves an unchanged pi config alone, reporting Unchanged and no write", () => {
    writeScore(VALID_SCORE);
    writeFileSync(piConfigPath(), JSON.stringify({ providers: COMPILED_CATALOG }, null, 2));

    const before = statSync(piConfigPath()).mtimeMs;
    const { stdout, exitCode } = runUnis(["sync"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Unchanged");
    expect(statSync(piConfigPath()).mtimeMs).toBe(before);
  });

  test("writes pi's config as standard JSON with two-space indentation", () => {
    writeScore(VALID_SCORE);
    writeDriftingConfig();

    const { exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    const text = piConfigText();
    // "no comments" is asserted by parsing strictly: comments and trailing
    // commas are the JSONC extras pi tolerates, and standard `JSON.parse` is
    // what rejects them — so a parse that succeeds here is the proof.
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).toBe(JSON.stringify({ providers: COMPILED_CATALOG }, null, 2) + "\n");
    // The indentation is asserted through the re-serialization rather than a
    // character: two spaces at every depth, including nested objects.
    expect(text.split("\n")[1]).toBe('  "providers": {');
  });

  test("writes pi's config with permissions 0600", () => {
    writeScore(VALID_SCORE);
    writeDriftingConfig();

    const { exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    expect(statSync(piConfigPath()).mode & 0o777).toBe(0o600);
  });

  test("writes through a symlink rather than replacing it", () => {
    writeScore(VALID_SCORE);
    const real = join(root, "real-models.json");
    writeFileSync(real, JSON.stringify({ providers: { stale: { models: [] } } }, null, 2));
    symlinkSync(real, piConfigPath());

    const { exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    expect(lstatSync(piConfigPath()).isSymbolicLink()).toBe(true);
    expect(JSON.stringify(piCatalog())).toBe(JSON.stringify(COMPILED_CATALOG));
  });

  test("reports Unchanged on a second sync, so a converged pi config is not rewritten", () => {
    writeScore(VALID_SCORE);
    writeDriftingConfig();
    runUnis(["sync", "--yes"]);

    const bytes = piConfigText();
    const mtime = statSync(piConfigPath()).mtimeMs;
    const { stdout, exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Unchanged");
    // Neither the bytes nor the mtime may move: a converged sync is a no-op,
    // and a rewrite here would mean the file never compares equal to itself.
    expect(piConfigText()).toBe(bytes);
    expect(statSync(piConfigPath()).mtimeMs).toBe(mtime);
  });

  test("converges when a value needs the pi escape, not only when it does not", () => {
    // The escape is applied on write, so the file holds the escaped form and
    // the second sync must still report Unchanged. Comparing the compiled
    // Catalog unescaped would report the escape itself as drift every sync.
    writeScore(`version: "1"
providers:
  p:
    name: "P"
    baseUrl: "https://x/v1"
    apiKey: "sk-a$b"
    apiType: "openai-completions"
    models:
      - id: "m"
        name: "M"
        contextWindow: 10
`);
    writeFileSync(piConfigPath(), "{}");

    const first = runUnis(["sync", "--yes"]);
    expect(first.exitCode).toBe(0);

    const bytes = piConfigText();
    const mtime = statSync(piConfigPath()).mtimeMs;
    const second = runUnis(["sync", "--yes"]);

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Unchanged");
    expect(piConfigText()).toBe(bytes);
    expect(statSync(piConfigPath()).mtimeMs).toBe(mtime);
  });

  test("converges when a value begins with ! as well", () => {
    // The leading-`!` prefix is the other half of the escape, and it is the
    // half whose write form starts with `$` — where a naive comparison would
    // see a difference on every sync.
    writeScore(`version: "1"
providers:
  p:
    name: "P"
    baseUrl: "https://x/v1"
    apiKey: "!sk-key"
    apiType: "openai-completions"
    models:
      - id: "m"
        name: "M"
        contextWindow: 10
`);
    writeFileSync(piConfigPath(), "{}");

    expect(runUnis(["sync", "--yes"]).exitCode).toBe(0);
    const bytes = piConfigText();
    const mtime = statSync(piConfigPath()).mtimeMs;

    const second = runUnis(["sync", "--yes"]);
    expect(second.stdout).toContain("Unchanged");
    expect(piConfigText()).toBe(bytes);
    expect(statSync(piConfigPath()).mtimeMs).toBe(mtime);
  });

  test("still reports drift on a genuine difference after an escaped write", () => {
    // Convergence must not be bought by making the comparison blind: a real
    // change to the Score still has to show up as drift for pi.
    writeScore(`version: "1"
providers:
  p:
    name: "P"
    baseUrl: "https://x/v1"
    apiKey: "sk-a$b"
    apiType: "openai-completions"
    models:
      - id: "m"
        name: "M"
        contextWindow: 10
`);
    writeFileSync(piConfigPath(), "{}");
    expect(runUnis(["sync", "--yes"]).exitCode).toBe(0);

    writeFileSync(scorePath, readFileSync(scorePath, "utf8").replace('contextWindow: 10', "contextWindow: 99"));
    const { stdout } = runUnis(["sync"]);

    expect(stdout).toContain("drifts");
  });

  test("reports both agents in one run, not only the one written last", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(ompDir, "models.yml"), ["providers:", "  stale:", "    models: []"].join("\n"));
    writeDriftingConfig();

    const { stdout, exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("[PI]");
    expect(stdout).toContain("[OMP]");
    expect(stdout).toContain("Synced (1 providers, 1 models)");
  });

  test("refuses an unconfirmed first takeover for pi, exit 2", () => {
    writeScore(VALID_SCORE);
    // omp is aligned, so the refusal names pi's Catalog as the one that would
    // lose Providers — the gate is per-Agent, and this is the way to show it.
    writeFileSync(join(ompDir, "models.yml"), Bun.YAML.stringify({ providers: COMPILED_CATALOG }, null, 2));
    writeDriftingConfig();

    const { stdout, stderr, exitCode } = runUnis(["sync"]);

    expect(exitCode).toBe(2);
    expect(stdout + stderr).toContain("stale");
  });

  test("leaves a gated pi config untouched", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(ompDir, "models.yml"), ["providers:", "  synced:", "    models: []"].join("\n"));
    const drifting = JSON.stringify({ providers: { stale: { models: [] } } }, null, 2);
    writeFileSync(piConfigPath(), drifting);

    const { exitCode } = runUnis(["sync"]);

    expect(exitCode).toBe(2);
    expect(piConfigText()).toBe(drifting);
  });

  test("takes a snapshot of pi's config before writing it", () => {
    writeScore(VALID_SCORE);
    writeDriftingConfig();

    const { stdout, exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Snapshot");
    const backups = join(root, "config", "unisono", "backups");
    const stamps = readdirSync(backups);
    expect(stamps).toHaveLength(1);
    const manifest = readKey(Bun.JSONC.parse(readFileSync(join(backups, stamps[0]!, "manifest.json"), "utf8")), "entries");
    expect(Object.keys(manifest as Record<string, unknown>)).toContain("pi");
  });
});

describe("unis sync — pi value escaping", () => {
  /** A Score whose single apiKey is the raw value under test. */
  function scoreWithKey(value: string): string {
    // The key must stay one YAML scalar so the comparison across the escape
    // matrix is about pi's escaping alone. Double quotes make any literal
    // safe in YAML, and the backslash escape keeps a contained `"` legal.
    return `version: "1"
providers:
  p:
    name: "P"
    baseUrl: "https://x/v1"
    apiKey: ${JSON.stringify(value)}
    apiType: "openai-completions"
    models:
      - id: "m"
        name: "M"
        contextWindow: 10
`;
  }

  /**
   * Syncs a Score holding `value` as pi's apiKey and returns what pi's config
   * holds for it afterwards, as pi's own resolver would see it.
   */
  function syncedKey(value: string): string {
    writeScore(scoreWithKey(value));
    // A fresh, parseable pi config with no Catalog key, so the only thing the
    // sync writes is the compiled one.
    writeFileSync(piConfigPath(), "{}");
    const { exitCode } = runUnis(["sync", "--yes"]);
    expect(exitCode).toBe(0);
    const provider = readKey(piCatalog(), "p");
    return String(readKey(provider, "apiKey"));
  }

  /** pi's reading of what the sync wrote, so the escape can be shown round. */
  function piResolves(written: string): string {
    return String(resolve(written));
  }

  test("a value beginning with ! is written so pi does not execute it", () => {
    const written = syncedKey("!echo pwned");
    expect(written).toBe("$!echo pwned");
    expect(piResolves(written)).toBe("!echo pwned");
  });

  test("a value containing $ mid-string escapes every $", () => {
    const written = syncedKey("a$b");
    expect(written).toBe("a$$b");
    expect(piResolves(written)).toBe("a$b");
  });

  test("a value containing both is escaped for both", () => {
    const written = syncedKey("a!b$c");
    expect(written).toBe("a!b$$c");
    expect(piResolves(written)).toBe("a!b$c");
  });

  test("a value containing neither passes through untouched", () => {
    expect(syncedKey("sk-abc-123")).toBe("sk-abc-123");
  });

  test("an escaped value reads back from pi's config as the original", () => {
    // The escape exists so the value survives: pi's own reading of what it was
    // written is the round trip that matters, asserted across the matrix.
    for (const value of ["!echo pwned", "a$b", "a!b$c", "plain"]) {
      expect(piResolves(syncedKey(value))).toBe(value);
    }
  });

  test("a value beginning with ! escapes only the leading !", () => {
    const written = syncedKey("!only-leading");
    expect(written).toBe("$!only-leading");
    expect(written.split("$!").length - 1).toBe(1);
  });

  test("escaping leaves a value's identity alone when it holds no $", () => {
    // A `!` that is not the value's first character is not a command and needs
    // no prefix, so the value is written as it is; a `$` anywhere still
    // doubles, because that is what stops an environment expansion.
    expect(syncedKey("a!b")).toBe("a!b");
    expect(piResolves(syncedKey("a!b"))).toBe("a!b");
  });

  test("a lone $ in the value is the one case both rules must get right", () => {
    // The order is the whole rule: doubling first, then prefixing, is what
    // makes `$!` a single escape rather than two stacked ones.
    const written = syncedKey("!a$b");
    expect(written).toBe("$!a$$b");
    expect(piResolves(written)).toBe("!a$b");
  });

  test("escapes a nested headers value, not only a top-level one", () => {
    // A header is a nested map, so the recursion has to reach it: a `$` in a
    // header is exactly as expanding as one in an apiKey.
    writeScore(`version: "1"
providers:
  p:
    name: "P"
    baseUrl: "https://x/v1"
    apiKey: "sk-k"
    apiType: "openai-completions"
    headers:
      X-Token: "a$b"
    models:
      - id: "m"
        name: "M"
        contextWindow: 10
`);
    writeFileSync(piConfigPath(), "{}");

    const { exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    const provider = readKey(piCatalog(), "p");
    const headers = readKey(provider, "headers");
    expect(readKey(headers, "X-Token")).toBe("a$$b");
  });

  test("does not escape a provider id or a field name", () => {
    // pi resolves values, not keys: escaping an id would change which provider
    // is being named, which is a different and worse bug than an unescaped `$`.
    writeScore(`version: "1"
providers:
  "!dollar$id":
    name: "P"
    baseUrl: "https://x/v1"
    apiKey: "sk-k"
    apiType: "openai-completions"
    models:
      - id: "m"
        name: "M"
        contextWindow: 10
`);
    writeFileSync(piConfigPath(), "{}");

    const { exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    const catalog = piCatalog();
    expect(Object.keys(catalog as Record<string, unknown>)).toContain("!dollar$id");
  });
});

describe("unis sync — pi dangling references", () => {
  /** The sibling settings file, written beside pi's config. */
  function writeSettings(node: Record<string, unknown>): void {
    writeFileSync(join(piDir, "settings.json"), JSON.stringify(node, null, 2));
  }

  test("warns when settings.json references a provider this sync removes", () => {
    writeScore(VALID_SCORE);
    writeFileSync(piConfigPath(), JSON.stringify({ providers: { stale: { models: [] } } }, null, 2));
    writeSettings({ defaultProvider: "stale", defaultModel: "stale/m1" });

    const { stdout, stderr, exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    const all = stdout + stderr;
    expect(all).toContain("stale");
    expect(all.toLowerCase()).toContain("default");
  });

  test("never rewrites settings.json", () => {
    writeScore(VALID_SCORE);
    writeFileSync(piConfigPath(), JSON.stringify({ providers: { stale: { models: [] } } }, null, 2));
    const settings = { defaultProvider: "stale", defaultModel: "stale/m1" };
    const before = JSON.stringify(settings, null, 2);
    writeSettings(settings);

    runUnis(["sync", "--yes"]);

    expect(readFileSync(join(piDir, "settings.json"), "utf8")).toBe(before);
  });

  test("warns only, so a run whose sole problem is a warning exits 0", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(ompDir, "models.yml"), Bun.YAML.stringify({ providers: COMPILED_CATALOG }, null, 2));
    writeFileSync(piConfigPath(), JSON.stringify({ providers: { stale: { models: [] } } }, null, 2));
    writeSettings({ defaultModel: "stale/m1" });

    const file = join(piDir, "settings.json");
    const before = readFileSync(file, "utf8");
    const { exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("does not warn when the referenced provider survives the sync", () => {
    writeScore(VALID_SCORE);
    writeFileSync(
      piConfigPath(),
      JSON.stringify({ providers: { ...COMPILED_CATALOG } }, null, 2) + "\n",
    );
    writeSettings({ defaultProvider: "deepseek", defaultModel: "deepseek/deepseek-reasoner" });

    const { stdout, stderr } = runUnis(["sync"]);

    expect(stdout + stderr).not.toContain("stale");
  });
});

describe("unis validate — dangling references are visible before a sync", () => {
  test("warns during validate about a dangling default", () => {
    writeScore(VALID_SCORE);
    writeFileSync(piConfigPath(), JSON.stringify({ providers: { stale: { models: [] } } }, null, 2));
    writeFileSync(join(piDir, "settings.json"), JSON.stringify({ defaultProvider: "stale" }, null, 2));

    const { stdout, stderr, exitCode } = runUnis(["validate"]);

    expect(exitCode).toBe(0);
    expect(stdout + stderr).toContain("stale");
  });

  test("reads omp's modelRoles map and enabledModels list, and warns per entry", () => {
    writeScore(VALID_SCORE);
    // Both shapes omp writes: a map keyed by `<provider>/<model>`, and a list
    // of references. The surviving reference must stay silent, so a false
    // positive on it is visible as an extra warning.
    writeFileSync(
      join(ompDir, "config.yml"),
      [
        "modelRoles:",
        "  gone-old/m1: creative",
        "enabledModels:",
        "  - gone-two/m2",
        "  - deepseek/deepseek-reasoner",
      ].join("\n"),
    );

    const { stdout, stderr, exitCode } = runUnis(["validate"]);

    expect(exitCode).toBe(0);
    const all = stdout + stderr;
    expect(all).toContain("modelRoles references removed provider 'gone-old'");
    expect(all).toContain("enabledModels references removed provider 'gone-two'");
    expect(all).not.toContain("'deepseek'");
  });

  test("never rewrites omp's config.yml", () => {
    writeScore(VALID_SCORE);
    const before = ["modelRoles:", "  gone-old/m1: creative", "enabledModels:", "  - gone-two/m2"].join("\n");
    writeFileSync(join(ompDir, "config.yml"), before);

    runUnis(["validate"]);

    expect(readFileSync(join(ompDir, "config.yml"), "utf8")).toBe(before);
  });
});
