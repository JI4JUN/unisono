/**
 * Taking pi's Catalog over with what the Score compiles to.
 *
 * pi's config is JSONC — comments and trailing commas are things it accepts —
 * and its top-level keys are indented inside the document's braces rather
 * than starting at some column. So the block boundaries come from bracket
 * depth rather than from a column, which is what lets the takeover replace
 * only the `providers` block and carry every other byte of the file across
 * untouched. Re-serializing the whole document instead would strip the
 * comments, re-indent, and drop the trailing commas the user's own nodes
 * contain, and the ticket requires them preserved (criterion 2, spec §3.3 and
 * §9.1).
 *
 * The escaping is the reason this module exists separately from omp's write
 * path. pi's own resolver executes a value beginning with `!` as a shell
 * command and expands `$VAR` as an environment variable, so a value written
 * to pi that carries either would not read back as what the Score said. The
 * escape is applied on write only (spec §3.1 point 3): `!`-leading becomes
 * `$!`, and every `$` becomes `$$`.
 */

import { isListNode, isObjectNode } from "./guards";
import type { Catalog } from "./agent";

/** The top-level key the Catalog lives under. */
const CATALOG_KEY = "providers";

/**
 * Escapes a value so pi's own resolver reads it back as itself.
 *
 * The two rules apply to different things and both must survive together:
 * every `$` doubles as `$$` (pi expands `$VAR`), and a leading `!` becomes
 * `$!` (pi executes `!`-leading values as a shell command). Doubling `$`
 * first is what makes the prefix safe, because the `$` in `$!` then arrives
 * already escaped; escaping `!` first would double it a second time. So the
 * order is the whole of the rule.
 */
export function escapePiValue(value: string): string {
  const doubled = value.split("$").join("$$");
  return doubled.startsWith("!") ? `$${doubled}` : doubled;
}

/**
 * Escapes every string value pi's resolver would execute or expand.
 *
 * pi resolves values it reads, not keys, so the walk descends only into
 * values and leaves the ids and field names alone — an id beginning with `!`
 * is pi's business, and escaping it would change which provider is being
 * named. Only strings are rewritten; numbers, booleans, and nulls resolve to
 * themselves and are written as they are.
 */
export function escapePiCatalog(catalog: Catalog): Catalog {
  const escaped: Catalog = {};
  for (const [id, provider] of Object.entries(catalog)) {
    const walked = walk(provider);
    // The walk returns the provider's own shape: it was given an object, so
    // it gives one back. Guarded rather than cast, because what the walk
    // returns is `unknown` by construction.
    if (!isObjectNode(walked)) continue;
    escaped[id] = walked;
  }
  return escaped;
}

/**
 * Recursively escapes the string values a node holds.
 *
 * A node recurses into its values, a list into the nodes and strings it
 * holds, and a string is rewritten — so a nested `headers` map, a model
 * inside the `models` list, and a string item of any list are all escaped at
 * every depth, not only the top.
 */
function walk(node: Record<string, unknown> | unknown[]): unknown {
  if (isListNode(node)) {
    return node.map((item) => {
      if (typeof item === "string") return escapePiValue(item);
      return isObjectNode(item) || isListNode(item) ? walk(item) : item;
    });
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] =
      typeof value === "string"
        ? escapePiValue(value)
        : isObjectNode(value) || isListNode(value)
          ? walk(value)
          : value;
  }
  return out;
}

/**
 * pi's config with its `providers` block replaced.
 *
 * The replacement is a text splice on the document's top-level blocks, the
 * same shape as omp's (`src/sync.ts`): only the `providers` block is
 * rewritten, and every other byte of the file is carried across untouched — a
 * comment, a non-two-space indent, or a trailing comma inside the user's own
 * nodes is theirs. The rest of the document is not even re-emitted;
 * `Bun.JSONC.parse` runs only to confirm the file is one pi can read before a
 * takeover touches it.
 *
 * The block itself is written in canonical two-space JSON, so the Catalog is
 * always in one known form regardless of what the file looked like before.
 */
