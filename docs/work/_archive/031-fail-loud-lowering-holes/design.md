# 031 — Close the fail-loud lowering holes surfaced by 030

## Problem

Series 030 (comprehensive fixture expansion) probed deep-nesting candidates
through the Rust oracle and surfaced three cases where the compiler emits
**plausible-but-broken Rust** that only `cargo check` rejects — the compiler
itself is happy. That is exactly the fail-loud hole series 024 closed for
forbidden *flags*, but at the *lowering/refinement* level: a modeled node in a
shape we mistranslate. A translator that silently emits wrong Rust is worse than
one that refuses (plan.md, 024). This series closes the three holes — fixing them
where cheap, failing loud (`UnsupportedError`) where a full fix is out of scope.

Probed 2026-07-06 (all four call shapes emit broken Rust for gap A):

| Gap | Trigger | Emitted today | cargo |
|---|---|---|---|
| A | `f(arr, 1)` where `f`'s param infers `usize` | `f(&arr, 1.0)` | E0308 |
| C | `const box = …` (Rust keyword ident) | `let box = …` | parse error |
| E | `m["b"] = 2` on a `Record`/HashMap | `m["b"] = 2.0` | E0594 |

## A — integer-arg retyping across call boundaries

**Cause.** Numeric inference (`numeric.ts`) retypes an index-forced *parameter* to
`usize` (and a `switch` discriminant to `i64`), but the *arguments* at those
positions keep `f64`. The `i64` match-promotion already reconciles its own call
args (`collectIntegerCallArgs`); the `usize` path never did, and neither reaches
methods/constructors.

**Fix (cheap, sound).** A new module pass `propagateIntegerParams` runs after all
param retyping. It resolves each call's callee signature — free functions and
constructors by callee string (`f`, `Class::new`), methods by resolving the
receiver's class (ident bound to a `struct` type, or `self` → enclosing class) —
and at every `usize`/`i64` parameter position:

- an **integer literal** argument retypes to match (`1.0` → `1`); **the fix.**
- a **fractional literal** (or negative into `usize`) → `UnsupportedError`.
- a **non-literal** argument → `UnsupportedError` ("inter-procedural integer
  inference not yet supported"), *except* a `usize`-typed identifier passed to a
  `usize` parameter, which is already sound and passes through.

The non-literal rejection is the honest fail-loud: propagating integer-ness
*backward* into caller variables is real inter-procedural inference (task #8),
not this series. Passing an integer literal — the common case — now works; a
computed/f64 argument refuses loudly instead of emitting `f(x)` that cargo
rejects. An unresolved method receiver (a chained/computed receiver) is left
untouched — a rare, documented residual.

## C — Rust-keyword identifier hygiene

**Cause.** A TS identifier that is a Rust keyword (`box`, `move`, `type`, `match`,
`fn`, `loop`, `ref`, `impl`, …) is emitted verbatim; `let box = …` is a Rust
parse error.

**Fix (cheap, sound).** Escape identifiers that collide with a Rust keyword using
Rust **raw identifiers** (`r#box`) at every emit site that renders a name —
bindings, params, fields, function/struct names, call callees, member/field
access. A small set of keywords cannot be raw (`crate`, `self`, `Self`, `super`,
`extern`) — those (and the reserved `_`) → `UnsupportedError` (fail loud). Applied
as a single normalization at the emitter boundary so it can't be forgotten at one
site. (Std-type *shadowing*, e.g. a user `struct Box`, is a separate, non-crashing
concern — noted, not addressed here.)

## E — HashMap index-assignment → `.insert`

**Cause.** `m["b"] = 2` lowers to an index-assignment (`m["b"] = 2.0`), but Rust's
`Index` on `HashMap` is read-only; writes need `.insert(k, v)`. Reads (`m["a"]`)
are fine.

**Fix (cheap, sound).** In lowering, an assignment whose target is a computed
member on a HashMap-typed object lowers to a `method` call
`m.insert(k, v)` instead of an `assign` to an `index`. A `Vec` index-assignment
(`arr[i] = x`, valid Rust via `IndexMut`) is unchanged. When the target object's
type can't be resolved to `Vec`/`HashMap`, fail loud rather than guess.

## Non-goals

- Backward (caller-variable) integer inference — task #8.
- std-type shadow renaming (`struct Box`) — separate.
- Parens/precedence (gap D) — folds into 026.
- Nested struct literals (gap B) — task #20 / series 032.
