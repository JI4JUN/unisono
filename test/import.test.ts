/**
 * `unis import` — asserted through the CLI subprocess seam the spec mandates:
 * the real binary against a per-test temporary tree, with the written Score,
 * its validation, and the files it leaves behind as the observable surface.
 *
 * The import is the reverse of the compile, so its proof is a round-trip: take
 * an Agent's Catalog, import it, sync it back, and compare. The comparison is
 * semantic, which is what lets the import change the serialization without
 * changing what the two sides say.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "cli.ts");

let root: string;
let configDir: string;
let ompDir: string;
let piDir: string;

const scorePath = () => join(configDir, "unisono", "score.yaml");
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

/**
 * An omp fixture: two providers, three models, and the agent-specific fields
 * the common schema cannot express.
 */
const OMP_FIXTURE = `modelOverrides:
  role: hand
providers:
  deepseek:
    name: "DeepSeek Official"
    baseUrl: "https://api.deepseek.com/v1"
    apiKey: "sk-omp-key-87654321"
    api: "openai-completions"
    headers:
      User-Agent: "Unisono-Sync/1.0"
    models:
      - id: "deepseek-chat"
        name: "DeepSeek V3"
        contextWindow: 65536
      - id: "deepseek-reasoner"
        name: "DeepSeek R1 (Reasoning)"
        contextWindow: 65536
        maxTokens: 8192
        reasoning: true
        compat:
          supportsDeveloperRole: false
        cost:
          input: 0.55
          output: 2.19
          cacheRead: 0.14
          cacheWrite: 0
        input: ["text"]
        thinking:
          mode: "effort"
          efforts: ["low", "medium", "high"]
  anthropic:
    name: "Anthropic"
    baseUrl: "https://api.anthropic.com/v1"
    apiKey: "sk-omp-ant-12345678"
    api: "anthropic-messages"
    models:
      - id: "claude-sonnet"
        name: "Claude Sonnet"
        contextWindow: 200000
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "unis-import-"));
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

function asMap(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The parsed imported Score. */
function scoreDocument(): Record<string, unknown> {
  return asMap(Bun.YAML.parse(readFileSync(scorePath(), "utf8")));
}

/** The `providers` map of the imported Score. */
function scoreProviders(): Record<string, unknown> {
  return asMap(scoreDocument()["providers"]);
}

/** One provider of the imported Score, or an empty map when absent. */
function providerInScore(id: string): Record<string, unknown> {
  return asMap(scoreProviders()[id]);
}

/** The `overrides` map a node of the imported Score carries. */
function overridesOf(node: Record<string, unknown>): Record<string, unknown> {
  return asMap(node["overrides"]);
}

/** The `overrides.<agent>` map of a provider in the imported Score. */
function providerOverride(id: string, agent: string): Record<string, unknown> {
  return asMap(overridesOf(providerInScore(id))[agent]);
}

/** The `overrides.<agent>` map of a provider's first model in the imported Score. */
function modelOverride(providerId: string, agent: string): Record<string, unknown> {
  const models = asList(providerInScore(providerId)["models"]);
  return asMap(overridesOf(asMap(models[0]))[agent]);
}

/** The `providers` map of an Agent's config, as parsed. */
function catalogOfAgent(path: string, jsonc = false): Record<string, unknown> {
  const text = readFileSync(path, "utf8");
  const providers = readKey(jsonc ? Bun.JSONC.parse(text) : Bun.YAML.parse(text), "providers");
  return asMap(providers);
}

describe("unis import — reverse Score generation", () => {
  test("imports omp's Catalog into a Score naming the same providers and models", () => {
    writeFileSync(ompPath(), OMP_FIXTURE);

    const { exitCode } = runUnis(["import", "omp"]);

    expect(exitCode).toBe(0);
    const providers = scoreProviders();
    expect(Object.keys(providers)).toHaveLength(2);
    expect(Object.keys(providers)).toContain("deepseek");
    expect(Object.keys(providers)).toContain("anthropic");

    const deepseek = providerInScore("deepseek");
    expect(deepseek["name"]).toBe("DeepSeek Official");
    expect(deepseek["baseUrl"]).toBe("https://api.deepseek.com/v1");
    // `api` is the Catalog's name for the Score's `apiType`. The import maps
    // it back, because a Score that said `api` would not validate.
    expect(deepseek["apiType"]).toBe("openai-completions");
    expect(asList(deepseek["models"])).toHaveLength(2);
    expect(asList(providerInScore("anthropic")["models"])).toHaveLength(1);
  });

  test("imports pi's Catalog into a Score declaring the same providers", () => {
    // pi's on-disk values are in write form: `$` doubled, `!`-leading
    // prefixed. The import has to reverse that, or a sync would write the
    // doubled form back and pi would resolve a single `$` twice over. The
    // credential is named as a reference rather than inlined, so the proof is
    // on a field the import does not rewrite.
    writeFileSync(
      piPath(),
      JSON.stringify(
        {
          settings: { theme: "dark" },
          providers: {
            deepseek: {
              name: "DeepSeek Official",
              baseUrl: "https://api.deepseek.com/v1",
              apiKey: "sk-pi-key-12345678",
              api: "openai-completions",
              region: "us-$$east",
              models: [{ id: "deepseek-chat", name: "DeepSeek V3", contextWindow: 65536 }],
            },
            shellish: {
              name: "Shellish",
              baseUrl: "https://x/v1",
              apiKey: "sk-pi-key-12345678",
              api: "openai-completions",
              models: [{ id: "m", name: "M", contextWindow: 4096 }],
            },
          },
        },
        null,
        2,
      ),
    );

    const { exitCode } = runUnis(["import", "pi"]);

    expect(exitCode).toBe(0);
    expect(Object.keys(scoreProviders())).toEqual(["deepseek", "shellish"]);
    expect(providerOverride("deepseek", "pi")).toEqual({ region: "us-$east" });
  });

  test("hoists a field the common schema cannot express into overrides.omp", () => {
    writeFileSync(ompPath(), OMP_FIXTURE);

    runUnis(["import", "omp"]);

    const reasoning = asMap(asList(providerInScore("deepseek")["models"])[1]);
    // The model's own fields go where the Score puts them; the rest is omp's,
    // and the import does not get to drop it.
    expect(reasoning).toMatchObject({
      id: "deepseek-reasoner",
      name: "DeepSeek R1 (Reasoning)",
      contextWindow: 65536,
      maxTokens: 8192,
      reasoning: true,
    });
    expect(overridesOf(reasoning)["omp"]).toEqual({
      compat: { supportsDeveloperRole: false },
      cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 },
      input: ["text"],
      thinking: { mode: "effort", efforts: ["low", "medium", "high"] },
    });
  });

  test("leaves an omp value holding a literal $ or ! exactly as it is", () => {
    // omp stores its Catalog as written — no escape on write (spec §3.1), so
    // an unescape on import would be a rewrite of a value the Score never
    // asked to change: `$$` in a header would come out as `$`, and the next
    // sync would write the halved value back to omp.
    writeFileSync(
      ompPath(),
      [
        "providers:",
        "  deepseek:",
        '    name: "DeepSeek Official"',
        '    baseUrl: "https://api.deepseek.com/v1"',
        '    apiKey: "sk-omp-key-87654321"',
        '    api: "openai-completions"',
        "    headers:",
        '      X-Token: "$$secret"',
        '      X-Command: "!not a shell command"',
        "    models:",
        '      - id: "deepseek-chat"',
        '        name: "DeepSeek V3"',
        "        contextWindow: 65536",
        "",
      ].join("\n"),
    );

    expect(runUnis(["import", "omp"]).exitCode).toBe(0);

    expect(providerInScore("deepseek")["headers"]).toEqual({
      "X-Token": "$$secret",
      "X-Command": "!not a shell command",
    });
  });

  test("hoists a provider-level agent-specific field into overrides.omp", () => {
    writeFileSync(
      ompPath(),
      [
        "providers:",
        "  deepseek:",
        '    name: "DeepSeek Official"',
        '    baseUrl: "https://api.deepseek.com/v1"',
        '    apiKey: "sk-omp-key-87654321"',
        '    api: "openai-completions"',
        "    apiKeyRole: deploy",
        "    models:",
        '      - id: "deepseek-chat"',
        '        name: "DeepSeek V3"',
        "        contextWindow: 65536",
        "",
      ].join("\n"),
    );

    runUnis(["import", "omp"]);

    expect(providerInScore("deepseek")).not.toHaveProperty("apiKeyRole");
    expect(providerOverride("deepseek", "omp")).toEqual({ apiKeyRole: "deploy" });
  });

  test("keeps a pi-only field as overrides.pi", () => {
    writeFileSync(
      piPath(),
      JSON.stringify({
        providers: {
          pi: {
            name: "Pi",
            baseUrl: "https://x/v1",
            apiKey: "sk-pi-key-12345678",
            api: "openai-completions",
            piOnly: { nested: true },
            models: [{ id: "m", name: "M", contextWindow: 4096, piModelField: 7 }],
          },
        },
      }),
    );

    runUnis(["import", "pi"]);

    expect(providerOverride("pi", "omp")).toEqual({});
    expect(providerOverride("pi", "pi")).toEqual({ piOnly: { nested: true } });
    expect(modelOverride("pi", "pi")).toEqual({ piModelField: 7 });
  });

  test("preserves headers and the standard fields as Score fields", () => {
    writeFileSync(ompPath(), OMP_FIXTURE);

    runUnis(["import", "omp"]);

    expect(providerInScore("deepseek")["headers"]).toEqual({ "User-Agent": "Unisono-Sync/1.0" });
    const chat = asMap(asList(providerInScore("deepseek")["models"])[0]);
    expect(chat).toMatchObject({ id: "deepseek-chat", name: "DeepSeek V3", contextWindow: 65536 });
  });

  test("does not inline the credential it found into the draft", () => {
    writeFileSync(ompPath(), OMP_FIXTURE);

    runUnis(["import", "omp"]);
    const text = readFileSync(scorePath(), "utf8");

    // The import's purpose is a draft, and a Score is committed and shared. The
    // key on disk is already plaintext, so inlining it would make the Source of
    // Truth a credential store — the reference names a variable instead.
    expect(text).not.toContain("sk-omp-key-87654321");
    expect(text).toContain("DEEPSEEK_API_KEY");
  });

  test("a generated Score passes unis validate once its variable is exported", () => {
    writeFileSync(ompPath(), OMP_FIXTURE);

    expect(runUnis(["import", "omp"]).exitCode).toBe(0);

    const validated = runUnis(["validate"], {
      DEEPSEEK_API_KEY: "sk-omp-key-87654321",
      ANTHROPIC_API_KEY: "sk-omp-ant-12345678",
    });
    expect(validated.exitCode).toBe(0);
    expect(validated.stdout).toContain("valid (2 providers, 3 models)");
  });

  test("reports the variable name a missing credential needs", () => {
    writeFileSync(ompPath(), OMP_FIXTURE);

    expect(runUnis(["import", "omp"]).exitCode).toBe(0);

    // The validation failure names the variable, so the reader knows what to
    // export rather than that something was unset.
    const unset = runUnis(["validate"]);
    expect(unset.exitCode).toBe(1);
    expect(unset.stdout + unset.stderr).toContain("DEEPSEEK_API_KEY");
  });

  test("import into a Score path that does not exist yet works", () => {
    expect(existsSync(scorePath())).toBe(false);

    writeFileSync(ompPath(), OMP_FIXTURE);
    const { exitCode } = runUnis(["import", "omp"]);

    expect(exitCode).toBe(0);
    expect(existsSync(scorePath())).toBe(true);
  });

  test("refuses to overwrite a Score that already exists", () => {
    writeScore(`version: "1"
