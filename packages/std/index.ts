/**
 * `@t2r/std` — the blessed TS-side standard-shim surface (series 084, epic #52).
 *
 * These functions are **intrinsics**: the compiler recognizes them *by the
 * reserved import specifier* `"@t2r/std"` and lowers each to a known Rust
 * target. The TS bodies here exist so the differential oracle (which runs the
 * input TS under Bun) executes real, faithful behavior that matches the Rust the
 * compiler emits. A user's own `parseJson`/`stringifyJson` imported from
 * anywhere else is *not* hijacked — recognition keys off this specifier only.
 *
 * Tier A (thin typed wrappers → direct serde / std lowering). Tier B (schema
 * validation) is a later, separate graduation — do not couple to this file.
 */

/**
 * The result of a {@link parseJson} call — a tagged union carrying either the
 * deserialized value or the error string. Mirrors the Rust `tslib::json::ParseResult<T>`
 * the compiler lowers to (a generic enum with `.ok`, `.value`, `.error`).
 *
 * On the TS side this is a discriminated union so `if (r.ok) { r.value }` narrows
 * exactly as the Rust `match`/accessor pair does.
 */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * `parseJson<T>(s)` — a **typed** replacement for `JSON.parse`. The type moves to
 * the call site (`parseJson<Point>(s)`), giving the emitter a concrete
 * `serde_json::from_str::<Point>` target — no `any`. `T` must be a modeled
 * struct/enum (or a primitive/array/record of them); an unconstrained `T` stays
 * fail-loud in the compiler.
 *
 * Returns a {@link ParseResult}: `{ ok: true, value }` on success, `{ ok: false,
 * error }` on a parse/shape error (serde's structural deserialize *is* the
 * validation). Never throws — the error is in-band, matching the Rust
 * `Result`-mapped lowering.
 */
export function parseJson<T>(s: string): ParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(s) as T };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * `stringifyJson(v)` — a replacement for `JSON.stringify`. Lowers to the
 * serde_json-backed writer (the series-045 fidelity machinery, moved behind the
 * shim): integrals print without a trailing `.0`, fractions use the
 * shortest-round-trip form, `Infinity`/`NaN` → `null`.
 *
 * **Accepted JS divergence:** a `None`/optional field renders `null` where JS
 * omits the key (the 066 `null ≡ undefined` collapse). Documented, not fixed
 * here (provenance-carrying faithful omission is a future config knob, epic #52).
 */
export function stringifyJson<T>(v: T): string {
  return JSON.stringify(v);
}
