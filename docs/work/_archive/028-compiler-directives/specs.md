# 028 — Compiler directives (specs)

Status: **028a (`"use panic"`) + 028b (`"use rc"`) + 028c (`"use arena"`) LANDED**
(first slices). Specs: `packages/compiler/tests/directives.test.ts` (028a),
`rc-directive.test.ts` (028b), `arena-directive.test.ts` (028c). 028c's design
rationale + deferral boundary is in `arena-spike.md`.

## 028a — `"use panic"` → `throw` becomes `panic!`

Detection (`analysis.leadingDirectives`): a scope's leading string-literal
directives, in the `"use strict"` position. A free function or the top-level
script with a leading `"use panic"` is recorded in `analysis.panicScopes`.

Fallibility (`analyzeFallible`): a panic scope's own `throw`s do **not** make it
fallible, and it never becomes fallible via propagation — so its signature stays
non-`Result` and callers do not `?`. (The fixpoint excludes panic scopes.)

Lowering:
- `lowerThrow` in a panic scope emits `{ kind: "throw", panic: true }` carrying
  the raw message expr (the error class — built-in or custom — is erased).
- The emitter renders it `panic!("{}", <msg>);` (vs. the default
  `return Err(<msg>);`).
- `takeDirectives` consumes the leading directive statements so the string never
  leaks as an expression statement; it also validates them:
  - `"use panic"` — consumed (only on a free fn / script; elsewhere fail-loud).
  - `"use strict"` — consumed (JS prologue no-op).
  - `"use rc"` / `"use arena"` — `UnsupportedError` (planned, not yet).
  - any other `"use …"` — `DialectError` (never a silent no-op).

Specs (`directives.test.ts`):
- A `throw` in a `"use panic"` scope compiles and behaves on the success path
  (`42`).
- The fn is `fn risky(bad: bool) -> f64` (no `Result`), the throw is a `panic!`,
  and no `"use panic"` string leaks into the output.
- A caller stays a plain `fn main()` — no `?` on the call.
- `"use frobnicate"` → `DialectError`.

## Residual (documented, not a silent miscompile)

A `"use panic"` scope that *calls a fallible user function* still emits `?` on
that call (the `?`-wrap keys off callee fallibility, not the enclosing scope), so
it won't type-check in the non-`Result` fn — the **oracle (cargo) rejects it**
loudly. A clean `UnsupportedError` (or an `.unwrap()` bridge) would need scope
threaded into `lowerCall`; deferred. Not a silent-miscompile hole.

## 028b — `"use rc"` → `Rc<RefCell<T>>` (LANDED, first slice)

Detection (`analysis.rcScopes`): a leading `"use rc"` on a free function or the
top-level script, same prologue position as `"use panic"`. Only there —
`takeDirectives` fails loud (`UnsupportedError`) on `"use rc"` in a method body.

Refinement (`refineRc`, `src/rc.ts`): a post-lowering HIR→HIR pass over each
`"use rc"` scope's body, in document order. A binding whose declared type is a
**class** (`analysis.classes`) becomes an `Rc<RefCell<T>>`:
- `const a: C = new C(…)` → `let a: Rc<RefCell<C>> = Rc::new(RefCell::new(C::new(…)))`.
- `const b: C = a` (alias of an `rc` binding) → `Rc::clone(&a)` — a second handle.
- read `a.field` → `a.borrow().field`; write `a.field = v` → `a.borrow_mut().field = v`.
- The handle is never `mut` (RefCell = interior mutability).

Emitter: new `RustType` `rc` (`Rc<RefCell<inner>>`) and exprs `rcNew`/`rcClone`;
a `use std::rc::Rc; use std::cell::RefCell;` prelude when any appears (deep-scan,
alongside the `HashMap` import).

Specs (`rc-directive.test.ts`):
- Shared mutable aliasing behaves — writing through `a` is observed through `b`
  (a program that is an `E0382` move error *without* the directive).
- Emits the `Rc`/`RefCell` construction, `Rc::clone`, and `borrow`/`borrow_mut`
  forms; the handles are not `mut`; no directive string leaks.
- `"use rc"` in a free function scope.
- Without the directive the same alias is a move → **oracle (cargo) rejects it**.

### Residual (documented, cargo-loud — not a silent miscompile)

> **Graduated in series 087** (`docs/work/_archive/087-directives-next/`): method
> calls (`a.foo()` → `a.borrow().foo()` / `.borrow_mut()`), `rc` fields / params
> (analysis-promoted), and cross-call values (clone into a promoted param; a read
> into a non-promoted inner-class param wraps `f(&a.borrow())`) all work now. The
> remaining residual is a `refMut`/owned use of an `rc` binding into a
> non-promoted position (e.g. moving into a `Vec<T>`, or a cross-fn
> self-referential `x.v = x.v + 1` re-borrow) — still cargo-loud, never silent.

Calling a **method** on an `rc` binding (`a.foo()`) stays bare — `Rc<RefCell<C>>`
has no `C` methods, so cargo `E0599` flags it. `rc` struct fields / params,
nested-scope shadowing, and passing an `rc` value across a call boundary are
later increments. The pass is straight-line (like `ownership.ts`).

## 028c — `"use arena"` → `bumpalo` bump allocation (LANDED, first slice)

Detection (`analysis.arenaScopes`): a leading `"use arena"` on a free fn / script
(same gate as `"use rc"`; a method body fails loud).

Refinement (`refineArena`, `src/arena.ts`): a post-lowering pass over each arena
scope body. Each `array`-literal `let` init becomes `bumpalo::vec![in &arena; …]`
(new `bumpVec` HIR expr) with its **type annotation dropped** so bumpalo's
`Vec<'a, T>` lifetime is inferred — the emitter never writes `'a`. If any literal
was routed, a synthetic `let arena = bumpalo::Bump::new();` (`bumpNew`) is
prepended. `bumpalo` is pinned in `rust-oracle/Cargo.toml`.

**Soundness by the oracle:** an arena value that escapes the scope (returned,
stored past the arena's lifetime) is a Rust lifetime error cargo rejects — cargo
*is* the escape analysis, so no bespoke escape pass is needed. See
`arena-spike.md`.

Specs (`arena-directive.test.ts`):
- A no-escape arena-built `Vec` (build + `push` + `length`) behaves as a faithful
  heap drop-in (same output).
- Emits `bumpalo::Bump::new()` + `bumpalo::vec![in &arena; …]`; no directive leak.
- An **escaping** arena value (returned from a `"use arena"` fn) → the oracle
  (cargo) rejects it (`runRust(...).ok === false`) — loud, never miscompiled.
- `"use arena"` in a method body → `UnsupportedError`.

### Residual (deferred — heap or cargo-loud, never silent)

> **Graduated in series 087** (`docs/work/_archive/087-directives-next/`): arena
> `String` (`bumpalo::collections::String::from_str_in`) and **nested** arenas (a
> nested `array`/`string` literal element is recursively routed into the same
> arena) now work. Still deferred: arena boxed trees, arena values crossing a
> signature/field with an explicit `'a` (an escape → cargo lifetime error), and
> non-literal sources. Proactive escape diagnostics remain a later ergonomics
> upgrade.

Arena `String`/boxed trees, arena values crossing a signature/field with an
explicit `'a`, nested arenas, and non-literal `Vec` sources are left heap or hit
cargo. First slice is straight-line, `array`-literal `let` inits with Copy
elements. Proactive escape diagnostics (turning the cargo lifetime error into a
cleaner `UnsupportedError`) are an ergonomics upgrade for a later increment.
