/**
 * The Score contract, asserted through the CLI subprocess seam the spec
 * mandates: the real `unis` binary against a per-test temporary tree, with
 * output, files, and exit code as the only observable surface. The seam
 * itself, the sandbox, and the per-test teardown come from `test/harness.ts`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runUnis, useSandbox, type Sandbox } from "./harness";

const sandbox: Sandbox = useSandbox();

/** Runs `unis validate` in the sandbox. */
function runValidate(env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  return runUnis(sandbox, ["validate"], env);
}

function writeScore(text: string): void {
  mkdirSync(join(sandbox.configDir, "unisono"), { recursive: true });
  writeFileSync(sandbox.scorePath, text);
}

/** The smallest Score that passes; individual tests break one thing in it. */
const VALID_SCORE = `version: "1"
providers:
  deepseek:
    name: "DeepSeek Official"
    baseUrl: "https://api.deepseek.com/v1"
    apiKey: "\${UNIS_TEST_KEY}"
    apiType: "openai-completions"
    models:
      - id: "deepseek-chat"
        name: "DeepSeek V3"
        contextWindow: 65536
`;

describe("unis validate — a well-formed Score", () => {
  test("passes and exits 0", () => {
    writeScore(VALID_SCORE);

    const { stdout, exitCode } = runValidate({ UNIS_TEST_KEY: "sk-test-key-1234567890" });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("valid (1 providers, 1 models)");
  });

  test("expands ${VAR} to plaintext without echoing the key back", () => {
    writeScore(VALID_SCORE);

    const { stdout, stderr, exitCode } = runValidate({ UNIS_TEST_KEY: "sk-test-key-1234567890" });

    expect(exitCode).toBe(0);
    expect(stdout + stderr).not.toContain("sk-test-key-1234567890");
  });
});

describe("unis validate — structural failures", () => {
  test("a missing version is rejected", () => {
    writeScore(VALID_SCORE.replace(/^version: "1"\n/, ""));

    const { stdout, stderr, exitCode } = runValidate({ UNIS_TEST_KEY: "k" });

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("version is required");
  });

  test("a version other than \"1\" is rejected, naming the actual value", () => {
    writeScore(VALID_SCORE.replace('version: "1"', 'version: "2"'));

    const { stdout, stderr, exitCode } = runValidate({ UNIS_TEST_KEY: "k" });

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("version must be");
    expect(stdout + stderr).toContain('"2"');
  });

  test("missing providers is rejected", () => {
    writeScore('version: "1"\n');

    const { exitCode } = runValidate({ UNIS_TEST_KEY: "k" });

    expect(exitCode).toBe(1);
  });

  test("an empty providers map is rejected", () => {
    writeScore('version: "1"\nproviders: {}\n');

    const { stdout, stderr, exitCode } = runValidate({ UNIS_TEST_KEY: "k" });

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("providers is empty");
  });

  test("a provider missing a required field is rejected, naming provider and field", () => {
    writeScore(VALID_SCORE.replace('    baseUrl: "https://api.deepseek.com/v1"\n', ""));

    const { stdout, stderr, exitCode } = runValidate({ UNIS_TEST_KEY: "k" });

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("provider 'deepseek'.baseUrl is required");
  });

  test("an apiType outside the enum is rejected, listing the allowed values", () => {
    writeScore(VALID_SCORE.replace("openai-completions", "openai-chat"));

    const { stdout, stderr, exitCode } = runValidate({ UNIS_TEST_KEY: "k" });

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("apiType");
    expect(stdout + stderr).toContain("anthropic-messages");
  });

  test("a model missing a required field is rejected, naming the model", () => {
    writeScore(VALID_SCORE.replace('        name: "DeepSeek V3"\n', ""));

    const { stdout, stderr, exitCode } = runValidate({ UNIS_TEST_KEY: "k" });

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("models[0].name is required");
  });

  test("a duplicate model id within a provider is rejected", () => {
    writeScore(VALID_SCORE.replace(
      "      - id: \"deepseek-chat\"\n        name: \"DeepSeek V3\"\n        contextWindow: 65536\n",
      "      - id: \"deepseek-chat\"\n        name: \"DeepSeek V3\"\n        contextWindow: 65536\n      - id: \"deepseek-chat\"\n        name: \"DeepSeek V3\"\n        contextWindow: 65536\n",
    ));

    const { stdout, stderr, exitCode } = runValidate({ UNIS_TEST_KEY: "k" });

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("duplicated within provider 'deepseek'");
  });

  test("a non-integer or non-positive contextWindow or maxTokens is rejected", () => {
    for (const broken of ["contextWindow: 1.5", "contextWindow: -8", "maxTokens: 0"]) {
      writeScore(VALID_SCORE.replace("        contextWindow: 65536\n", `        ${broken}\n`));

      const { exitCode } = runValidate({ UNIS_TEST_KEY: "k" });

      expect(exitCode).toBe(1);
    }
  });

  test("string fields holding non-strings are rejected", () => {
    const cases: Array<[string, string]> = [
      ['    name: "DeepSeek Official"\n', "    name: 42\n"],
      ['    baseUrl: "https://api.deepseek.com/v1"\n', "    baseUrl: [not, a, url]\n"],
      ['        name: "DeepSeek V3"\n', "        name: { nested: object }\n"],
      ['      - id: "deepseek-chat"\n', "      - id: 7\n"],
    ];
    for (const [from, to] of cases) {
      writeScore(VALID_SCORE.replace(from, to));

      const { stdout, stderr, exitCode } = runValidate({ UNIS_TEST_KEY: "k" });

      expect(exitCode).toBe(1);
      expect(stdout + stderr).toContain("must be a string");
    }
  });

  test("a numeric apiKey is rejected, not crashed on", () => {
    // An apiKey holding a number used to escape every check and throw a
    // TypeError from expansion, taking the command down with a stack trace.
    writeScore(VALID_SCORE.replace('    apiKey: "${UNIS_TEST_KEY}"\n', "    apiKey: 12345\n"));

    const { stdout, stderr, exitCode } = runValidate({});

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("apiKey must be a string");
    expect(stdout + stderr).not.toContain("TypeError");
  });

  test("empty required strings are rejected", () => {
    const cases: Array<[string, string]> = [
      ['    name: "DeepSeek Official"\n', '    name: ""\n'],
      ['    baseUrl: "https://api.deepseek.com/v1"\n', '    baseUrl: ""\n'],
      ['    apiKey: "${UNIS_TEST_KEY}"\n', '    apiKey: ""\n'],
      ['      - id: "deepseek-chat"\n', '      - id: ""\n'],
      ['        name: "DeepSeek V3"\n', '        name: ""\n'],
    ];
    for (const [from, to] of cases) {
      writeScore(VALID_SCORE.replace(from, to));

      const { stdout, stderr, exitCode } = runValidate({ UNIS_TEST_KEY: "k" });

      expect(exitCode).toBe(1);
      expect(stdout + stderr).toContain("must not be empty");
    }
  });

  test("a provider with no models is rejected", () => {
    writeScore(VALID_SCORE.replace(/      - id:[\s\S]*?contextWindow: 65536\n/, "      []\n"));

    const { stdout, stderr, exitCode } = runValidate({ UNIS_TEST_KEY: "k" });

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("models is empty");
  });

  test("a Score that is not YAML is rejected rather than crashing", () => {
    writeScore("version: \"1\"\nproviders: [unclosed\n");

    const { stdout, stderr, exitCode } = runValidate({ UNIS_TEST_KEY: "k" });

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("Score is not valid YAML");
  });

  test("a missing Score file is rejected", () => {
    const { stdout, stderr, exitCode } = runValidate({ UNIS_TEST_KEY: "k" });

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("cannot read Score");
  });
});

