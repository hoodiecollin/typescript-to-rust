# 086 — specs (RED → GREEN)

Differential BDD: emitted Rust **compiles** AND its stdout **matches the TS run** (via
`runRust` + a `bun run -` reference), plus emitted-text and fail-loud assertions. Test
file: `packages/compiler/tests/closure-rc-capture.test.ts`.

The graduating case is the **direct-call shared/aliased captured mutable container** — the
`Rc<RefCell>` row 079 deferred (CC11). The owned-mutable (`&mut`) path and the whole
fail-loud tail are **preserved**.

## Graduating (were fail-loud in 079 → now run)

- **RC1 — shared/aliased Set, read through the alias.**
  ```ts
  const s: Set<number> = new Set<number>();
  const t = s;
  const add = (x: number): void => { s.add(x); };
  add(1); add(2); add(2);
  console.log(t.size);
  ```
  → both promote to `Rc<RefCell<IndexSet<f64>>>`; `add` lifts to `__arrow_n` taking the
  cell by clone; body `s.borrow_mut().insert(x)`; `t.borrow().len()` = `2`. Differential.
  Emitted-text: `Rc::new(RefCell::new(`, `Rc::clone(&s)`, `.borrow_mut().insert(`.

- **RC2 — shared/aliased array (push).**
  ```ts
  const a: Array<number> = [];
  const b = a;
  const push2 = (x: number): void => { a.push(x * 2); };
  push2(1); push2(2);
  console.log(b[0], b[1], b.length);
  ```
  → `Rc<RefCell<Vec<f64>>>`; `2 4 2`. Differential.

- **RC3 — shared/aliased Map.**
  ```ts
  const m: Map<string, number> = new Map<string, number>();
  const n = m;
  const bump = (v: number): void => { m.set("k", (m.get("k") ?? 0) + v); };
  bump(1); bump(2);
  console.log(n.get("k") ?? -1);
  ```
  → `Rc<RefCell<IndexMap<String, f64>>>`; `3`. Differential.

- **RC4 — mutate through closure, read through BOTH handles.**
  ```ts
  const s: Set<number> = new Set<number>();
  const t = s;
  const add = (x: number): void => { s.add(x); };
  add(1);
  console.log(s.size, t.size);
  ```
  → `1 1` (one cell, two handles). Differential.

## Preserved — owned-mutable stays `&mut` (079 regression, NOT promoted)

- **RC5 — owned-mutable Set (no alias) stays `&mut IndexSet`.**
  ```ts
  const s: Set<number> = new Set<number>();
  const add = (x: number): void => { s.add(x); };
  add(1); add(2);
  console.log(s.size);
  ```
  → `2`; **not** promoted. Emitted-text: contains `&mut`, does **not** contain `Rc::new`.

## Fail-loud tail (reject-specs, `toThrow`)

- **RC6 — escaping captured-container closure (returned).** `function make(){ const arr=[1,2]; const add=(x)=>{arr.push(x)}; return add; } …` → throws (env outlives call).
- **RC7 — escaping captured-container closure (stored in an array).** `fns.push(add)` where `add` captures a container → throws.
- **RC8 — two-level capture.** A closure capturing a var captured by an outer closure → throws.
- **RC9 — scalar mutable capture (unchanged 048).** `let n = 0; const inc = () => { n++ }` → throws.
- **RC10 — wholesale container rebind inside the closure.** `const reset = () => { s = new Set() }` → throws.
- **RC11 — inline mutable capture (079 CC7, numeric-surface).** `[1,2,3].map(x => acc.push(x*2))` → throws.

## Regression (byte-for-byte / behavior unchanged)

- **RC12 — read-only stored capture (079 CC1).** `const sum3 = () => arr[0]+arr[1]+arr[2]` → `&`-threaded, unchanged.
- **RC13 — non-capturing arrow → direct free fn (079 CC15).** `const inc = (n) => n+1` → `fn inc(n: f64) -> f64`, unchanged.
- **RC14 — `.forEach` container mutation (079 CC16).** for-loop lowering, unchanged.