export function replacePiCatalogNode(existing: string, catalog: Catalog): string {
  // Parsed first so an unparseable config fails here rather than being spliced
  // over: the takeover is not the place to discover a broken file, and a
  // `readCatalog` failure is what reports it.
  const parsed: unknown = Bun.JSONC.parse(existing);
  if (!isObjectNode(parsed)) throw new Error("expected a config object at top level");

  // The Catalog is written as the canonical two-space JSON of its value; the
  // block's own key line and the document's braces are carried over from the
  // file, which is what leaves everything but the Catalog untouched.
  //
  // A block runs from the line its key starts on to the line before the next
  // top-level key starts, so the blocks are the lines that begin a member of
  // the document itself. A member at the document's own depth begins a block;
  // a member inside it is body, and never one.
  const lines = existing.split("\n");
  const depths = lineDepths(lines);
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const key = blockKey(lines[index] ?? "");
    // A block's key is the first member on its line, which is why the depth is
    // read *before* the line's own brackets are counted: the depth is that of
    // the enclosing document, not of the value the key introduces.
    if (key !== null && (depths[index] ?? 0) === 1) starts.push(index);
  }

  // The document's own closing brace is the boundary of the last block, so it
  // joins the list: without it a Catalog that is the last key would swallow
  // the brace and leave the file unparseable.
  const lastBlock = starts[starts.length - 1];
  if (lastBlock !== undefined && (depths[lastBlock] ?? 0) === 1) {
    const close = lines.findLastIndex((line) => line.trim().startsWith("}"));
    if (close > lastBlock) starts.push(close);
  }

  const catalogStart = starts.findIndex((start) => blockKey(lines[start] ?? "") === CATALOG_KEY);
  if (catalogStart === -1) {
    // No Catalog yet: the user's blocks are kept and the Catalog is appended
    // before the document's closing brace, where a top-level key belongs. Its
    // indent is the one its neighbours carry, so an odd document keeps looking
    // like itself.
    const close = lines.findLastIndex((line) => line.trim() === "}");
    if (close === -1) return `${JSON.stringify({ [CATALOG_KEY]: escapePiCatalog(catalog) }, null, 2)}\n`;
    const indent = /^\s*/.exec(lines[close - 1] ?? "")?.[0] ?? "";
    const body = indentBody(JSON.stringify(escapePiCatalog(catalog), null, 2), indent);
    return [...lines.slice(0, close), `${indent}"${CATALOG_KEY}": ${body},`, "}"].join("\n");
  }

  const from = starts[catalogStart] ?? 0;
  const to = starts[catalogStart + 1] ?? lines.length;
  const before = lines.slice(0, from).join("\n");
  const after = lines.slice(to).join("\n");
  // The separator belongs to the document, not to the block: whether the
  // replaced block ended with a comma decides whether the replacement does, so
  // the count stays the same and the file still parses. The last block before
  // the closing brace carries none either way.
  const replaced = lines.slice(from, to).join("\n").trimEnd();
  const separator = replaced.endsWith(",") && to !== lines.length ? "," : "";
  // The indent is the one the block's own key line carried, so a document that
  // indents differently keeps looking like itself — the canonical JSON is the
  // Catalog's value, and the key line is the document's.
  const indent = /^\s*/.exec(lines[from] ?? "")?.[0] ?? "";
  const body = indentBody(JSON.stringify(escapePiCatalog(catalog), null, 2), indent);
  return [before, `${indent}"${CATALOG_KEY}": ${body}${separator}`, after]
    .filter((piece) => piece.length > 0)
    .join("\n")
    .concat("\n");
}

/** The lines of `body` after the first, each prefixed with `indent`. */
function indentBody(body: string, indent: string): string {
  const lines = body.split("\n");
  return lines.map((line, index) => (index === 0 ? line : `${indent}${line}`)).join("\n");
}

/**
 * The bracket depth a line begins at, line by line.
 *
 * Depth is counted only outside strings and comments, because a `{` or `}` in
 * either belongs to the text and not to the document's structure. The depth
 * is recorded at each line's start, which is what makes a top-level key
 * detectable: it sits one level inside the document's own braces.
 */
function lineDepths(lines: string[]): number[] {
  const depths: number[] = [];
  let depth = 0;

  for (const line of lines) {
    depths.push(depth);
    let inString = false;
    let escaped = false;
    let at = 0;
    while (at < line.length) {
      const char = line[at] ?? "";
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === "/" && line[at + 1] === "/") {
        break;
      } else if (char === "{" || char === "[") {
        depth += 1;
      } else if (char === "}" || char === "]") {
        depth -= 1;
      }
      at += 1;
    }
  }

  return depths;
}

/**
 * The top-level key a line begins, or null when it begins none.
 *
 * A member at the document's own depth begins with a quoted key, and a block
 * keeps its key on the same line as its value — so a line that opens with
 * `"key":` starts a block, where a line that continues a value does not.
 * Quotes and padding are stripped so the comparison is with the bare name.
 */
function blockKey(line: string): string | null {
  const match = /^\s*(['"])([^"']*)\1\s*:/.exec(line);
  const key = match?.[2];
  return key === undefined ? null : key;
}
