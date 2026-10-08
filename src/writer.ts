/**
 * Atomic, symlink-safe, permission-correct file replacement.
 *
 * A config either holds the previous contents or the new ones; there is no
 * window where a reader sees a half-written Catalog. The mechanics, per
 * docs/mvp-spec.md §5:
 *
 * - the temporary file is created in the *real* file's directory, so the final
 *   `rename` is a directory-local atomic replace rather than a copy into place
 * - symlinks are resolved first, so the real file is replaced and the symlink
 *   still points at it afterwards; a user's link into their config survives
 * - `0600` is set on the temporary file before it is renamed into place, so a
 *   written config is never briefly world-readable
 * - the hash recorded when the file was read is re-checked immediately before
 *   the replace, so a file modified underneath a running sync aborts rather
 *   than gets overwritten
 */

import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** How an atomic replace turned out. */
export type WriteResult = { wrote: true } | { wrote: false; reason: "changed-underneath" };

/** SHA-256 of a file's bytes, or null when the file is not there to hash. */
export function hashFile(path: string): string | null {
  try {
    return new Bun.CryptoHasher("sha256").update(readFileSync(path, "utf8")).digest("hex");
  } catch {
    return null;
  }
}

/**
 * The real path a config should be written through.
 *
 * A symlink resolves to its target, so the bytes land in the real file and the
 * link survives. A dangling symlink has no target yet and falls back to the
 * link itself, which is where the bytes belong once it has been created.
 */
export function resolveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Replaces a file's contents atomically.
 *
 * `expectedSha256` is the hash recorded when the file was read; when the file
 * no longer hashes to that, the replace is refused so a concurrent edit is not
 * silently discarded. A config that did not exist before has no hash on disk,
 * and `null` matches that absence — which is how a first sync creates a file.
 */
export function atomicWrite(path: string, content: string, expectedSha256: string | null): WriteResult {
  const real = resolveRealPath(path);

  const current = hashFile(real);
  if (current !== expectedSha256) return { wrote: false, reason: "changed-underneath" };

  const temporary = join(dirname(real), `.${basename(real)}.unis-${Bun.randomUUIDv7()}`);
  writeFileSync(temporary, content, { mode: 0o600 });
  try {
    renameSync(temporary, real);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { wrote: true };
}
