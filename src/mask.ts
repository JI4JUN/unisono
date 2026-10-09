/**
 * Masking credentials for display.
 *
 * The compiled Catalog holds a plaintext `apiKey`, expanded from the Score
 * for real. It must never reach a terminal or a log in full: `unis diff`,
 * `unis sync`, and their failures all print through here (spec §2.2).
 *
 * The mask keeps the leading and trailing characters that let a human tell
 * one key from another without revealing either end of the secret.
 */

import { isListNode, isObjectNode } from "./guards";

/** How many leading characters a masked credential keeps. */
const KEY_HEAD = 5;

/** How many trailing characters a masked credential keeps. */
const KEY_TAIL = 4;

/**
 * Masks one credential as `sk-ab***12cd`.
 *
 * A value too short to keep five and four characters without overlapping is
 * starred in full — a partial reveal of a short key would be most of it.
 */
function maskKey(value: string): string {
  if (value.length < KEY_HEAD + KEY_TAIL) return "*".repeat(value.length);
  return `${value.slice(0, KEY_HEAD)}***${value.slice(-KEY_TAIL)}`;
}

/**
 * Masks every `apiKey` string in a parsed structure, recursively.
 *
 * The walk is over parsed data, so it covers the compiled Catalog (a map), an
 * individual Provider (a map holding `apiKey`), and any other shape without a
 * separate rule per place. Values that are not strings are left alone: an
 * `apiKey` holding something other than text has already failed validation.
 */
function maskCredentials(value: unknown): unknown {
  if (isListNode(value)) return value.map(maskCredentials);
  if (!isObjectNode(value)) return value;

  const masked: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(value)) {
    masked[key] = key === "apiKey" && typeof node === "string" ? maskKey(node) : maskCredentials(node);
  }
  return masked;
}

/**
 * Renders one side of a difference for display, with credentials masked.
 *
 * Masking is unconditional, not opt-in: `unis diff` renders whole Provider
 * subtrees as often as single fields, so a credential must be masked wherever
 * it surfaces — inside a whole-Provider dump exactly as much as at an
 * `apiKey` leaf. Everything that isn't a credential renders as it stands.
 *
 * The path is what distinguishes the two: a leaf at `apiKey` is a bare string
 * that `maskCredentials` — which masks keys it finds inside a map — would
 * otherwise pass through in full.
 */
export function renderValue(value: unknown, at: string): string {
  const masked = isCredentialPath(at) && typeof value === "string" ? maskKey(value) : maskCredentials(value);
  return JSON.stringify(masked) ?? String(masked);
}

/** Whether a difference path points at a credential leaf. */
function isCredentialPath(at: string): boolean {
  return at === "apiKey" || at.endsWith(".apiKey");
}
