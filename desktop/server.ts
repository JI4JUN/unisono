/**
 * Unisono Desktop — the local control server.
 *
 * The desktop client is a thin shell: a window over a local Bun server that
 * owns the Score edits and the `unis` runs. Nothing here reimplements the
 * compiler — Score validation, Catalog comparison, and atomic writes come
 * from `../src`, and a sync shells out to the real CLI. The server only
 * adds what the CLI deliberately does not: an in-place `agents` splice on
 * the user's own Score (one field, never the whole file), and the HTTP
 * surface the UI talks to.
 *
 * Credentials never leave the machine: `/api/state` omits every `apiKey`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { countCatalog, readCatalog } from "../src/agent";
import { compareAgent } from "../src/commands/shared";
import { isObjectNode } from "../src/guards";
import { AGENT_IDS, type AgentId, scorePath } from "../src/paths";
import { loadScore, type Score } from "../src/score";
import { atomicWrite, hashText } from "../src/writer";

const PORT = 4737;
const repoRoot = join(import.meta.dir, "..");
const uiDist = join(import.meta.dir, "ui", "dist");
const scoreFile = scorePath();

const AGENT_LOOKUP: Record<string, true> = Object.fromEntries(
  AGENT_IDS.map((id) => [id, true]),
);

/** The Score's provider list as the UI renders it, with no secrets. */
function summarizeScore(score: Score) {
  return Object.entries(score.providers).map(([id, provider]) => ({
    id,
    baseUrl: provider.baseUrl,
    apiType: provider.apiType,
    models: provider.models.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
      agents: model.agents ?? null,
    })),
  }));
}

/** One Agent's on-disk Catalog as id lists, so a panel can render its slots. */
function summarizeCatalog(catalog: Record<string, Record<string, unknown>>) {
  return Object.entries(catalog).map(([id, provider]) => ({
    id,
    models: Array.isArray(provider["models"])
      ? provider["models"]
          .filter(
            (model): model is { id: string } =>
              isObjectNode(model) && typeof model["id"] === "string",
          )
          .map((model) => model.id)
      : [],
  }));
}

/** The whole dashboard state, as one response. */
async function state() {
  const scoreResult = await loadScore(scoreFile);

  const agents: Record<string, unknown> = {};
  for (const id of AGENT_IDS) {
    const read = await readCatalog(id);
    if (!read.ok) {
      agents[id] = {
        installed: false,
        path: read.path,
        reason: read.reason,
        providers: [],
        synced: false,
      };
      continue;
    }
    const counts = countCatalog(read.catalog);
    const compare = scoreResult.ok
      ? await compareAgent(id, scoreResult.score)
      : null;
    agents[id] = {
      installed: true,
      path: read.path,
      providers: summarizeCatalog(read.catalog),
      providerCount: counts.providers,
      modelCount: counts.models,
      synced: compare?.state === "synced",
    };
  }

  return {
    scorePath: scoreFile,
    score: scoreResult.ok
      ? { ok: true, providers: summarizeScore(scoreResult.score) }
      : { ok: false, errors: scoreResult.errors },
    agents,
  };
}

/**
 * Sets a model's `agents` list in the Score, in place.
 *
 * The splice targets one field of one model entry and leaves every other
 * byte — comments, ordering, quoting — untouched. When the request names
 * every Agent, the field is removed instead: an unrestricted model needs no
 * `agents` line. A document that does not match the shape the splice
 * expects is refused untouched rather than reformatted.
 */
