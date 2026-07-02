/**
 * Dialect validation (pipeline step 2): reject input that is *forbidden* by the
 * dialect — outside the accepted subset and always will be — before lowering.
 *
 * This is distinct from lowering's `UnsupportedError`, which flags constructs the
 * dialect *intends* but the emitter has not built yet (control flow, classes, …).
 * `DialectError` means "fix your input" (see dialect.md); `UnsupportedError` means
 * "not implemented yet". Both fail loud; they differ in what the user should do.
 *
 * This slice enforces the most central prohibition: `any` and `unknown`, which
 * defeat static lowering. Other forbidden categories (class inheritance, dynamic
 * object manipulation, escaping shared mutable aliasing) and the explicit-
 * annotation requirement are future validator slices — see docs/work.
 */

import type { Program } from "./ast";

export class DialectError extends Error {
  constructor(public readonly reason: string) {
    super(`${reason} (forbidden by the dialect — see dialect.md)`);
    this.name = "DialectError";
  }
}

/** Forbidden type keywords → the message naming them. */
const FORBIDDEN_TYPES: Record<string, string> = {
  TSAnyKeyword: "`any` type",
  TSUnknownKeyword: "`unknown` type",
};

interface AnyNode {
  type: string;
  [key: string]: unknown;
}

function isNode(x: unknown): x is AnyNode {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as AnyNode).type === "string"
  );
}

/** Depth-first walk over the whole AST, visiting every node. */
function walk(node: unknown, visit: (n: AnyNode) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const key in node) {
    if (key === "type") continue;
    walk(node[key], visit);
  }
}

/**
 * Validate that `program` is within the accepted dialect.
 * @throws {DialectError} on forbidden input.
 */
export function validate(program: Program): void {
  walk(program, (n) => {
    const reason = FORBIDDEN_TYPES[n.type];
    // `any`/`unknown` defeat static lowering — reject wherever they appear
    // (variable, parameter, return, or nested in a type argument).
    if (reason) throw new DialectError(reason);
  });
}
