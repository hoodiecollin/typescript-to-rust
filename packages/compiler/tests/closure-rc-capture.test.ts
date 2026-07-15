/**
 * Specs for series 086 — closure-`Rc<RefCell>` capture (issue #46, the `Rc` row 079
 * deferred).
 *
 * 079 threads a captured container as a by-need borrow (`&T`/`&mut T`), sound only for
 * an **exclusively-owned** container. The one shape it fails loud on (CC11, the
 * `ctx.aliased` guard) is a **shared/aliased** captured mutable container: `const t = s`
 * makes `s`/`t` the same JS object, so a `&mut s` thread is unsound (Rust `s`/`t` would
 * be independent values). 086 promotes that container to `Rc<RefCell<T>>` (the settled
 * 062 model, capture-the-clone) through the **same** shared promoted-set + `refineRc`
 * that #35/#38/#45 use. The owned-mutable `&mut` path and the whole fail-loud tail
 * (escaping / stored / returned / two-level / scalar / wholesale-rebind / inline) stay.
 *
 * Differential: emitted Rust compiles AND matches the TS run, plus emitted-text and
 * fail-loud checks. IDs map to docs/work/086-closure-rc-capture/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("closure-rc-capture", [
  {
    name: "RC1 shared/aliased Set → Rc<RefCell>, read through the alias",
    src: `const s: Set<number> = new Set<number>();
const t: Set<number> = s;
const add = (x: number): void => { s.add(x); };
add(1);
add(2);
add(2);
console.log(t.size);`,
    expected: "2",
    extra: ({ rust }) => {
      expect(rust).toContain("Rc::new(RefCell::new(");
      expect(rust).toContain("Rc::clone(&s)");
      expect(rust).toContain(".borrow_mut().insert(");
      expect(rust).toContain(".borrow().len()");
    },
  },
  {
    name: "RC2 shared/aliased array (push) → Rc<RefCell<Vec>>",
    src: `const a: Array<number> = [];
const b: Array<number> = a;
const push2 = (x: number): void => { a.push(x * 2); };
push2(1);
push2(2);
console.log(b[0], b[1], b.length);`,
    expected: "2 4 2",
    extra: ({ rust }) => {
      expect(rust).toContain("Rc::new(RefCell::new(");
    },
  },
  {
    name: "RC3 shared/aliased Map (write-only) → Rc<RefCell<IndexMap>>",
    // A literal key sidesteps the orthogonal `&str`-param-vs-`String`-key limitation
    // (079/FC9) — the Map capture + shared promotion is what RC3 exercises. Write-only
    // (no read of the same cell inside the mutating call) — the read-in-mutate shape is
    // the 062 re-entrant residual, covered by RC3b.
    src: `const m: Map<string, number> = new Map<string, number>();
const n: Map<string, number> = m;
const put = (v: number): void => { m.set("k", v); };
put(1);
put(2);
console.log(n.get("k") ?? -1);`,
    expected: "2",
    extra: ({ rust }) => {
      expect(rust).toContain("Rc::new(RefCell::new(");
      expect(rust).toContain(".borrow_mut().insert(");
    },
  },
  {
    name: "RC4 mutate through closure, read through BOTH handles",
    src: `const s: Set<number> = new Set<number>();
const t: Set<number> = s;
const add = (x: number): void => { s.add(x); };
add(1);
console.log(s.size, t.size);`,
    expected: "1 1",
  },
  {
    name: "RC5 regression: owned-mutable (no alias) stays `&mut` (079 CC2)",
    src: `const s: Set<number> = new Set<number>();
const add = (x: number): void => { s.add(x); };
add(1);
add(2);
console.log(s.size);`,
    expected: "2",
    extra: ({ rust }) => {
      expect(rust).toContain("&mut");
      expect(rust).not.toContain("Rc::new");
    },
  },
  {
    name: "RC12 regression: read-only stored capture → `&` (079 CC1)",
    src: `const arr: Array<number> = [1, 2, 3];
const sum3 = (): number => arr[0] + arr[1] + arr[2];
console.log(sum3());`,
    expected: "6",
    extra: ({ rust }) => {
      expect(rust).not.toContain("Rc::new");
    },
  },
  {
    name: "RC13 regression: non-capturing arrow → direct free fn (079 CC15)",
    src: `const inc = (n: number): number => n + 1;
console.log(inc(4));`,
    expected: "5",
    extra: ({ rust }) => {
      expect(rust).toContain("fn inc(n: f64) -> f64");
    },
  },
  {
    name: "RC14 regression: `.forEach` container mutation unchanged (079 CC16)",
    src: `const acc: Array<number> = [];
[1, 2, 3].forEach((x: number): void => { acc.push(x); });
console.log(acc.length);`,
    expected: "3",
  },
]);

describe("086 closure-Rc<RefCell> capture", () => {
  test("RC3b fail-loud: re-entrant read-in-mutate over a shared Map (062 residual)", () => {
    // Under `Rc<RefCell>` sharing, `m.set(k, m.get(k) + v)` emits
    // `m.borrow_mut().insert(k, m.borrow()…)` — the mutable borrow is held across the
    // read borrow → runtime panic. The settled 062 direction is fail-loud (not a silent
    // panic): split the read into a local first. (Under 079 `&mut` threading the same
    // shape works — but that owner isn't shared. Here it is.)
    const src = `const m: Map<string, number> = new Map<string, number>();
const n: Map<string, number> = m;
const bump = (v: number): void => { m.set("k", (m.get("k") ?? 0) + v); };
bump(1);
console.log(n.get("k") ?? -1);`;
    expect(() => compile(src)).toThrow();
  });

  test("RC6 fail-loud: escaping captured-container closure (returned)", () => {
    const src = `function make(): (x: number) => void {
  const arr: Array<number> = [1, 2];
  const add = (x: number): void => { arr.push(x); };
  return add;
}
const f = make();
f(3);
console.log("ok");`;
    expect(() => compile(src)).toThrow();
  });

  test("RC7 fail-loud: escaping captured-container closure (stored in an array)", () => {
    const src = `const s: Set<number> = new Set<number>();
const t: Set<number> = s;
const add = (x: number): void => { s.add(x); };
const fns: Array<(x: number) => void> = [];
fns.push(add);
console.log(t.size);`;
    expect(() => compile(src)).toThrow();
  });

  test("RC8 fail-loud: capture through two closure levels", () => {
    const src = `const s: Set<number> = new Set<number>();
const t: Set<number> = s;
const outer = (): void => {
  const inner = (x: number): void => { s.add(x); };
  inner(1);
};
outer();
console.log(t.size);`;
    expect(() => compile(src)).toThrow();
  });

  test("RC9 fail-loud: scalar mutable capture (unchanged 048)", () => {
    const src = `let n = 0;
const inc = (): void => { n++; };
inc();
console.log(n);`;
    expect(() => compile(src)).toThrow();
  });

  test("RC10 fail-loud: captured container reassigned wholesale", () => {
    const src = `const s: Set<number> = new Set<number>();
const t: Set<number> = s;
const reset = (): void => { s = new Set<number>(); };
reset();
console.log(t.size);`;
    expect(() => compile(src)).toThrow();
  });

  test("RC11 fail-loud: owned-mutable *inline* capture (079 CC7)", () => {
    const src = `const acc: Array<number> = [];
const lens: Array<number> = [1, 2, 3].map((x: number): number => acc.push(x * 2));
console.log(acc.length);`;
    expect(() => compile(src)).toThrow();
  });
});