function setModelAgents(
  text: string,
  providerId: string,
  modelId: string,
  agents: AgentId[] | null,
): { ok: true; text: string } | { ok: false; reason: string } {
  const lines = text.split("\n");
  const indentOf = (line: string): number =>
    line.length - line.trimStart().length;
  const isBlank = (line: string): boolean => line.trim() === "";
  const isComment = (line: string): boolean => line.trim().startsWith("#");

  const providersAt = lines.findIndex((line) =>
    /^"?providers"?:\s*$/.test(line),
  );
  if (providersAt < 0) return { ok: false, reason: "no providers: block" };

  let providerAt = -1;
  for (let i = providersAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) continue;
    if (indentOf(line) < 2) break;
    if (new RegExp(`^  "?${escapeRegExp(providerId)}"?:\\s*$`).test(line)) {
      providerAt = i;
      break;
    }
  }
  if (providerAt < 0)
    return { ok: false, reason: `provider '${providerId}' not found` };

  let modelsAt = -1;
  for (let i = providerAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) continue;
    if (indentOf(line) < 4) break;
    if (/^    models:\s*$/.test(line)) {
      modelsAt = i;
      break;
    }
  }
  if (modelsAt < 0)
    return { ok: false, reason: `provider '${providerId}' has no models:` };

  let itemAt = -1;
  for (let i = modelsAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) continue;
    if (indentOf(line) < 6) break;
    if (new RegExp(`^      - id: "?${escapeRegExp(modelId)}"?\\s*$`).test(line)) {
      itemAt = i;
      break;
    }
  }
  if (itemAt < 0)
    return { ok: false, reason: `model '${modelId}' not found under '${providerId}'` };

  // The item's block ends at the next line that starts a sibling or goes up.
  let blockEnd = lines.length;
  for (let i = itemAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) continue;
    if (indentOf(line) <= 6) {
      blockEnd = i;
      break;
    }
  }

  const splice = [...lines];
  if (agents === null) {
    splice.splice(
      itemAt + 1,
      blockEnd - itemAt - 1,
      ...lines
        .slice(itemAt + 1, blockEnd)
        .filter((line) => !/^        agents:/.test(line)),
    );
  } else {
    const value = `        agents: [${agents.join(", ")}]`;
    const existing = lines
      .slice(itemAt + 1, blockEnd)
      .findIndex((line) => /^        agents:/.test(line));
    if (existing >= 0) {
      splice[itemAt + 1 + existing] = value;
    } else {
      splice.splice(blockEnd, 0, value);
    }
  }

  return { ok: true, text: splice.join("\n") };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Validates an `agents` payload: a non-empty subset of the known Agents. */
function parseAgents(value: unknown): AgentId[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0) return null;
  const agents: AgentId[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(entry in AGENT_LOOKUP))
      return null;
    agents.push(entry as AgentId);
  }
  return agents;
}

/** Runs the real `unis` CLI and reports its output verbatim. */
async function runSync(force: boolean): Promise<{
  exitCode: number;
  output: string;
}> {
  const proc = Bun.spawn(
    ["bun", "src/cli.ts", "sync", ...(force ? ["--yes"] : [])],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, output: `${stdout}${stderr}` };
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/state" && request.method === "GET") {
      return Response.json(await state());
    }

    if (path === "/api/assign" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const providerId = body?.providerId;
      const modelId = body?.modelId;
      if (
        typeof providerId !== "string" ||
        typeof modelId !== "string"
      ) {
        return Response.json(
          { error: "providerId and modelId must be strings" },
          { status: 400 },
        );
      }
      const agents = parseAgents(body?.agents);
      if (agents === null && body?.agents !== null) {
        return Response.json(
          { error: "agents must be a non-empty list of omp, pi" },
          { status: 400 },
        );
      }
      const assignment = agents === null ? null : agents;

      let text: string;
      try {
        text = readFileSync(scoreFile, "utf8");
      } catch {
        return Response.json(
          { error: `cannot read Score: ${scoreFile}` },
          { status: 500 },
        );
      }
      const spliced = setModelAgents(text, providerId, modelId, assignment);
      if (!spliced.ok) {
        return Response.json({ error: spliced.reason }, { status: 422 });
      }

      // The splice is trusted only after the document still parses and the
      // edited model still resolves; anything else is refused, never written.
      try {
        const parsed: unknown = Bun.YAML.parse(spliced.text);
        const providers = isObjectNode(parsed) ? parsed["providers"] : undefined;
        const provider = isObjectNode(providers)
          ? providers[providerId]
          : undefined;
        const models = isObjectNode(provider) ? provider["models"] : undefined;
        if (
          !Array.isArray(models) ||
          !models.some((model) => isObjectNode(model) && model["id"] === modelId)
        ) {
          return Response.json(
            { error: "spliced Score no longer resolves — refused" },
            { status: 422 },
          );
        }
      } catch {
        return Response.json(
          { error: "spliced Score is not valid YAML — refused" },
          { status: 422 },
        );
      }

      const written = atomicWrite(scoreFile, spliced.text, hashText(text));
      if (!written.wrote) {
        return Response.json(
          { error: "Score changed underneath the edit — refresh and retry" },
          { status: 409 },
        );
      }
      return Response.json(await state());
    }

    if (path === "/api/sync" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      return Response.json(await runSync(body?.force === true));
    }

    if (path.startsWith("/api/")) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    // Static UI from the built Vite output, when present.
    const wanted = path === "/" ? "index.html" : path.slice(1);
    const file = join(uiDist, wanted);
    if (existsSync(file) && file.startsWith(uiDist)) {
      return new Response(readFileSync(file), {
        headers: { "Content-Type": mimeOf(wanted) },
      });
    }
    return new Response(
      "Unisono UI not built — run `bun install && bun run build` in desktop/ui",
      { status: 404 },
    );
  },
});

function mimeOf(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

console.log(`🎼 Unisono Desktop server on http://127.0.0.1:${PORT}`);
