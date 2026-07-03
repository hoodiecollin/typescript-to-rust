# 015 — Specs

Unit specs drive the public `emit(...)` entry (parse → lower → emit → Rust
string) and assert that a top-level `const f = (…) => …` arrow normalizes to a
free `fn`: the `fn` keyword and signature, the expression-body `return` desugar,
call-site participation, and the fail-loud rejections. The cargo-backed
COMPILES/BEHAVES proof lives in the fixture and differential test. IDs are
referenced from the test files.

## Unit — arrows via `emit` (`tests/arrow.test.ts`)

Reference program unless noted:
```ts
const sub = (a: number, b: number): number => {
  return a - b;
};
```

- **ARROW1** a top-level `const` block-body arrow emits a free `fn` (not a
  closure `let`).
  emitted Rust contains `fn sub(a: f64, b: f64) -> f64 {` and `return a - b;`,
  and **not** `let sub` nor `|a`.

- **ARROW2** an expression-body arrow desugars to `{ return <expr>; }`.
  `const add = (a: number, b: number): number => a + b;` → contains
  `fn add(a: f64, b: f64) -> f64 {` and `return a + b;`.

- **ARROW3** a normalized arrow is a module item, callable from the script with
  argument adaptation like a `function`.
  program `const inc = (n: number): number => { return n + 1; };\nconst r: number
  = inc(4);\nconsole.log(r);` → contains `fn inc(n: f64) -> f64 {`, `inc(4` in the
  generated `main`, and `println!`.

- **ARROW4 (green control)** a program with no arrow emits unchanged — a
  `function` declaration and its call are not touched by normalization.
  `function id(n: number): number { return n; }` → contains `fn id(n: f64) ->
  f64 {` and **not** `|n`.

- **ARROW5 (fail-loud)** an `async` arrow is rejected (only non-`async` arrows
  normalize; async arrows ride the async series' deferral).
  `const ping = async (): Promise<void> => { };` → `emit(...)` throws.

- **ARROW6 (fail-loud)** a `let`-bound arrow is rejected (a reassignable function
  binding needs a closure local, not a free `fn`).
  `let f = (n: number): number => { return n; };` → `emit(...)` throws.

- **ARROW7 (fail-loud)** a nested/local arrow (an arrow in value position, inside
  another function body) is rejected — normalization is top-level-only.
  `const g = (n: number): number => { const h = (m: number): number => { return m;
  }; return h(n); };` → `emit(...)` throws.

## Oracle — fixture + differential (`tests/compiler.test.ts`)

- **Tier 1 (COMPILES):** `03_functions/02_arrow` moves into `SUPPORTED`. The
  fixture (a single block-body `const` arrow) emits one free `fn`, which passes
  `cargo check --lib` (an unused fn is a `dead_code` warning, which does not fail
  `cargo check`).

- **Tier 2 (BEHAVES):** a block-body arrow and an expression-body arrow, both
  called from `main`
  ```ts
  const sub = (a: number, b: number): number => {
    return a - b;
  };
  const add = (a: number, b: number): number => a + b;
  console.log(sub(10, 3));
  console.log(add(4, 5));
  ```
  → Rust stdout equals the TS stdout (`7\n9`). Exercises the block body, the
  expression-body `return` desugar, and calls from the generated `main`.
