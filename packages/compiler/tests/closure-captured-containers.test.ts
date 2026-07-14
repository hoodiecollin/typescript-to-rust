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

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program, src);
}

function runTs(src: string): string {
  const proc = Bun.spawnSync(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(src),
  });
  return new TextDecoder().decode(proc.stdout).trim();
}

async function behaves(src: string, expected: string): Promise<void> {
  const rust = compile(src);
  const rr = await runRust(rust);
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe(runTs(src));
  expect(rr.stdout.trim()).toBe(expected);
}

describe("079 closure-captured containers", () => {
  test("CC1 read-only stored capture → `&T` param, threaded", async () => {
    const src = `const arr: Array<number> = [1, 2, 3];
const sum3 = (): number => arr[0] + arr[1] + arr[2];
console.log(sum3());`;
    await behaves(src, "6");
  });

  test("CC2 owned-mutable stored capture (Set) → `&mut` param per call", async () => {
    const src = `const s: Set<number> = new Set<number>();
const add = (x: number): void => { s.add(x); };
add(1);
add(2);
add(2);
console.log(s.size);`;
    await behaves(src, "2");
  });

  test("CC3 owned-mutable stored capture (array push) → `&mut`", async () => {
    const src = `const acc: Array<number> = [];
const push2 = (x: number): void => { acc.push(x * 2); };
push2(1);
push2(2);
console.log(acc[0], acc[1]);`;
    await behaves(src, "2 4");
  });

  test("CC4 owned-mutable stored capture (Map) → `&mut`", async () => {
    // A literal key sidesteps the orthogonal `&str`-param-vs-`String`-key limitation
    // (see 078/FC9) — the Map capture + threaded `&mut` is what CC4 exercises.
    const src = `const m: Map<string, number> = new Map<string, number>();
const bump = (v: number): void => { m.set("k", (m.get("k") ?? 0) + v); };
bump(1);
bump(2);
console.log(m.get("k") ?? -1);`;
    await behaves(src, "3");
  });

  test("CC5 multiple captured containers → two threaded params", async () => {
    const src = `const s: Set<number> = new Set<number>();
const acc: Array<number> = [];
const record = (x: number): void => { s.add(x); acc.push(x); };
record(1);
record(2);
console.log(s.size, acc.length);`;
    await behaves(src, "2 2");
  });

  test("CC6 read-only inline capture → `&T` forwarded", async () => {
    const src = `const base: Array<number> = [10, 20];
const ys: Array<number> = [1, 2].map((x: number): number => x + base[0]);
console.log(ys[0], ys[1]);`;
    await behaves(src, "11 12");
  });

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

  test("CC8 captured container read AND mutated → one `&mut`", async () => {
    const src = `const s: Set<number> = new Set<number>();
const addIfNew = (x: number): void => { if (!s.has(x)) { s.add(x); } };
addIfNew(1);
addIfNew(1);
addIfNew(2);
console.log(s.size);`;
    await behaves(src, "2");
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

  test("CC11 fail-loud: shared/aliased captured container (→ Rc row, deferred)", () => {
    const src = `const s: Set<number> = new Set<number>();
const t = s;
const add = (x: number): void => { s.add(x); };
add(1);
console.log(t.size);`;
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

  test("CC14 regression: Copy-scalar inline capture unchanged (048)", async () => {
    const src = `const k = 2;
const ys: Array<number> = [1, 2, 3].map((x: number): number => x * k);
console.log(ys[0], ys[1], ys[2]);`;
    await behaves(src, "2 4 6");
  });

  test("CC15 regression: non-capturing stored arrow → direct free fn", async () => {
    const src = `const inc = (n: number): number => n + 1;
console.log(inc(4));`;
    await behaves(src, "5");
    expect(compile(src)).toContain("fn inc(n: f64) -> f64");
  });

  test("CC16 regression: `.forEach` container mutation unchanged (for-loop)", async () => {
    const src = `const acc: Array<number> = [];
[1, 2, 3].forEach((x: number): void => { acc.push(x); });
console.log(acc.length);`;
    await behaves(src, "3");
  });
});
