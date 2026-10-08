/**
 * Minimal ambient declarations for the Bun runtime surface this project uses.
 *
 * The project has zero dependencies by policy (docs/mvp-spec.md §6), so
 * `@types/bun` and `@types/node` are not installed. Only the APIs actually
 * called are declared here, with signatures matching the official
 * distributions for the pinned runtime (Bun 1.4.2).
 *
 * When a new Bun API is used, add its declaration here rather than adding a
 * dependency.
 */

interface BunFile {
  exists(): Promise<boolean>;
  text(): Promise<string>;
  stat(): Promise<{ size: number; mtime: Date | null }>;
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

  function write(path: string | URL, data: string | Uint8Array): Promise<number>;

  function sha256(data: string | Uint8Array): string;

  function spawnSync(options: SpawnSyncOptions): SpawnSyncResult;

  namespace YAML {
    function parse(input: string): unknown;
    function stringify(input: unknown, replacer?: undefined | null, space?: string | number): string;
  }

  namespace JSONC {
    function parse(input: string): unknown;
  }

  const argv: string[];
  const env: Record<string, string | undefined>;
  const stdin: { isTTY: boolean };
  const stdout: { isTTY: boolean; write(chunk: string): boolean };
  const stderr: { write(chunk: string): boolean };
  /** Absolute path of the entrypoint being run, when the module is the entrypoint. */
  const main: string | undefined;
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
  main(): unknown;
  readonly url: string;
}

declare module "bun:test" {
  export function beforeEach(fn: () => void): void;
  export function afterEach(fn: () => void): void;
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function expect(received: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: string): void;
    not: {
      toContain(expected: string): void;
      toBe(expected: unknown): void;
      toEqual(expected: unknown): void;
    };
  };
}

declare module "node:fs" {
  export function realpathSync(path: string): string;
  export function existsSync(path: string): boolean;
  export function statSync(path: string): { isFile(): boolean; isDirectory(): boolean; mode: number };
  export function mkdirSync(path: string, options: { recursive?: boolean; mode?: number }): string | undefined;
  export function chmodSync(path: string, mode: number): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function unlinkSync(path: string): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function writeFileSync(path: string, data: string | Uint8Array, options?: { mode?: number }): void;
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: "utf-8"): string;
  export function mkdtempSync(prefix: string): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, ext?: string): string;
}
