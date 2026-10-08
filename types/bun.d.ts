/**
 * Minimal ambient declarations for the Bun runtime surface this project uses.
 *
 * The project has zero dependencies by policy (docs/mvp-spec.md §6), so
 * `@types/bun` and `@types/node` are not installed. This file declares only
 * the APIs the code actually calls — the same policy the zero-dependency rule
 * applies to the runtime. When a new Bun API is used, add its declaration
 * here rather than adding a dependency.
 */

interface BunFile {
  text(): Promise<string>;
}

interface SpawnSyncOptions {
  cmd: string[];
  env?: Record<string, string>;
  stdout?: "pipe";
  stderr?: "pipe";
}

interface SpawnSyncResult {
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/** Reference: https://bun.sh/docs/api/file-io */
declare namespace Bun {
  function file(path: string | URL): BunFile;

  function spawnSync(options: SpawnSyncOptions): SpawnSyncResult;

  namespace YAML {
    function parse(input: string): unknown;
  }

  namespace JSONC {
    function parse(input: string): unknown;
  }

  /** SHA-256 and friends over bytes, for optimistic locking (spec §5.3). */
  class CryptoHasher {
    constructor(algorithm: "sha256");
    update(data: string | Uint8Array): CryptoHasher;
    digest(encoding: "hex"): string;
  }

  function randomUUIDv7(): string;

  const argv: string[];
  const env: Record<string, string | undefined>;
  const stdout: { isTTY: boolean; write(chunk: string): boolean };
  const stderr: { write(chunk: string): boolean };
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  /** Absolute path of the running executable; used to spawn the real CLI. */
  execPath: string;
  exit(code: number): never;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
};

interface ImportMeta {
  main: boolean;
  /** Absolute path of the containing directory. */
  dir: string;
}

declare module "bun:test" {
  export function beforeEach(fn: () => void): void;
  export function afterEach(fn: () => void): void;
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function expect(received: unknown): {
    toBe(expected: unknown): void;
    toContain(expected: string): void;
    not: { toContain(expected: string): void; toBe(expected: unknown): void };
  };
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options: { recursive?: boolean }): string | undefined;
  export function writeFileSync(path: string, data: string | Uint8Array, options?: { mode?: number }): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function realpathSync(path: string): string;
  export function lstatSync(path: string): { isSymbolicLink(): boolean };
  export function statSync(path: string): { mode: number; mtimeMs?: number };
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
}

declare module "node:os" {
  export function tmpdir(): string;
  export function homedir(): string;
}
