/**
 * Canonical runtime guards for data parsed from external files.
 *
 * Values read out of YAML or JSONC files arrive as `unknown`, so their
 * shape is a runtime fact, not a compile-time one. Guards live here rather
 * than being redefined at each call site; they narrow to object-ness only,
 * and the fields are handled with the type checks they need at use.
 */

/** Whether a parsed value is a key-value object rather than an array or a primitive. */
export function isObjectNode(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a parsed value is a list. */
export function isListNode(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
