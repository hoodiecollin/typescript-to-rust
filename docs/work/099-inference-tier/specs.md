# 099 — Inference tier · specs

Each `INF*` row is a differential (compile → `cargo run` → compare stdout to
Bun-run TS): an **un-annotated** binding or return type must infer, re-validate to
a modeled `RustType`, emit, and behave byte-identically to the annotated form.
Each `INF-FL*` row is a transpiler fail-loud pin — an un-annotated position whose
inferred type is **outside the accepted surface** (or a parameter, which stays
required) must throw the exact message quoted. Maps to
`tests/inference-tier.test.ts`.

## Supported (differentials — inference lands on a modeled type)

| ID | Source shape | Infers → | Observes |
|---|---|---|---|
| INF1 | `const doubled = xs.map(x => x * 2);` (`xs: number[]`, no binding annotation) | `vec<f64>` | compiles + prints the same doubled array as Bun (inference through `.map`'s built-in signature) |
| INF2 | `` const greeting = `hi ${name}`; `` (`name: string`, no annotation) | `String` | template-literal binding infers `string` → `String`; prints identically |
| INF3 | `function area(w: number, h: number) { return w * h; }` (no return annotation) | `-> f64` | inferred `-> f64` return; caller prints identical product |
| INF4 | `class C { m: Map<string, number>; size() { return this.m.size; } }` (no method return annotation) | `-> f64` | inferred method return; `.size` count prints identically |
| INF5 | `function pick(xs: string[]) { return xs.find(x => x.length > 2); }` (no return annotation) | `-> option<String>` | inferred nullish return (`string | undefined`) → `Option`; `undefined`/value prints via 066 model |
| INF6 | `const entries = greet(); console.log(entries[0]);` where `greet(): string` (binding infers a **declared** call return) | `String` | binding infers a named/modeled return type; prints identically |
| INF7 | un-annotated `let i = 0; for (…) { arr[i++] … }` (index counter) | `f64` → **`usize`** | inferred `number` enters as `f64`, `numeric.ts` refines the index counter to `usize` (no `1.0`, no cast) — same as an annotated `let i = 0` |
| INF8 | `const p: Point = …; const found = pts.find(p => p.x === 0);` (no `found` annotation, `Point` a declared struct) | `option<struct Point>` | inferred `Point | undefined` → `Option<Point>`; prints identically |

INF7 pins the §4 numeric-intent invariant: inference is provenance-free by the time
`numeric.ts` runs, so an inferred index counter refines to `usize` exactly like an
annotated one. An inferred `number` in an f64-mixing binary (`n = s.length`) keeps
the **pre-existing** `usize`-in-f64 residual (`dialect.md` numeric table) — not
graduated here, same fail-loud as annotated code.

## Fail-loud (pins — inferred type out of surface, or a parameter)

| ID | Source shape | Rejects with |
|---|---|---|
| INF-FL1 | un-annotated `const pair = [1, "a"];` (inferred **tuple** `[number, string]`) | `binding 'pair' without a type annotation` (tuple not modeled → gate returns null → existing throw) |
| INF-FL2 | un-annotated `const fn = (x: number) => x + 1;` (inferred **function type**) | `binding 'fn' without a type annotation` |
| INF-FL3 | un-annotated `const o = { a: 1, b: "x" };` (inferred **anonymous object** type, no declared name) | `binding 'o' without a type annotation` |
| INF-FL4 | un-annotated `const u = cond ? 1 : "x";` (inferred **wide union** `number | string`) | `binding 'u' without a type annotation` |
| INF-FL5 | un-annotated fn whose body returns a tuple `function pair() { return [1, "a"]; }` | `function 'pair' without a return type annotation` |
| INF-FL6 | un-annotated method returning an anonymous object | `method '<name>' without a return type annotation` |
| INF-FL7 | **parameter** stays required: `function f(x) { return x + 1; }` | `parameter 'x' without a type annotation` (no inference — implicit-`any`; hard boundary) |
| INF-FL8 | **default param** stays required: `function f(x = 5) { … }` (no type on `x`) | `default param 'x' without a type annotation` |
| INF-FL9 | inferred **`any`** binding (init whose type is `any` from an un-modeled source) | `` `any` type `` (DialectError — never silently accepted) |

## Regression (no behavior change where it must not change)

| ID | Source shape | Must stay |
|---|---|---|
| INF-R1 | fully-annotated module (every binding/return typed) | byte-for-byte today's emit; the lazy lib program is **never built** (no inference query fires) |
| INF-R2 | `lower(program)` with **no source threaded** (`typeOracle` null) | an un-annotated binding still throws today's `binding '<name>' without a type annotation` (no oracle → no inference), exactly as before 099 |
| INF-R3 | a bare-identifier `Map` receiver / `Object.entries(…)` binding (existing by-construction exemptions) | unchanged — the pre-check short-circuits before the oracle; same emit as today |