describe("unis validate — credential references", () => {
  test("an undefined variable aborts, naming it", () => {
    writeScore(VALID_SCORE);

    const { stdout, stderr, exitCode } = runValidate({});

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("UNIS_TEST_KEY");
    expect(stdout + stderr).toContain("not defined or is empty");
  });

  test("an empty variable aborts like an undefined one", () => {
    writeScore(VALID_SCORE);

    const { stdout, stderr, exitCode } = runValidate({ UNIS_TEST_KEY: "" });

    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("UNIS_TEST_KEY");
  });

  test("a literal key with no reference is accepted, and ${VAR} is the only template form", () => {
    writeScore(VALID_SCORE.replace('"${UNIS_TEST_KEY}"', '"sk-literal-plaintext-key"'));

    const { exitCode } = runValidate({});

    expect(exitCode).toBe(0);
  });

  test("an unsupported template form is not expanded", () => {
    // `$UNIS_TEST_KEY` and `{{UNIS_TEST_KEY}}` are not the recognized syntax;
    // they are left literal rather than resolved from the environment.
    writeScore(VALID_SCORE.replace('"${UNIS_TEST_KEY}"', '"$UNIS_TEST_KEY"'));

    const { exitCode } = runValidate({ UNIS_TEST_KEY: "sk-should-not-be-used" });

    expect(exitCode).toBe(0);
  });

  test("an aborted run writes nothing anywhere", () => {
    writeScore(VALID_SCORE);
    const ompConfig = join(sandbox.ompDir, "models.yml");
    writeFileSync(ompConfig, "providers: {}\n");

    const { exitCode } = runValidate({});

    expect(exitCode).toBe(1);
    expect(existsSync(ompConfig)).toBe(true);
    // The Agent's config is untouched: no backup area is even created.
    expect(existsSync(join(sandbox.configDir, "unisono", "backups"))).toBe(false);
  });
});

describe("unis validate — warnings", () => {
  test("unknown top-level, provider, and model keys warn without aborting", () => {
    writeScore(
      VALID_SCORE.replace("        contextWindow: 65536\n", "        contextWindow: 65536\n        extraModelField: 1\n") +
        "extraTopLevel: true\n",
    );

    const { stdout, stderr, exitCode } = runValidate({ UNIS_TEST_KEY: "k" });

    expect(exitCode).toBe(0);
    expect(stdout + stderr).toContain("unknown top-level key 'extraTopLevel'");
    expect(stdout + stderr).toContain("unknown field 'extraModelField'");
  });

  test("warnings go to stderr, the status line to stdout", () => {
    writeScore(`${VALID_SCORE}extraTopLevel: true\n`);

    const { stdout, stderr, exitCode } = runValidate({ UNIS_TEST_KEY: "k" });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("valid (1 providers, 1 models)");
    expect(stdout).not.toContain("possible typo");
    expect(stderr).toContain("possible typo");
  });

  test("output stays plain line-oriented text when piped", () => {
    writeScore(VALID_SCORE);

    const { stdout } = runValidate({ UNIS_TEST_KEY: "k" });

    // eslint-disable-next-line no-control-regex
    expect(/[][\[0-9;]*[A-Za-z]/.test(stdout)).toBe(false);
  });
});