providers:
  mine:
    name: "Mine"
    baseUrl: "https://x/v1"
    apiKey: "sk-mine-12345678"
    apiType: "openai-completions"
    models:
      - id: "m"
        name: "M"
        contextWindow: 4096
`);
    const guarded = readFileSync(scorePath(), "utf8");

    writeFileSync(ompPath(), OMP_FIXTURE);
    const { stdout, stderr, exitCode } = runUnis(["import", "omp"]);

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("already exists");
    // The existing Score is untouched, not truncated and not merged into.
    expect(readFileSync(scorePath(), "utf8")).toBe(guarded);
  });

  test("round-trips omp: import then sync leaves the Catalog semantically equal", () => {
    writeFileSync(ompPath(), OMP_FIXTURE);

    expect(runUnis(["import", "omp"]).exitCode).toBe(0);
    const before = catalogOfAgent(ompPath());

    const synced = runUnis(["sync", "--yes"], {
      DEEPSEEK_API_KEY: "sk-omp-key-87654321",
      ANTHROPIC_API_KEY: "sk-omp-ant-12345678",
    });

    expect(synced.exitCode).toBe(0);
    // The takeover is wholesale and the import hoists rather than renames, so
    // the Catalog a sync writes back is the one it came from — modulo key
    // order and serialization, which the comparison ignores.
    expect(catalogOfAgent(ompPath())).toEqual(before);
  });

  test("round-trips a pi Catalog with values pi must not execute or expand", () => {
    const catalog = {
      providers: {
        pi: {
          name: "Pi",
          baseUrl: "https://x/v1",
          apiKey: "sk-pi-key-12345678",
          api: "openai-completions",
          models: [
            { id: "m", name: "M", contextWindow: 4096 },
            { id: "d", name: "D", contextWindow: 8192, piSecret: "a$b" },
          ],
        },
      },
    };
    writeFileSync(piPath(), JSON.stringify(catalog, null, 2));

    expect(runUnis(["import", "pi"]).exitCode).toBe(0);

    const synced = runUnis(["sync", "--yes"], { PI_API_KEY: "sk-pi-key-12345678" });
    expect(synced.exitCode).toBe(0);
    // The model's `piSecret` is not a Score field, so it rode through as
    // `overrides.pi` — and it comes back escaped on disk, which is the form pi
    // resolves to `a$b`. The Catalog is therefore not byte-identical to the
    // fixture, and must not be: a `$` written raw is a value pi would expand.
    const pi = asMap(catalogOfAgent(piPath(), true)["pi"]);
    expect(pi).toMatchObject({
      name: "Pi",
      baseUrl: "https://x/v1",
      apiKey: "sk-pi-key-12345678",
      api: "openai-completions",
    });
    const onDisk = asList(pi["models"]);
    expect(asMap(onDisk[1])["piSecret"]).toBe("a$$b");
  });

  test("an imported Score is not automatically synced", () => {
    writeFileSync(ompPath(), OMP_FIXTURE);

    expect(runUnis(["import", "omp"]).exitCode).toBe(0);

    // The import writes a draft. A takeover is a deliberate, confirmed step,
    // so an import alone must not touch either Agent's config.
    expect(readFileSync(ompPath(), "utf8")).toBe(OMP_FIXTURE);
    expect(existsSync(piPath())).toBe(false);
  });

  test("reports a Catalog a Score cannot express rather than writing a broken draft", () => {
    // A provider with no models cannot be declared by a Score, and the import
    // must say so rather than emit a draft that fails validation.
    writeFileSync(
      ompPath(),
      [
        "providers:",
        "  empty:",
        '    name: "Empty"',
        '    baseUrl: "https://x/v1"',
        '    apiKey: "sk-e"',
        '    api: "openai-completions"',
        "    models: []",
        "",
      ].join("\n"),
    );

    const { stdout, stderr, exitCode } = runUnis(["import", "omp"]);

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("empty");
  });

  test("reports a model entry that is not a map rather than dropping it", () => {
    // A dropped entry would leave the provider's models list short, so the
    // draft would be written and exit 0 — while `unis validate` rejects it for
    // having too few models. An import that exits 0 claims a usable draft, so
    // the entry is reported instead.
    writeFileSync(
      ompPath(),
      [
        "providers:",
        "  deepseek:",
        '    name: "DeepSeek Official"',
        '    baseUrl: "https://api.deepseek.com/v1"',
        '    apiKey: "sk-omp-key-87654321"',
        '    api: "openai-completions"',
        "    models:",
        "      - 12345",
        "",
      ].join("\n"),
    );

    const { stdout, stderr, exitCode } = runUnis(["import", "omp"]);

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("deepseek");
    // Nothing is written when the draft cannot be expressed at all.
    expect(existsSync(scorePath())).toBe(false);
  });

  test("an Agent that is not installed cannot be imported", () => {
    const { stdout, stderr, exitCode } = runUnis(["import", "pi"]);

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("not installed");
  });

  test("names the Agent that was not imported, rather than leaving it silent", () => {
    writeFileSync(ompPath(), OMP_FIXTURE);

    const { stdout, stderr, exitCode } = runUnis(["import", "omp"]);

    expect(exitCode).toBe(0);
    // One Score, two Agents: importing omp says so about pi, because a user
    // who wanted both would otherwise not know to run it again. The warning's
    // own wording is what is asserted — the tag appears in every status line,
    // so matching it alone would pass with the warning deleted.
    expect(stdout + stderr).toContain("PI's Catalog was not imported");
  });

  test("writes the Score with 0600, because it holds credential references", () => {
    writeFileSync(ompPath(), OMP_FIXTURE);

    runUnis(["import", "omp"]);

    const mode = statSync(scorePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
