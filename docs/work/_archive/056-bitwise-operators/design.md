# 056 — Bitwise operators (`& | ^ ~ << >> >>>`)

> **Status: DESIGN (decided, awaiting impl).** Graduates the fail-loud deferral in
> issue #8. Dialect-shape decisions made with Collin 2026-07-09 (see **Decision**).
> Bitwise operators are currently unmodeled (`BinaryExpression` with a bitwise op,
> and `UnaryExpression` `~`, hit the default-deny path → `UnsupportedError`).

## The problem

TypeScript `number` is `f64`. JavaScript's bitwise operators don't run on floats —
the language coerces both operands to **32-bit signed integers** (`ToInt32`),
operates on 32 bits, and returns a 32-bit signed result. `>>>` is the exception:
it coerces to **32-bit *unsigned*** and yields a value up to 2³²−1.

Two forks this forces:

1. **Rust `f64` has no bitwise operators** — we must pick an integer type to emit
   them on. That is a semantics decision, not mechanical work.
2. **JS's 32-bit truncation is observable** (`(2**31) << 1 === 0`, `~5 === -6`,
   `-1 >>> 0 === 4294967295`). Any type wider than 32 bits disagrees with JS on
   these edges.

## Decision

**We deliberately do NOT mimic JS's 32-bit semantics.** The dialect defines
bitwise operators over a **wide signed integer type, `i128`**, and documents the
divergence rather than reproducing `ToInt32` truncation.

- **Type at bitwise sites: `i128`.** All six operators share one type. `i128`
  holds the `>>>` unsigned-32 result trivially and gives `<<` enough headroom that
  ordinary bit work does not overflow-panic (only past bit 127). Bitwise ops on
  `i128` are cheap (a couple of 64-bit instructions); the 128-bit cost that would
  matter for `*`/`/` is irrelevant here.
- **Divergence is surfaced, not silent.** A new **non-fatal diagnostics channel**
  emits a compiler **warning to CLI stderr** whenever bitwise ops appear, *and* an
  inline `// bitwise: wide-int (i128), not JS int32` comment at the emitted site.
  This is the first non-fatal diagnostic in a compiler that until now had only two
  outcomes (emit / fail-loud `UnsupportedError`); the channel is reusable by every
  future "accepted but divergent" case.

### Rejected alternatives

- **`i32`/`u32`, JS-exact.** Bit-exact but drags `i32`/`u32` into the lattice with
  boundary coercions everywhere; Collin explicitly does not want JS-exactness.
- **`i64`.** Native/idiomatic and still holds `>>>` results, but `<<` overflow-panics
  past bit 63 — less headroom than `i128` for no real idiom win here.
- **Demand explicit-integer operands.** Rejects the common `a & b` case; graduates
  almost nothing.

## Mechanism

### Operator mapping

| TS            | Rust                              | Notes |
|---------------|-----------------------------------|-------|
| `a & b`       | `a & b` (i128)                    | native |
| `a \| b`      | `a \| b` (i128)                   | native |
| `a ^ b`       | `a ^ b` (i128)                    | native |
| `~a`          | `!a` (i128)                       | Rust bitwise-NOT is `!`, not `~` |
| `a << b`      | `a << b` (i128)                   | native; shift count masked (see below) |
| `a >> b`      | `a >> b` (i128)                   | arithmetic (sign-propagating) — the intuitive integer `>>` |
| `a >>> b`     | `((a as u128) >> b) as i128`      | logical (zero-fill) shift via unsigned cast |

`>>>` is the only one that is **not** a plain operator rewrite — it needs the
`u128` round-trip, so it cannot be a bare `binary` HIR node.

### HIR / types

- Add `i128` to `RustType` (alongside `f64`/`usize`/`i64`).
- `& | ^ << >>` lower to the existing **`binary`** HIR node (like `036` logical
  ops), tagged so numeric typing forces the operands/result to `i128`.
- `~` lowers to the existing **`unary`** node, operator `!`, i128-typed.
- `>>>` lowers to a **dedicated HIR node** (`ushr`) carrying `{ value, shift }`,
  so the emitter can render the `u128` cast wrapper. (A `binary` node cannot carry
  the cast.)
