/**
 * Specs for series 079 — closure-captured containers (issue #46, split from #45).
 *
 * The dialect has no real closures: a stored arrow (`const f = () => {…}`) lifts to
 * a free `fn`, an inline callback (`.map`/`.filter`) forwards its free vars as params.
 * 079 graduates a **captured container** (Set/Map/Vec/String) in both paths, threaded
 * as an extra param borrowed **by need** — `&T` (read) or `&mut T` (owned-mutable,
 * non-aliased). A **shared/aliased** container (→ `Rc<RefCell>`) and every **escaping**
 * closure stay fail-loud (documented residuals). Scalar mutable capture is unchanged.
 *
 * Differential: emitted Rust compiles AND matches the TS run, plus emitted-text and
 * fail-loud checks. IDs map to docs/work/079-closure-captured-containers/specs.md.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("closure-captured-containers", [
  {
    name: "CC1 read-only stored capture → `&T` param, threaded",
    src: `const arr: Array<number> = [1, 2, 3];
const sum3 = (): number => arr[0] + arr[1] + arr[2];
console.log(sum3());`,
    expected: "6",
  },
  {
    name: "CC2 owned-mutable stored capture (Set) → `&mut` param per call",
    src: `const s: Set<number> = new Set<number>();
const add = (x: number): void => { s.add(x); };
add(1);
add(2);
add(2);
console.log(s.size);`,
    expected: "2",
  },
  {
    name: "CC3 owned-mutable stored capture (array push) → `&mut`",
    src: `const acc: Array<number> = [];
const push2 = (x: number): void => { acc.push(x * 2); };
push2(1);
push2(2);
console.log(acc[0], acc[1]);`,
    expected: "2 4",
  },
  {
    // A literal key sidesteps the orthogonal `&str`-param-vs-`String`-key limitation
    // (see 078/FC9) — the Map capture + threaded `&mut` is what CC4 exercises.
    name: "CC4 owned-mutable stored capture (Map) → `&mut`",
    src: `const m: Map<string, number> = new Map<string, number>();
const bump = (v: number): void => { m.set("k", (m.get("k") ?? 0) + v); };
bump(1);
bump(2);
console.log(m.get("k") ?? -1);`,
    expected: "3",
  },
  {
    name: "CC5 multiple captured containers → two threaded params",
    src: `const s: Set<number> = new Set<number>();
const acc: Array<number> = [];
const record = (x: number): void => { s.add(x); acc.push(x); };
record(1);
record(2);
console.log(s.size, acc.length);`,
    expected: "2 2",
  },
  {
    name: "CC6 read-only inline capture → `&T` forwarded",
    src: `const base: Array<number> = [10, 20];
const ys: Array<number> = [1, 2].map((x: number): number => x + base[0]);
console.log(ys[0], ys[1]);`,
    expected: "11 12",
  },
  {
    name: "CC8 captured container read AND mutated → one `&mut`",
    src: `const s: Set<number> = new Set<number>();
const addIfNew = (x: number): void => { if (!s.has(x)) { s.add(x); } };
addIfNew(1);
addIfNew(1);
addIfNew(2);
console.log(s.size);`,
    expected: "2",
  },
  {
    name: "CC14 regression: Copy-scalar inline capture unchanged (048)",
    src: `const k = 2;
const ys: Array<number> = [1, 2, 3].map((x: number): number => x * k);
console.log(ys[0], ys[1], ys[2]);`,
    expected: "2 4 6",
  },
  {
    name: "CC15 regression: non-capturing stored arrow → direct free fn",
    src: `const inc = (n: number): number => n + 1;
console.log(inc(4));`,
    expected: "5",
    extra: ({ rust }) => expect(rust).toContain("fn inc(n: f64) -> f64"),
  },
  {
    name: "CC16 regression: `.forEach` container mutation unchanged (for-loop)",
    src: `const acc: Array<number> = [];
[1, 2, 3].forEach((x: number): void => { acc.push(x); });
console.log(acc.length);`,
    expected: "3",
  },
  {
    // CC11 GRADUATED by series 099: the shared/aliased captured container used to
    // stay fail-loud only because the alias `const t = s` was **untyped** (046).
    // With inference, `t` infers `Set<number>` and the alias-Rc promotion (086)
    // fires exactly as for the annotated form (closure-rc-capture RC1) — no
    // annotation needed. Emits `Rc<RefCell<IndexSet>>` and runs correctly.
    name: "CC11 untyped alias of a captured container now infers + Rc-promotes (099)",
    src: `const s: Set<number> = new Set<number>();
const t = s;
const add = (x: number): void => { s.add(x); };
add(1);
console.log(t.size);`,
    expected: "1",
  },
]);

test("CC7 fail-loud: owned-mutable *inline* capture (numeric-surface typer)", () => {
  // The inline `liftCallback` path types its body over the numeric surface only
  // (048/057). A mutating expression body (`acc.push(x*2)`) can't be typed, and a
  // multi-statement block body isn't liftable at all — so an inline **mutable**
  // container capture stays fail-loud (the read-only inline case CC6 ships; the
  // stored-arrow path CC2/CC3/CC5 covers mutable capture). Documented residual.
  const src = `const acc: Array<number> = [];
const lens: Array<number> = [1, 2, 3].map((x: number): number => acc.push(x * 2));
console.log(acc.length);`;
  expect(() => compile(src)).toThrow();
});

test("CC9 fail-loud: escaping stored closure (returned)", () => {
  const src = `function make(): () => number {
  const arr: Array<number> = [1, 2];
  const get = (): number => arr[0];
  return get;
}
console.log(make()());`;
  expect(() => compile(src)).toThrow();
});

test("CC10 fail-loud: escaping stored closure (stored in an array)", () => {
  const src = `const s: Set<number> = new Set<number>();
const add = (x: number): void => { s.add(x); };
const fns: Array<(x: number) => void> = [];
fns.push(add);
console.log(s.size);`;
  expect(() => compile(src)).toThrow();
});

test("CC12 fail-loud: scalar mutable capture (unchanged 048)", () => {
  const src = `let n = 0;
const inc = (): void => { n++; };
inc();
console.log(n);`;
  expect(() => compile(src)).toThrow();
});

test("CC13 fail-loud: captured container reassigned wholesale", () => {
  const src = `const s: Set<number> = new Set<number>();
const reset = (): void => { s = new Set<number>(); };
reset();
console.log(s.size);`;
  expect(() => compile(src)).toThrow();
});
