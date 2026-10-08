/**
 * Taking omp's Catalog over with what the Score compiles to.
 *
 * The takeover is wholesale (docs/adr/0001): after a sync the Catalog holds
 * exactly what the Score compiles to and nothing else. Everything else in the
 * config — `modelOverrides`, anything else the user keeps at the top level — is
 * the user's, and a sync leaves it exactly as it found it.
 *
 * That preservation is why this module splices text rather than rebuilding the
 * document from parsed data: reparsing and re-emitting would re-quote, rewrap,
 * and reorder the user's own keys, and the ticket requires them preserved
 * byte-for-byte. Only the `providers` block is replaced, and it is emitted in
 * canonical form — comments inside it are an accepted loss.
 */

import type { Catalog } from "./agent";

/** The top-level key the Catalog lives under. */
const CATALOG_KEY = "providers";

/**
 * Replaces the `providers` block of an omp config, leaving every other
 * top-level key's text untouched.
 *
 * A top-level key starts at column 0, so the blocks can be split on lines
 * matching `^<key>:`; a block scalar's body is always indented under its key
 * and so never begins a block of its own. Where the block sits matters only
 * for the reader, so the replacement keeps the first occurrence's position and
 * appends when the config has no Catalog yet.
 */
export function replaceCatalogNode(existing: string, catalog: Catalog): string {
  const canonical = Bun.YAML.stringify({ [CATALOG_KEY]: catalog }, null, 2).replace(/\s+$/, "");

  const lines = existing.split("\n");
  // A top-level key starts at column 0; a block scalar's body is indented
  // under its key, so it never begins a block of its own.
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (blockKey(lines[index] ?? "") !== null) starts.push(index);
  }

  const catalogStart = starts.findIndex((start) => blockKey(lines[start] ?? "") === CATALOG_KEY);
  if (catalogStart === -1) {
    const kept = starts
      .map((start, at) => lines.slice(start, starts[at + 1] ?? lines.length).join("\n"))
      .filter((piece) => piece.length > 0);
    return [...kept, "", canonical].join("\n");
  }

  const before = starts[catalogStart] ?? 0;
  const after = starts[catalogStart + 1] ?? lines.length;
  return [lines.slice(0, before).join("\n"), canonical, lines.slice(after).join("\n")]
    .filter((piece) => piece.length > 0)
    .join("\n");
}

/**
 * The key a line begins a top-level block with, or null when it begins none.
 *
 * The key must start at column 0 and not be a comment, which is what separates
 * a real top-level block from an indented line — the body of a block scalar, a
 * list entry, or a continuation — that merely happens to contain a colon. A
 * quoted or space-padded key is still that block's key, so surrounding quotes
 * and trailing whitespace are stripped before it is compared.
 */
function blockKey(line: string): string | null {
  const match = /^([^\s#][^\n:]*):/.exec(line);
  const key = match?.[1];
  if (key === undefined) return null;
  return key.replaceAll('"', "").replaceAll("'", "").trim();
}
