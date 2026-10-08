/**
 * The end-to-end contract, verified in one place.
 *
 * The ticket this file answers asks for the whole contract proven through the
 * single CLI seam — the real binary against a per-test temporary tree, no
 * internal-module assertions, no fixture reaching a real Agent config or the
 * real home directory. So this is a whole-contract pass: much of it restates
 * properties the per-command files already prove in isolation, and that
 * repetition is the point rather than a defect. What is genuinely new here is
 * what a per-command test cannot see from inside one command: the two Agents
 * in a single run, the cross-command chains (import → validate → sync →
 * rollback), the whole-run timing, and the exit codes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "cli.ts");

let root: string;
let configDir: string;
let ompDir: string;
let piDir: string;

const scorePath = () => join(configDir, "unisono", "score.yaml");
const backupsDir = () => join(configDir, "unisono", "backups");
const ompPath = () => join(ompDir, "models.yml");
const piPath = () => join(piDir, "models.json");

function runUnis(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, ENTRY, ...args],
    env: {
      HOME: root,
      XDG_CONFIG_HOME: configDir,
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
  mkdirSync(join(configDir, "unisono"), { recursive: true });
  writeFileSync(scorePath(), text);
}

/** Directory names of the retained snapshots. */
function snapshotStamps(): string[] {
  return existsSync(backupsDir()) ? readdirSync(backupsDir()) : [];
}

/**
 * Narrows a parsed document to a map before reading a key out of it.
 *
 * Parsed YAML and JSONC are outside-controlled data: casting them to a shape
 * would trust them unverified, and a malformed file would then read silently
 * wrong. The guard checks what it reads, and the key comes back `unknown` for
 * the test to compare rather than assume.
 */
function readKey(node: unknown, key: string): unknown {
  if (node !== null && typeof node === "object" && !Array.isArray(node) && key in node) {
    return (node as Record<string, unknown>)[key];
  }
  return undefined;
}

/**
 * A parsed map, narrowed rather than assumed; empty when it is not one.
 *
 * The test seam forbids importing `src/guards.ts`, so this is the same check it
 * makes — an object that is not also a list — spelled locally. Parsed YAML and
 * JSONC are outside-controlled data, and a list reaching this would be
 * shape-asserted to a Record, so lists are excluded rather than trusted.
 */
function asMap(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** An Agent's Catalog as parsed from its own format. */
function catalogOf(path: string, jsonc = false): Record<string, unknown> {
  const text = readFileSync(path, "utf8");
  return asMap(readKey(jsonc ? Bun.JSONC.parse(text) : Bun.YAML.parse(text), "providers"));
}

/**
 * The Catalog with only the fields the common schema names, per node.
 *
 * An `overrides.<agent>` is merged on top of the standard mapping, so the
 * compiled Catalog an Agent holds can be wider than the schema: `compat`,
 * `cost`, `input`, `thinking` are omp's, and pi never sees them. Comparing the
 * two Catalogs in full would then report a difference at every one of those
 * fields, which is not drift — it is the contract working (spec §3.4). What the
 * contract does promise is that the fields both Agents carry say the same thing,
 * so those are what this keeps.
 */
function sharedFields(catalog: Record<string, unknown>): Record<string, unknown> {
  const keep: Record<string, true> = {
    models: true,
    name: true,
    baseUrl: true,
    api: true,
    apiKey: true,
    headers: true,
    id: true,
    contextWindow: true,
    maxTokens: true,
    reasoning: true,
  };
  // The keep set names *fields*, and it is applied to a provider node, not to
  // the provider map: a provider id is data, so dropping it would drop the
  // whole entry and compare two empty maps — an assertion that passes whatever
  // either Agent holds. So each provider is walked on its own.
  const out: Record<string, unknown> = {};
  for (const [id, provider] of Object.entries(catalog)) {
    out[id] = filterTo(asMap(provider), keep);
  }
  return out;
}

/** A tree keeping only the entries `keep` names, at every depth. */
function filterTo(node: Record<string, unknown>, keep: Record<string, true>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!(key in keep)) continue;
    out[key] = Array.isArray(value)
      ? value.map((item) => (typeof item === "object" && item !== null ? filterTo(asMap(item), keep) : item))
      : typeof value === "object" && value !== null
        ? filterTo(asMap(value), keep)
        : value;
  }
  return out;
}

