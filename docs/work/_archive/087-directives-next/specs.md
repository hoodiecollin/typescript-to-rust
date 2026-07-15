# 087 — `"use rc"` / `"use arena"` next slices (specs)

Status: **RED → GREEN.** Specs live in
`packages/compiler/tests/rc-directive-next.test.ts` (R1–R3) and
`packages/compiler/tests/arena-directive-next.test.ts` (A1–A3). Each is a
differential (compile + cargo-run + match the TS run) or a structural /
reject spec. Verified serially (one file at a time — the shared `rust-oracle`
cargo target flakes under concurrency).

## R1 — method calls on an rc binding (lock-in)

- **R1-behaves** — a `"use rc"` scope with a shared class alias and a `&mut self`
  method (`a.bump()`) + a `&self` reader (`b.get()`): the alias observes the
  mutation, cargo-green, matches TS.
- **R1-emit** — emits `a.borrow_mut().bump()` and `b.borrow().get()`; the handles
  are not `mut`; no directive string leaks.

## R2 — rc fields / params (lock-in)

- **R2-field-behaves** — a class holds another class (`Holder { child: Node }`)
  with the shared child mutated through its own handle after being stored: the
  read through the field observes the mutation; emits `child: Rc<RefCell<Node>>`,
  a `Rc::clone`/`Rc::new` field store, and a `.borrow().child.borrow()` read.
- **R2-param-behaves** — a promoted param (`fn f(x: …)` whose arg aliases a
  mutated binding) enters scope already `Rc<RefCell<T>>` and its body borrows;
  cargo-green, matches TS.

## R3 — cross-call rc values

- **R3-promoted-behaves** (lock-in) — passing a directive rc binding into an
  auto-promoted callee param clones the handle (`Rc::clone(&a)`); cargo-green.
- **R3-read-behaves** (**new**) — passing a directive rc binding into a
  *non-promoted* callee param of the inner class type (a read-only `x.v`) emits
  `readV(&a.borrow())` and is cargo-green + matches TS (both read the same value).
- **R3-mut-rejects** (residual) — a callee that mutates through a non-promoted
  by-`&mut` param, called with a directive rc binding, is **rejected by the
  oracle** (cargo) — `runRust(...).ok === false`, loud, never silent.

## A1 — arena `String` (new)

- **A1-behaves** — `const s: string = "hello"; s.length` in an arena scope builds
  `bumpalo::collections::String::from_str_in("hello", &arena)`, prints the same
  as the heap version (`5`), cargo-green.
- **A1-emit** — emits `bumpalo::collections::String::from_str_in(` and the
  `bumpalo::Bump::new()` arena; the `String` type annotation is dropped; no
  directive leak.

## A2 — nested arenas (new)

- **A2-behaves** — `const xs: number[][] = [[1,2],[3,4]]; xs.length` routes both
  levels to the arena, prints the same as heap (`2`), cargo-green.
- **A2-emit** — emits a nested `bumpalo::vec![in &arena; bumpalo::vec![in &arena;`
  — the inner literal is arena'd too, not heap `vec![`.

## A3 — arena in signatures / fields (residual)

- **A3-escape-rejects** — an arena `String` returned from a `"use arena"` fn (an
  escape into the signature) is **rejected by the oracle** (cargo lifetime
  error) — `runRust(...).ok === false`. Documents that escape is loud, not
  miscompiled (unchanged from 028c's vec-escape spec, extended to `String`).

## Directive hygiene (unchanged, spot-checked in the existing suites)

`"use rc"` / `"use arena"` in a method body → `UnsupportedError`; unknown
`"use …"` → `DialectError`; existing `rc-directive.test.ts` /
`arena-directive.test.ts` stay green.
