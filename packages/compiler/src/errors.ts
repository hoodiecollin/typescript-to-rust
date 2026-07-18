/**
 * The two fail-loud error kinds, in one dependency-free module so both the
 * `validate` gate and the `lower` gate can throw either without an import cycle.
 *
 * The distinction is deliberate and user-facing (see validate.ts / lower.ts):
 *   - `DialectError` — "fix your input". The construct is *forbidden* by the
 *     accepted dialect subset and will never be translated as written: `any`/
 *     `unknown`, decorators, `declare` (ambient), Proxy/Reflect, an unrecognized
 *     `"use …"` directive, assignment to a `readonly` field.
 *   - `UnsupportedError` — "not implemented yet". The construct is *intended* but
 *     the compiler has not built it: a node type not yet modeled, a modeled node
 *     in a shape lowering doesn't handle, or a feature whose lowering is designed
 *     but unbuilt (async generators, `for await`, `abstract` classes, and the
 *     ownership/borrow "fail-loud residuals"). These graduate in a later series.
 */

/** Forbidden by the dialect — the input must change. */
export class DialectError extends Error {
  constructor(public readonly reason: string) {
    super(`${reason} (forbidden by the dialect — see dialect.md)`);
    this.name = "DialectError";
  }
}

/** Within the intended dialect, but not lowered yet. */
export class UnsupportedError extends Error {
  constructor(
    public readonly node: { type: string; start?: number; end?: number },
  ) {
    super(`Unsupported ${node.type} (the dialect does not implement this yet)`);
    this.name = "UnsupportedError";
  }
}