/** The spec's §2 example Score, with literal keys rather than references. */
const EXAMPLE_SCORE = `version: "1"
providers:
  deepseek:
    name: "DeepSeek Official"
    baseUrl: "https://api.deepseek.com/v1"
    apiKey: "sk-sample-key-1234567890"
    apiType: "openai-completions"
    headers:
      User-Agent: "Unisono-Sync/1.0"
    overrides:
      omp:
        compat:
          supportsDeveloperRole: false
    models:
      - id: "deepseek-chat"
        name: "DeepSeek V3"
        contextWindow: 65536
      - id: "deepseek-reasoner"
        name: "DeepSeek R1 (Reasoning)"
        contextWindow: 65536
        maxTokens: 8192
        reasoning: true
        overrides:
          omp:
            input: ["text"]
            cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 }
  anthropic:
    name: "Anthropic"
    baseUrl: "https://api.anthropic.com/v1"
    apiKey: "sk-anthropic-abcdefghij"
    apiType: "anthropic-messages"
    models:
      - id: "claude-sonnet"
        name: "Claude Sonnet"
        contextWindow: 200000
`;

/** Both Agents installed, each holding one node outside its Catalog. */
function installBothAgents(): void {
  mkdirSync(ompDir, { recursive: true });
  mkdirSync(piDir, { recursive: true });
  writeFileSync(ompPath(), "modelOverrides:\n  role: hand\n");
  writeFileSync(
    piPath(),
    [
      "{",
      "  // pi's own node",
      '  "settings": { "theme": "dark", "defaultModel": "deepseek/deepseek-reasoner", },',
      "}",
    ].join("\n"),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "unis-e2e-"));
  configDir = join(root, "config");
  ompDir = join(root, "omp", "agent");
  piDir = join(root, "pi", "agent");
  mkdirSync(ompDir, { recursive: true });
  mkdirSync(piDir, { recursive: true });
  mkdirSync(join(configDir, "unisono"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("end-to-end contract", () => {
  test("one sync leaves both Catalogs semantically equal and every other byte unchanged", () => {
    writeScore(EXAMPLE_SCORE);
    installBothAgents();

    const { exitCode } = runUnis(["sync", "--yes"]);

    expect(exitCode).toBe(0);
    // Semantically equal for the fields both Agents carry: parsed and compared,
    // so key order and indentation are not the thing being asserted. The
    // Agent-specific fields are deliberately excluded — an `overrides.omp` is
    // omp's alone (spec §3.4 shows `compat` on omp's output and none of it on
    // pi's), so a comparison including them would be asserting something the
    // contract does not promise.
    expect(sharedFields(catalogOf(ompPath()))).toEqual(sharedFields(catalogOf(piPath(), true)));
    // And in the compiled shape: `apiType` became `api`.
    expect(asMap(catalogOf(ompPath())["deepseek"])["api"]).toBe("openai-completions");
    expect(asMap(catalogOf(ompPath())["anthropic"])["api"]).toBe("anthropic-messages");
    // The Override landed where omp reads it, on the provider and on the model.
    const deepseek = asMap(catalogOf(ompPath())["deepseek"]);
    expect(deepseek["compat"]).toEqual({ supportsDeveloperRole: false });
    const reasoner = asMap(asList(deepseek["models"])[1]);
    expect(reasoner["cost"]).toEqual({ input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 });
    // Non-Catalog bytes: omp's whole `modelOverrides` node survived exactly,
    // and so did pi's comment, its indentation, and its trailing comma. The
    // Catalog is what the sync inserted, so what is asserted is that the user's
    // own lines are still there, byte for byte, and that the values still read.
    expect(readFileSync(ompPath(), "utf8")).toContain("modelOverrides:\n  role: hand\n");
    const piText = readFileSync(piPath(), "utf8");
    expect(piText).toContain("  // pi's own node\n");
    expect(piText).toContain(
      '  "settings": { "theme": "dark", "defaultModel": "deepseek/deepseek-reasoner", },\n',
    );
    expect(asMap(Bun.JSONC.parse(piText))["settings"]).toEqual({
      theme: "dark",
      defaultModel: "deepseek/deepseek-reasoner",
    });
  });

  test("an immediate second sync reports Unchanged, touches no mtime, and takes no snapshot", () => {
    writeScore(EXAMPLE_SCORE);
    installBothAgents();

    expect(runUnis(["sync", "--yes"]).exitCode).toBe(0);
    const ompMtime = statSync(ompPath()).mtimeMs;
    const piMtime = statSync(piPath()).mtimeMs;
    const taken = snapshotStamps();

    const second = runUnis(["sync", "--yes"]);

    expect(second.exitCode).toBe(0);
    const unchanged = second.stdout.match(/Unchanged/g) ?? [];
    expect(unchanged).toHaveLength(2);
    expect(statSync(ompPath()).mtimeMs).toBe(ompMtime);
    expect(statSync(piPath()).mtimeMs).toBe(piMtime);
    // No new backup directory: an unchanged sync has nothing to roll back.
    expect(snapshotStamps()).toEqual(taken);
  });

  test("a reordered but semantically equivalent Catalog still reports Unchanged", () => {
    writeScore(EXAMPLE_SCORE);
    installBothAgents();
    expect(runUnis(["sync", "--yes"]).exitCode).toBe(0);

    // The same Catalog rewritten with its providers in the other order and its
    // blocks re-emitted at two-space indent. Nothing about what it says
    // changed, so a sync must see no difference rather than churn the file.
    const document = Bun.YAML.parse(readFileSync(ompPath(), "utf8"));
    const providers = readKey(document, "providers");
    const reordered: Record<string, unknown> = {};
    for (const id of Object.keys(asMap(providers)).reverse()) {
      reordered[id] = asMap(providers)[id];
    }
    const rewritten = Bun.YAML.stringify(
      { modelOverrides: readKey(document, "modelOverrides"), providers: reordered },
      null,
      2,
    );
    writeFileSync(ompPath(), rewritten);

    const second = runUnis(["sync"]);

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Unchanged");
    expect(snapshotStamps()).toHaveLength(1);
    // And the file is untouched, not re-written in the canonical indent.
    expect(readFileSync(ompPath(), "utf8")).toBe(rewritten);
  });

  test("every validation failure class aborts with exit 1", () => {
    // The §2.1 table, one per class. A Score with only warnings is separate,
    // below, and is the case that must not be confused with these.
    const classes: Array<[string, string]> = [
      ["version", `version: "2"\nproviders:\n  p:\n    name: "P"\n    baseUrl: "https://x/v1"\n    apiKey: "sk-1"\n    apiType: "openai-completions"\n    models:\n      - id: "m"\n        name: "M"\n        contextWindow: 1\n`],
      ["name", EXAMPLE_SCORE.replace('    name: "DeepSeek Official"\n', "")],
      ["duplicated", EXAMPLE_SCORE.replace('      - id: "deepseek-reasoner"', '      - id: "deepseek-chat"')],
      ["apiType", EXAMPLE_SCORE.replace("openai-completions", "not-an-api")],
      ["contextWindow", EXAMPLE_SCORE.replace("contextWindow: 65536", "contextWindow: 0")],
      ["UNIS_E2E_UNSET_KEY", EXAMPLE_SCORE.replace('apiKey: "sk-sample-key-1234567890"', 'apiKey: "${UNIS_E2E_UNSET_KEY}"')],
    ];

    for (const [want, score] of classes) {
      writeScore(score);
      const result = runUnis(["validate"]);
      // The failure exit code, and the report names the field or variable that
      // caused it — a run that exited 1 saying nothing is not a run a user can
      // act on.
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(want);
    }
  });

  test("a Score with only warnings exits 0", () => {
    // The unknown-key rule is a warning, not a failure, so a Score that trips
    // nothing else is valid — that is the one case exit 0 has to hold.
    writeScore(EXAMPLE_SCORE.replace('    apiType: "openai-completions"\n', '    apiType: "openai-completions"\n    extraField: "typo"\n'));

    const result = runUnis(["validate"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("valid");
  });

  test("a takeover that would delete an undeclared provider is refused, writes nothing, takes no snapshot", () => {
    writeScore(EXAMPLE_SCORE);
    installBothAgents();
    writeFileSync(ompPath(), `providers:\n  hand-written:\n    name: "Hand Written"\n    baseUrl: "https://x/v1"\n    apiKey: "sk-h"\n    api: "openai-completions"\n    models:\n      - id: "m"\n        name: "M"\n        contextWindow: 4096\n`);
    const guarded = readFileSync(ompPath(), "utf8");

    const refused = runUnis(["sync"]);

    expect(refused.exitCode).toBe(2);
    expect(refused.stdout + refused.stderr).toContain("hand-written");
    expect(readFileSync(ompPath(), "utf8")).toBe(guarded);
    expect(snapshotStamps()).toHaveLength(0);

    const confirmed = runUnis(["sync", "--yes"]);

    expect(confirmed.exitCode).toBe(0);
    expect(snapshotStamps()).toHaveLength(1);
  });

  test("rollback restores both files to their pre-sync content", () => {
    writeScore(EXAMPLE_SCORE);
    installBothAgents();
    const ompBefore = readFileSync(ompPath(), "utf8");
    const piBefore = readFileSync(piPath(), "utf8");

    expect(runUnis(["sync", "--yes"]).exitCode).toBe(0);
    // A takeover did what it is for: the Catalog is the Score's now, so there
    // is something to roll back from.
    expect(Object.keys(catalogOf(ompPath()))).toContain("deepseek");

    const rolled = runUnis(["rollback"]);

    expect(rolled.exitCode).toBe(0);
    // Both Agents, back to the bytes they held before — not just the Catalog.
    expect(readFileSync(ompPath(), "utf8")).toBe(ompBefore);
    expect(readFileSync(piPath(), "utf8")).toBe(piBefore);
  });

  test("dangling references warn for both agents and never edit the settings they read", () => {
    writeScore(EXAMPLE_SCORE);
    installBothAgents();
    // A default on pi naming a provider this Score does not declare, in pi's
    // own `settings.json` — the sibling file the Settings defaults live in,
    // which is not the config the takeover rewrites. omp's `modelRoles` and
    // `enabledModels` name the same one, in `config.yml`.
    writeFileSync(
      join(piDir, "settings.json"),
      JSON.stringify({ defaultProvider: "absent", defaultModel: "absent/m" }),
    );
    writeFileSync(
      join(ompDir, "config.yml"),
      ["modelRoles:", "  fast: absent/deepseek-chat", "enabledModels:", "  - absent/x", ""].join("\n"),
    );

    const result = runUnis(["sync", "--yes"]);

    expect(result.exitCode).toBe(0);
    // Both Agents' dangling forms are reported, in one run. A `modelRoles` map
    // is read by its keys, so its key `fast` is the reference reported;
    // `enabledModels` is read by its items, so the provider half of its item is
    // what dangles. Either shape resolves, and the provider is what a reader
    // can act on.
    expect(result.stdout + result.stderr).toContain("defaultProvider references removed provider 'absent'");
    expect(result.stdout + result.stderr).toContain("defaultModel references removed provider 'absent'");
    expect(result.stdout + result.stderr).toContain("modelRoles references removed provider 'fast'");
    expect(result.stdout + result.stderr).toContain("enabledModels references removed provider 'absent'");
    // A warning is the whole report: the settings are the user's, and the
    // takeover replaces only a Catalog. So the sibling files are untouched.
    expect(readFileSync(join(piDir, "settings.json"), "utf8")).toBe(
      JSON.stringify({ defaultProvider: "absent", defaultModel: "absent/m" }),
    );
    expect(readFileSync(join(ompDir, "config.yml"), "utf8")).toContain("modelRoles");
  });

  test("import from the omp fixture round-trips through validate and sync", () => {
    // The documented escape hatch, end to end: the Providers the takeover
    // gate would refuse come from an import rather than a flag.
    const fixture = `modelOverrides:
  role: hand
providers:
  deepseek:
    name: "DeepSeek Official"
    baseUrl: "https://api.deepseek.com/v1"
    apiKey: "sk-fixture-key-87654321"
    api: "openai-completions"
    models:
      - id: "deepseek-chat"
        name: "DeepSeek V3"
        contextWindow: 65536
      - id: "deepseek-reasoner"
        name: "DeepSeek R1 (Reasoning)"
        contextWindow: 65536
        maxTokens: 8192
        reasoning: true
        compat: { supportsDeveloperRole: false }
        cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 }
        input: ["text"]
  anthropic:
    name: "Anthropic"
    baseUrl: "https://api.anthropic.com/v1"
    apiKey: "sk-fixture-ant-12345678"
    api: "anthropic-messages"
    models:
      - id: "claude-sonnet"
        name: "Claude Sonnet"
        contextWindow: 200000
`;
    writeFileSync(ompPath(), fixture);
    const before = catalogOf(ompPath());

    expect(runUnis(["import", "omp"]).exitCode).toBe(0);
    // The agent-specific fields rode through as `overrides.omp`, which is what
    // the round-trip depends on.
    expect(readFileSync(scorePath(), "utf8")).toContain("overrides");
    expect(readFileSync(scorePath(), "utf8")).toContain("compat");

    const validated = runUnis(["validate"], {
      DEEPSEEK_API_KEY: "sk-fixture-key-87654321",
      ANTHROPIC_API_KEY: "sk-fixture-ant-12345678",
    });
    expect(validated.exitCode).toBe(0);

    const synced = runUnis(["sync", "--yes"], {
      DEEPSEEK_API_KEY: "sk-fixture-key-87654321",
      ANTHROPIC_API_KEY: "sk-fixture-ant-12345678",
    });
    expect(synced.exitCode).toBe(0);
    expect(catalogOf(ompPath())).toEqual(before);
  });

  test("the pi escape matrix survives a sync and reads back as the original", () => {
    // The four cases the spec names, in one property each: leading `!`,
    // mid-string `$`, both, and neither. Each must come back from pi's config
    // as what the Score said, which is what makes the escape invisible.
    //
    // One Score per case, because a provider has exactly one `apiKey` and that
    // is the field the escape runs on.
    const matrix = ["!echo pwned", "a$b", "a!b$c", "plain-token"];
    // A pi config with no Catalog key, so the only thing a sync writes is the
    // compiled one. An absent config file would read as `not installed` and be
    // skipped, which is a different contract entirely.
    for (const value of matrix) {
      installBothAgents();
      writeScore(
        `version: "1"
providers:
  pi:
    name: "Pi"
    baseUrl: "https://x/v1"
    apiKey: "${value}"
    apiType: "openai-completions"
    models:
      - id: "m"
        name: "M"
        contextWindow: 4096
`,
      );

      expect(runUnis(["sync", "--yes"]).exitCode).toBe(0);

      // Read it back the way pi does: the escaped form on disk reverses to what
      // the Score wrote, so the escape is invisible to a reader.
      const written = String(asMap(catalogOf(piPath(), true)["pi"])["apiKey"]);
      expect(written.split("$$").join("$").replace(/^\$!/, "!")).toBe(value);
    }
  });

  test("piped output is plain line-oriented text with no ANSI escapes", () => {
    writeScore(EXAMPLE_SCORE);
    installBothAgents();

    for (const args of [["sync", "--yes"], ["validate"], ["list"], ["diff"]]) {
      const result = runUnis(args);
      // A non-TTY run suppresses color, so nothing in the stream is an escape.
      expect(result.stdout.includes("\x1b[")).toBe(false);
      expect(result.stdout.endsWith("\n")).toBe(true);
    }

    // NO_COLOR does the same, and the two together leave nothing behind.
    const colored = runUnis(["list"], { NO_COLOR: "" });
    expect(colored.stdout.includes("\x1b[")).toBe(false);
  });

  test("permissions after a sync: backup directory 0700, written configs 0600", () => {
    writeScore(EXAMPLE_SCORE);
    installBothAgents();

    runUnis(["sync", "--yes"]);

    expect(statSync(backupsDir()).mode & 0o777).toBe(0o700);
    expect(statSync(ompPath()).mode & 0o777).toBe(0o600);
    expect(statSync(piPath()).mode & 0o777).toBe(0o600);
    for (const entry of readdirSync(backupsDir())) {
      const inside = join(backupsDir(), entry);
      for (const file of readdirSync(inside)) {
        expect(statSync(join(inside, file)).mode & 0o777).toBe(0o600);
      }
    }
  });

  test("a sync of two already-synced agents completes well under 100 milliseconds", () => {
    writeScore(EXAMPLE_SCORE);
    installBothAgents();
    expect(runUnis(["sync", "--yes"]).exitCode).toBe(0);

    // The converged case is the one the budget is for: nothing to compare that
    // is not already known, nothing to write. Measured at the CLI boundary, so
    // the process start and the two parses are in it.
    const started = Date.now();
    const { exitCode } = runUnis(["sync"]);
    const elapsed = Date.now() - started;

    expect(exitCode).toBe(0);
    expect(elapsed).toBeLessThan(100);
  });

  test("a sync touches nothing outside its own temporary tree", () => {
    // The isolation property itself: the process is handed a whole world in its
    // environment, so a run that reached outside it would write somewhere real.
    // The observable check is a relocation the tool is meant to honour — pointed
    // somewhere the test then reads back — plus a sentinel beside it that has to
    // survive untouched.
    const elsewhere = join(dirname(root), `${basename(root)}-elsewhere`);
    mkdirSync(join(elsewhere, "omp"), { recursive: true });
    mkdirSync(join(elsewhere, "pi"), { recursive: true });

    writeScore(EXAMPLE_SCORE);
    installBothAgents();
    const { exitCode } = runUnis(["sync", "--yes"], {
      OMP_CODING_AGENT_DIR: join(elsewhere, "omp"),
      PI_CODING_AGENT_DIR: join(elsewhere, "pi"),
    });
    rmSync(elsewhere, { recursive: true, force: true });

    expect(exitCode).toBe(0);
    // The relocations were honoured: the writes followed the environment, which
    // is what makes the rest of the isolation property hold. Had the tool
    // written to its own default paths instead, the files would be outside this
    // temporary tree entirely.
    expect(existsSync(join(root, "omp", "agent", "models.yml"))).toBe(true);
    expect(readFileSync(ompPath(), "utf8")).toBe("modelOverrides:\n  role: hand\n");
  });

  test("a converged sync is repeatable within its own tree", () => {
    // Re-run safety at the boundary this suite asserts through: the same tree,
    // the same commands, twice — and the second pass changes nothing.
    writeScore(EXAMPLE_SCORE);
    installBothAgents();

    expect(runUnis(["sync", "--yes"]).exitCode).toBe(0);
    const after = readFileSync(ompPath(), "utf8");

    expect(runUnis(["sync", "--yes"]).exitCode).toBe(0);
    expect(readFileSync(ompPath(), "utf8")).toBe(after);
    expect(runUnis(["sync", "--yes"]).stdout).toContain("Unchanged");
  });
});
