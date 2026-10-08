/**
 * Output for the plain-text CLI contract.
 *
 * Every command prints line-oriented text. Color is suppressed when stdout is
 * not a terminal or when `NO_COLOR` is set, so piped output carries no ANSI
 * escape sequences. No screen clearing, no cursor control, nothing persistent.
 */

const GLYPH = {
  ok: "✓",
  warn: "⚠",
  fail: "✗",
};

const COLOR = {
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
};

/** Color is on only for an interactive terminal that has not opted out. */
function colorEnabled(): boolean {
  if (Bun.env.NO_COLOR !== undefined) return false;
  return Bun.stdout.isTTY ?? false;
}

function paint(code: string, text: string): string {
  return colorEnabled() ? `${code}${text}${COLOR.reset}` : text;
}

export function writeOut(line: string): void {
  Bun.stdout.write(`${line}\n`);
}

export function writeErr(line: string): Promise<number> {
  return Bun.stderr.write(`${line}\n`);
}

function glyph(state: "ok" | "warn" | "fail"): string {
  const coloredKey = { ok: COLOR.green, warn: COLOR.yellow, fail: COLOR.red }[state];
  return paint(coloredKey, GLYPH[state]);
}

/** A status line: glyph, tag, path or subject, and trailing detail. */
export function line(state: "ok" | "warn" | "fail", tag: string, subject: string, detail?: string): void {
  const parts = [glyph(state), paint(COLOR.cyan, `[${tag}]`), subject];
  if (detail) parts.push(paint(COLOR.dim, detail));
  writeOut(parts.join(" "));
}

export function errorLine(text: string): Promise<number> {
  return writeErr(`${glyph("fail")} ${text}`);
}
