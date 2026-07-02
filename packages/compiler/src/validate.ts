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
 *
 * NOTE: `validate` is a no-op passthrough (mock). The real check lands in the
 * GREEN step of series 005; until then `any`/`unknown` still throw the *wrong*
 * error (`UnsupportedError`, from lowering's `default`), so the RED specs — which
 * expect `DialectError` — fail against it.
 */

import type { Program } from "./ast";

export class DialectError extends Error {
  constructor(public readonly reason: string) {
    super(`${reason} (forbidden by the dialect — see dialect.md)`);
    this.name = "DialectError";
  }
}

/**
 * Validate that `program` is within the accepted dialect.
 * @throws {DialectError} on forbidden input.
 */
export function validate(_program: Program): void {
  // mock: real enforcement lands in the GREEN step.
}