- Every bitwise-origin node gets a `bitwise: true` marker so the emitter can attach
  the inline `//` divergence note and the lowering pass can raise the stderr warning.

### Typing pass (extends `numeric.ts`)

Mirror the existing `usize` fixpoint with an **i128 context**:

- Seed every bitwise-operator operand position as i128 context.
- An **integer-valued literal** in i128 context is tagged `i128`.
- A **fractional literal** directly as a bitwise operand → **fail loud** (cheap
  honesty; almost certainly a bug, and JS's silent `ToInt32` truncation is exactly
  what we are refusing to imitate).
- A **non-literal `f64`** flowing into a bitwise op → insert an `as i128` coercion
  (truncates; covered by the divergence warning).
- **Boundary coercions out:** an i128 bitwise result used in float arithmetic →
  `as f64`; used as an array index → `as usize`; passed to an `i64`/`usize`
  parameter → the existing reconcile path plus `as`. These reuse the coercion
  discipline already in `numeric.ts`.

### Shift-count handling

Rust panics (debug) when a shift count ≥ bit width. JS masks the count (`& 31`).
Since we are already i128 and diverging, **mask the shift count to the operand
width** at emit (`b & 127` for i128 / `>>>`) so ordinary code never panics and the
result is well-defined. A negative shift count (JS coerces) → **fail loud**.

### Emitter

- `& | ^ << >>`: two-per-operator `BINARY_PREC` rows placed per Rust binding order —
  `<< >>` (shift) tighter than `&`, then `^`, then `|`; all below `+ -` and above
  comparisons. The existing `emitOperand` associativity logic then parenthesizes
  correctly.
- `~` → `!operand` through the unary path.
- `ushr` (`>>>`) → `((<value> as u128) >> <count>) as i128`, fully parenthesized.
- When a node is `bitwise`, append `// bitwise: wide-int (i128), not JS int32` to
  the emitted line.

### Diagnostics channel (new)

- Lowering accumulates non-fatal `Warning`s on the `HirModule` (e.g.
  `module.warnings: Warning[]`).
- The CLI (`index.ts`) prints accumulated warnings to **stderr** before/after the
  emitted source (independent of `--fmt`, which only affects the source text).
- The inline `//` note is produced by the emitter from the `bitwise` marker.

## Fail-loud residuals (stay rejected)

- Fractional literal as a direct bitwise operand.
- Negative shift count.
- `BigInt` bitwise (BigInt is unmodeled anyway).

## Impl sequence

1. `RustType` + HIR: add `i128`, the `ushr` node, and the `bitwise` marker.
2. Validator: admit bitwise `BinaryExpression` / `UnaryExpression ~`.
3. Lowering: map operators (incl. `>>>` → `ushr`), attach markers.
4. `numeric.ts`: i128-context seeding, literal tagging, fractional/negative-shift
   fail-loud, boundary coercions, shift-count masking.
5. Emitter: `BINARY_PREC` rows, `!` for `~`, `ushr` template, inline note.
6. Diagnostics channel: `module.warnings`, CLI stderr surfacing.
7. RED specs → GREEN (differential oracle confirms i128 semantics; a divergence
   fixture documents a deliberately non-JS result).

## Specs sketch

- `a & b`, `a | b`, `a ^ b`, `~a` on small integers — differential-match JS.
- `a << n`, `a >> n` (arithmetic) — differential-match for in-range values.
- `a >>> n` — logical shift; a case where JS's 32-bit result and ours **diverge**,
  asserted against the *Rust* result and annotated as intended divergence.
- Shift-count masking (`1 << 130`) does not panic.
- Fractional-literal operand and negative shift count → `UnsupportedError`.
- Warning is emitted (stderr) and the inline `//` note appears in output.
- Boundary: bitwise result used as an index / in float arithmetic compiles.

## Open sub-details (resolve during impl, not dialect forks)

- Exact `BINARY_PREC` integers after inserting shift/`&`/`^`/`|` rows.
- Whether the `Warning` type is shared now or minimally stubbed for this series and
  generalized when the next divergent case needs it.
