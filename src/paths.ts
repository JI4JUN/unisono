/**
 * Path resolution for the Score and the two supported Agents.
 *
 * Detection is by config file presence: an Agent is installed when its config
 * file exists at its resolved path. There is no enable/disable switch in the
 * MVP (see docs/mvp-spec.md §0).
 */

import { existsSync } from "node:fs";

/** The environment variable each Agent uses to relocate its config directory. */
const AGENT_DIR_ENV = {
  omp: "OMP_CODING_AGENT_DIR",
  pi: "PI_CODING_AGENT_DIR",
} as const;

/** Where each Agent keeps its config when its directory variable is unset. */
const AGENT_DEFAULT_DIR = {
  omp: ".omp/agent",
  pi: ".pi/agent",
} as const;

/** omp accepts `models.yaml` as well as `models.yml`; `yml` wins when both exist. */
const OMP_FILENAMES = ["models.yml", "models.yaml"];

export type AgentId = "omp" | "pi";

export const AGENT_IDS: readonly AgentId[] = ["omp", "pi"];

export function isAgentId(value: string): value is AgentId {
  return value === "omp" || value === "pi";
}

function configBase(): string {
  const xdg = Bun.env.XDG_CONFIG_HOME?.trim();
  return xdg ? `${xdg}/unisono` : `${Bun.env.HOME}/.config/unisono`;
}

/**
 * The Score's single location: `$XDG_CONFIG_HOME/unisono/score.yaml`, falling
 * back to `~/.config/unisono/score.yaml` when XDG is unset.
 */
export function scorePath(): string {
  return `${configBase()}/score.yaml`;
}

/** Where snapshots are written and looked up. */
export function backupsDir(): string {
  return `${configBase()}/backups`;
}

/**
 * The base directory an Agent reads its config from: its directory environment
 * variable when set and non-empty, otherwise its default location under home.
 */
export function agentBaseDir(agent: AgentId): string {
  const fromEnv = Bun.env[AGENT_DIR_ENV[agent]]?.trim();
  return fromEnv ?? `${Bun.env.HOME}/${AGENT_DEFAULT_DIR[agent]}`;
}

/**
 * The config file to read and write for an Agent.
 *
 * For omp, `models.yaml` is used when it exists and `models.yml` does not, so
 * an installation carrying only the longer extension is found rather than
 * bootstrapped beside it.
 */
export function agentConfigPath(agent: AgentId): string {
  const base = agentBaseDir(agent);
  if (agent === "pi") return `${base}/models.json`;

  for (const filename of OMP_FILENAMES) {
    const candidate = `${base}/${filename}`;
    if (existsSync(candidate)) return candidate;
  }
  return `${base}/${OMP_FILENAMES[0]}`;
}

/** Whether the Agent's config file is present at its resolved path. */
export function isAgentInstalled(agent: AgentId): boolean {
  return existsSync(agentConfigPath(agent));
}
