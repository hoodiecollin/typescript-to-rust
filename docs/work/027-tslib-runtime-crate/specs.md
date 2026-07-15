# 027 — tslib runtime crate (specs)

Status: **FIRST SLICE LANDED** — the `tslib` crate exists, is pinned into the
generated crate, and the emitter routes three quirk-heavy methods to it under the
hybrid rule. The blocker (value-position closures) cleared in series 033. Specs:
`packages/compiler/tests/tslib.test.ts`; crate parity tests: `crates/tslib/tests/parity.rs`.

## The crate

`crates/tslib/` (workspace member, edition 2021), pinned in
`packages/compiler/rust-oracle/Cargo.toml` alongside `ts-primitives`/`tokio`:

- `array::at<T: Copy>(xs, index: f64) -> T` — JS negative-from-end indexing;
  panics out of range (loud; JS `undefined` is a later `Option` refinement).
- `string::pad_start(s, target_len: f64, pad) -> String`,
  `string::pad_end(...)` — not in std; JS pad-repeat-and-truncate semantics.

Numeric args arrive as `f64` (the translator's `number`) and are floored **inside
the crate** — the runtime coercion lives in the audited fidelity layer, never a
codegen `as usize` cast (the codegen-helper boundary; 029 §Routing principle).
All three are **`fn`s**, not macros (fn-first).

## Routing (the hybrid rule)

`tryTslibMethod` (lower.ts) routes `at`/`padStart`/`padEnd` to a `tslib::…::fn`
`call` (args carry borrows: receiver `&`, string args `&`, numbers owned).
Everything else stays a native `method` call. **Guarded by `analysis.methodNames`:**
a user-declared class method of the same name (e.g. a `Grid.at(i)`) is a native
call and is never hijacked — the collision that the first cut got wrong and this
guard fixes (also protects the `map`/`filter`/`forEach` closure routing).

## Unary operators (prerequisite for `at(-1)`)

`-x` (negation) and `!x` (logical not) are now modeled (`UnaryExpression` → a
`unary` HIR node; the emitter parenthesizes a binary/unary operand). `+x`, `~x`,
`typeof`/`void`/`delete` stay fail-loud. This also makes negative number literals
(`const x = -5`) work generally.

## Specs (differential)

- `xs.at(-1)` → `30` and the output contains `tslib::array::at`; `xs.at(1)` → `20`.
- `"5".padStart(3, "0")` → `005`; `padEnd` → `500`.
- Unary: `-5` → `-5`; `-(3 + 4)` → `-7`; `!true` → `false`.

## Next slices (off the 029 catalog)

- Array iteration `reduce`/`find`/`some`/`every` (native, closures already land).
- `sort()` (string-compare quirk) — needs receiver-mutation plumbing (in-place)
  or a documented functional form; deferred.
- `slice`/`splice`/`indexOf`, string `replace`/`split`-with-limit, Object/JSON.
- Receiver-type awareness beyond the method-name guard (a real element-type
  check) when array-vs-string method-name collisions appear.
