# 060 — specs (class deferrals)

> **Status: SHIPPED.** Differential BDD specs live in
> `packages/compiler/tests/class-deferrals.test.ts` (compile → cargo run →
> TS-via-Bun). IDs map 1:1 to the test names.

## Specs

- **CLS1** a method reading a struct param infers `&Point` — `fn addTo(&self, p:
  &Point)`; the call site borrow-adapts to `c.addTo(&pt)` (Fork 1, reusing the
  free-fn ownership analysis over method bodies).
- **CLS2** a method mutating an array param (`xs.push(...)`) infers `&mut Vec<f64>`;
  the call site passes `f.fill(&mut arr)` (and `arr` is a `mut` local).
- **CLS3** a `static` method → an associated `fn` with no `self`; the call site
  `P.origin()` → `P::origin()`.
- **CLS4** a `static` field → an associated `const NAME: Ty = value;`; a read
  `Config.MAX` → `Config::MAX`.
- **CLS5** a getter read `r.area` → the method call `r.area()` (`fn area(&self) ->
  T`).
- **CLS6** a setter write `b.w = v` → `b.set_w(v)` (`fn set_w(&mut self, v: T)`).
- **CLS7** `public`/`private` accessibility is accepted and behaves (the emitted
  single-file binary has no cross-module visibility, so it is a semantic no-op).
- **CLS8** (fail-loud) a `protected` member is rejected with a clean
  `UnsupportedError`.

## Fail-loud residuals (unchanged)

- **Generics** (`class Box<T>`, generic methods) — its own series (Fork 2).
- **Owned-`self`** with a **non-cloneable** moved-out field (the 038 clone path
  handles the cloneable case).
- **Decorators** — permanent.
- **Implicit / non-field-init constructors** — a class without an explicit
  constructor stays fail-loud (issue-context item, not in this series' forks).
- A method param **mutated only via a field write** (`p.x = …`) infers `&T` (a
  read), so it is **cargo-loud**, matching the identical free-fn limitation — never
  a silent miscompile. Use a mutating-method form for `&mut` inference.
