/**
 * Tests drive the real `unis` binary as a subprocess against a throwaway
 * config tree — the single seam mandated by the spec's Testing Decisions.
 * No internal module is imported; takeover, preservation, permissions, and
 * symlinks are all asserted through the command boundary and the files it
 * leaves behind. The seam itself, the sandbox, and the per-test teardown come
 * from `test/harness.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runUnis, useSandbox, type Sandbox } from "./harness";

const sandbox: Sandbox = useSandbox();

function writeScore(text: string): void {
  writeFileSync(sandbox.scorePath, text);
}

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

/** An omp config holding one unrelated provider, for a drifting start. */
function writeDriftingConfig(): void {
  writeFileSync(
    join(sandbox.ompDir, "models.yml"),
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
  return readKey(Bun.YAML.parse(readFileSync(join(sandbox.ompDir, "models.yml"), "utf8")), "providers");
}

/** The modified time of omp's config, for asserting a write did or did not happen. */
function ompMtime(): number {
  return statSync(join(sandbox.ompDir, "models.yml")).mtimeMs;
}

describe("unis sync — takeover and preservation", () => {
  test("replaces the Catalog wholesale, so it holds exactly the compiled providers", () => {
    writeScore(VALID_SCORE);
    writeDriftingConfig();

    const { stdout, exitCode } = runUnis(sandbox, ["sync", "--yes"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Synced (1 providers, 1 models)");
    expect(JSON.stringify(ompCatalog())).toBe(JSON.stringify(COMPILED_CATALOG));
  });

  test("preserves every non-Catalog top-level key byte-for-byte", () => {
    writeScore(VALID_SCORE);
    writeFileSync(
      join(sandbox.ompDir, "models.yml"),
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

    runUnis(sandbox, ["sync", "--yes"]);

    const written = readFileSync(join(sandbox.ompDir, "models.yml"), "utf8");
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

  test("replaces a quoted Catalog key rather than appending a second one", () => {
    // A user may spell the key `"providers":`; the stale block must be replaced
    // in place, not left behind beside a canonical duplicate.
    writeScore(VALID_SCORE);
    writeFileSync(
      join(sandbox.ompDir, "models.yml"),
      ['"providers":', "  stale:", "    models: []", "modelOverrides:", "  role: keep"].join("\n"),
    );

    const { exitCode } = runUnis(sandbox, ["sync", "--yes"]);

    expect(exitCode).toBe(0);
    const parsed = Bun.YAML.parse(readFileSync(join(sandbox.ompDir, "models.yml"), "utf8"));
    // Exactly one Catalog key, holding exactly the compiled Catalog.
    expect(Object.keys(readKey(parsed, "providers") as object)).toEqual(["deepseek"]);
    expect(JSON.stringify(readKey(parsed, "providers"))).toBe(JSON.stringify(COMPILED_CATALOG));
    expect(readKey(parsed, "modelOverrides")).toEqual({ role: "keep" });
  });

  test("appends the Catalog when the config has none", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(sandbox.ompDir, "models.yml"), "modelOverrides:\n  role: keep\n");

    const { exitCode } = runUnis(sandbox, ["sync"]);

    expect(exitCode).toBe(0);
    expect(readKey(Bun.YAML.parse(readFileSync(join(sandbox.ompDir, "models.yml"), "utf8")), "modelOverrides")).toEqual({
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
    writeFileSync(join(sandbox.ompDir, "models.yml"), converged);
    const mtimeBefore = ompMtime();

    const { stdout, exitCode } = runUnis(sandbox, ["sync"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Unchanged (1 providers, 1 models)");
    expect(stdout).not.toContain("drifts");
    // No snapshot and no write: contents and mtime are as they were.
    expect(readFileSync(join(sandbox.ompDir, "models.yml"), "utf8")).toBe(converged);
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
    writeFileSync(join(sandbox.ompDir, "models.yml"), reformatted);
    const mtimeBefore = ompMtime();

    const { stdout, exitCode } = runUnis(sandbox, ["sync"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Unchanged");
    // Semantic equality drives the decision, so the formatting is left alone.
    expect(readFileSync(join(sandbox.ompDir, "models.yml"), "utf8")).toBe(reformatted);
    expect(ompMtime()).toBe(mtimeBefore);
  });
});

describe("unis sync — write safety", () => {
  test("writes the target config with 0600 permissions", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(sandbox.ompDir, "models.yml"), "providers: {}\n");
    // Start world-readable, as a hand-written config often is.
    chmodSync(join(sandbox.ompDir, "models.yml"), 0o644);

    const { exitCode } = runUnis(sandbox, ["sync", "--yes"]);

    expect(exitCode).toBe(0);
    expect(statSync(join(sandbox.ompDir, "models.yml")).mode & 0o777).toBe(0o600);
  });

  test("writes through a symlink, replacing the real file and keeping the link", () => {
    writeScore(VALID_SCORE);
    const real = join(sandbox.root, "real-models.yml");
    const linked = join(sandbox.root, "linked", "agent");
    mkdirSync(linked, { recursive: true });
    writeFileSync(real, "providers:\n  stale: {}\n");
    symlinkSync(real, join(linked, "models.yml"));

    const { stdout, exitCode } = runUnis(sandbox, ["sync", "--yes"], { OMP_CODING_AGENT_DIR: linked });

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

    const { exitCode } = runUnis(sandbox, ["sync", "--yes"]);

    expect(exitCode).toBe(0);
    expect(readdirSync(sandbox.ompDir)).toEqual(["models.yml"]);
  });

  test("leaves a drifting pi config untouched, because its write path is not built yet", () => {
    // pi speaks JSON with escaping the YAML splice does not do: writing it
    // through the omp path would corrupt the file and destroy its non-Catalog
    // nodes. Its takeover is a later ticket, so until then it is only reported.
    writeScore(VALID_SCORE);
    const piConfig = JSON.stringify(
      { settings: { defaultModel: "deepseek/deepseek-reasoner" }, providers: { old: { models: [] } } },
      null,
      2,
    );
    writeFileSync(join(sandbox.piDir, "models.json"), piConfig);
    const mtimeBefore = statSync(join(sandbox.piDir, "models.json")).mtimeMs;

    const { stdout, exitCode } = runUnis(sandbox, ["sync"]);

    // The gate fires on pi's undeclared provider and refuses the whole sync, so
    // the takeover never reaches the write path for either Agent.
    expect(exitCode).toBe(2);
    expect(stdout).toContain("drifts");
    expect(stdout).toContain("[PI]");
    // The file is exactly as it was: same bytes, same time, still parseable.
    expect(readFileSync(join(sandbox.piDir, "models.json"), "utf8")).toBe(piConfig);
    expect(statSync(join(sandbox.piDir, "models.json")).mtimeMs).toBe(mtimeBefore);
    expect(readKey(Bun.JSONC.parse(piConfig), "settings")).toEqual({
      defaultModel: "deepseek/deepseek-reasoner",
    });
  });

  test("converges rather than fighting its own write", () => {
    // Two syncs run back to back: the second sees what the first wrote, so it
    // reports Unchanged and makes no write. A file edited *between* a sync's
    // read and its write is the case the hash re-check refuses (spec §5.3), and
    // its window is inside a single process — the read and the re-check are
    // steps of the same command, so nothing outside the process can land in
    // between. What this test proves is the half the boundary can reach: the
    // write path never fights itself, because a file the sync just wrote is
    // seen as already equal and left alone.
    writeScore(VALID_SCORE);
    writeDriftingConfig();

    const first = runUnis(sandbox, ["sync", "--yes"]);
    const afterFirst = readFileSync(join(sandbox.ompDir, "models.yml"), "utf8");

    const second = runUnis(sandbox, ["sync"]);

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("Synced");
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Unchanged");
    // The second sync made no write, so what the first wrote stands.
    expect(readFileSync(join(sandbox.ompDir, "models.yml"), "utf8")).toBe(afterFirst);
  });

  test("reports a config it cannot safely write instead of clobbering it", () => {
    // The write-safety half the boundary can reach: when the atomic write
    // cannot land, the run fails loudly rather than leaving a partial Catalog.
    // The path chosen here makes the *write* fail rather than the read, because
    // omp's config exists and parses — so the takeover is prepared — and a
    // directory in place of the file is what the rename cannot get past.
    writeScore(VALID_SCORE);
    writeDriftingConfig();
    rmSync(join(sandbox.ompDir, "models.yml"));
    mkdirSync(join(sandbox.ompDir, "models.yml"), { recursive: true });

    const result = runUnis(sandbox, ["sync", "--yes"]);

    // A config left half-taken-over is the one outcome the whole write path
    // exists to prevent, so any failure here has to be a loud one.
    expect(result.exitCode).toBe(1);
  });
});

describe("unis sync — the first-takeover gate", () => {
  /** An omp config whose Catalog holds a Provider the Score does not declare. */
  function writeDoomedConfig(): void {
    writeFileSync(
      join(sandbox.ompDir, "models.yml"),
      [
        "modelOverrides:",
        "  role: hand-written",
        "providers:",
        "  hand-tuned:",
        "    baseUrl: https://hand.example/v1",
        "    api: openai-completions",
        "    models:",
        "      - id: hand-model",
        "        contextWindow: 8192",
      ].join("\n"),
    );
  }

  test("refuses the whole sync and exits 2 when a Provider would be deleted", () => {
    writeScore(VALID_SCORE);
    writeDoomedConfig();

    const { stdout, stderr, exitCode } = runUnis(sandbox, ["sync"]);

    expect(exitCode).toBe(2);
    expect(stdout + stderr).toContain("would delete Providers not declared in the Score");
  });

  test("lists the doomed Providers and their models, by id", () => {
    writeScore(VALID_SCORE);
    writeDoomedConfig();

    const { stdout, stderr, exitCode } = runUnis(sandbox, ["sync"]);

    expect(exitCode).toBe(2);
    // The gate is a refusal, so its listing goes to stderr.
    expect(stdout + stderr).toContain("hand-tuned (models: hand-model)");
  });

  test("tells the user how to proceed, naming only commands that exist", () => {
    writeScore(VALID_SCORE);
    writeDoomedConfig();

    const { stdout, stderr, exitCode } = runUnis(sandbox, ["sync"]);

    expect(exitCode).toBe(2);
    expect(stdout + stderr).toContain("unis sync --yes");
    // Every recommended route must exist today, so the reader is never sent to
    // an "unknown command" at the moment of data loss.
    expect(stdout + stderr).not.toContain("unis import");
  });

  test("writes nothing to either Agent while refusing", () => {
    writeScore(VALID_SCORE);
    writeDoomedConfig();
    const before = readFileSync(join(sandbox.ompDir, "models.yml"), "utf8");
    const piConfig = JSON.stringify({ settings: { defaultModel: "hand-tuned/hand-model" } }, null, 2);
    writeFileSync(join(sandbox.piDir, "models.json"), piConfig);
    const ompMtimeBefore = ompMtime();
    const piMtimeBefore = statSync(join(sandbox.piDir, "models.json")).mtimeMs;

    const { exitCode } = runUnis(sandbox, ["sync"]);

    expect(exitCode).toBe(2);
    // Not even the Agent whose Catalog only drifts was touched.
    expect(readFileSync(join(sandbox.ompDir, "models.yml"), "utf8")).toBe(before);
    expect(readFileSync(join(sandbox.piDir, "models.json"), "utf8")).toBe(piConfig);
    expect(ompMtime()).toBe(ompMtimeBefore);
    expect(statSync(join(sandbox.piDir, "models.json")).mtimeMs).toBe(piMtimeBefore);
  });

  test("proceeds with the takeover when --yes is passed", () => {
    writeScore(VALID_SCORE);
    writeDoomedConfig();

    const { stdout, stderr, exitCode } = runUnis(sandbox, ["sync", "--yes"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Synced (1 providers, 1 models)");
    // The written Catalog holds exactly what the Score declares: the doomed
    // entry is gone, and the non-Catalog node survived the takeover.
    expect(JSON.stringify(ompCatalog())).toBe(JSON.stringify(COMPILED_CATALOG));
    expect(readFileSync(join(sandbox.ompDir, "models.yml"), "utf8")).toContain("role: hand-written");
  });

  test("does not fire when the Catalog already matches the Score's providers", () => {
    // A Catalog holding exactly the declared Providers — even one whose fields
    // drift from the compiled result — deletes nothing, so the gate stays shut.
    writeScore(VALID_SCORE);
    const converged = Bun.YAML.stringify({ providers: COMPILED_CATALOG }, null, 2);
    writeFileSync(join(sandbox.ompDir, "models.yml"), converged);
    const mtimeBefore = ompMtime();

    const { stdout, exitCode } = runUnis(sandbox, ["sync"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Unchanged (1 providers, 1 models)");
    expect(stdout).not.toContain("would delete");
    expect(readFileSync(join(sandbox.ompDir, "models.yml"), "utf8")).toBe(converged);
    expect(ompMtime()).toBe(mtimeBefore);
  });

  test("previews the deletion with --dry-run without demanding confirmation", () => {
    writeScore(VALID_SCORE);
    writeDoomedConfig();

    const { exitCode } = runUnis(sandbox, ["sync", "--dry-run"]);

    // A preview never writes, so it reports what a takeover would delete and
    // exits 0 rather than asking for a confirmation it will never act on.
    expect(exitCode).toBe(0);
    expect(readFileSync(join(sandbox.ompDir, "models.yml"), "utf8")).toContain("hand-tuned");
  });

  test("does not fire when a Provider the Score declares is merely drifting", () => {
    // The score declares `deepseek`; the on-disk Catalog holds it with fields
    // that differ. That is ordinary drift, not a deletion, so the gate stays
    // shut even though the sync still writes.
    writeScore(VALID_SCORE);
    writeFileSync(
      join(sandbox.ompDir, "models.yml"),
      ["providers:", "  deepseek:", "    baseUrl: https://wrong.example/v1"].join("\n"),
    );

    const { stdout, exitCode } = runUnis(sandbox, ["sync"]);

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("would delete");
    expect(JSON.stringify(ompCatalog())).toBe(JSON.stringify(COMPILED_CATALOG));
  });

  test("gates on a Provider whose id shadows an Object key", () => {
    // `constructor` and `toString` are own keys of a parsed Catalog but also
    // resolve on Object.prototype. If the gate asked `id in compiled` it would
    // find them "declared" by a Score that never declared them — keeping the
    // gate shut over an entry the takeover then deletes silently.
    writeScore(VALID_SCORE);
    writeFileSync(join(sandbox.ompDir, "models.yml"), "providers:\n  constructor:\n    models: []\n");

    const { stdout, stderr, exitCode } = runUnis(sandbox, ["sync"]);

    expect(exitCode).toBe(2);
    expect(stdout + stderr).toContain("OMP: constructor");
    // The refusal withheld the write, so the entry is still there.
    expect(readFileSync(join(sandbox.ompDir, "models.yml"), "utf8")).toContain("constructor");
  });
});

describe("unis sync --dry-run", () => {
  test("previews the takeover and writes nothing", () => {
    writeScore(VALID_SCORE);
    writeDriftingConfig();
    const before = readFileSync(join(sandbox.ompDir, "models.yml"), "utf8");
    const mtimeBefore = ompMtime();

    const { stdout, exitCode } = runUnis(sandbox, ["sync", "--dry-run"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("drifts");
    expect(stdout).not.toContain("Synced");
    expect(readFileSync(join(sandbox.ompDir, "models.yml"), "utf8")).toBe(before);
    expect(ompMtime()).toBe(mtimeBefore);
  });
});

describe("unis sync — reporting", () => {
  test("reports each Agent's state and exits 1 when one cannot be parsed", () => {
    writeScore(VALID_SCORE);
    writeFileSync(join(sandbox.ompDir, "models.yml"), "providers: [unclosed\n");
    writeFileSync(join(sandbox.piDir, "models.json"), "{ broken");

    const { stdout, exitCode } = runUnis(sandbox, ["sync"]);

    // One broken Agent must not blind the other.
    expect(stdout).toContain("[OMP]");
    expect(stdout).toContain("[PI]");
    expect(stdout).toContain("Failed");
    expect(exitCode).toBe(1);
  });

  test("exits 1 with the reason when the Score itself is invalid", () => {
    writeScore('version: "2"\nproviders: {}\n');

    const { stderr, exitCode } = runUnis(sandbox, ["sync"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("version");
  });

  test("rejects an unknown flag rather than syncing with it", () => {
    writeScore(VALID_SCORE);
    writeDriftingConfig();

    const { exitCode } = runUnis(sandbox, ["sync", "--yolo"]);

    expect(exitCode).not.toBe(0);
    // Nothing was written while the flag was being rejected.
    expect(readFileSync(join(sandbox.ompDir, "models.yml"), "utf8")).toContain("stale");
  });
});
