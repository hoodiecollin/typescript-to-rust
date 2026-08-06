/**
 * Specs for series 119 — transitive `refMut` (issue #102). A borrowed param that is
 * forwarded as a bare argument into a callee's `&mut` position must itself become
 * `&mut`, and the forward must emit a bare reborrow (not `&mut q`). Design + spec IDs:
 * series 119. Cargo-compiled + differential
 * (emitted Rust runs; stdout === TS-via-Bun).
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

defineDifferential("transitive-refmut", [
  // ── Graduations (RED before impl) ────────────────────────────────────────────
  {
    name: "TR1 free-fn 2-hop &mut forward (the #102 repro)",
    src: `function inner(q: number[]): void { q.push(9); }
function outer(q: number[]): void { inner(q); }
const a: number[] = [1, 2, 3];
outer(a);
console.log(a.length, a[3]);`,
    expected: "4 9",
    extra: ({ rust }) => {
      expect(rust).toContain("fn outer(q: &mut Vec<f64>)");
      // The forward is a bare reborrow, never a double borrow.
      expect(rust).toContain("inner(q)");
      expect(rust).not.toContain("inner(&mut q)");
    },
  },
  {
    name: "TR2 free-fn 3-hop chain (fixpoint convergence)",
    src: `function push1(q: number[]): void { q.push(1); }
function mid(q: number[]): void { push1(q); }
function top(q: number[]): void { mid(q); }
const a: number[] = [10, 20];
top(a);
console.log(a.length, a[2]);`,
    expected: "3 1",
    extra: ({ rust }) => {
      expect(rust).toContain("fn top(q: &mut Vec<f64>)");
      expect(rust).toContain("fn mid(q: &mut Vec<f64>)");
      expect(rust).toContain("mid(q)");
      expect(rust).toContain("push1(q)");
    },
  },
  {
    name: "TR3 method-param 2-hop &mut forward",
    src: `function add(q: number[]): void { q.push(7); }
class Filler {
  fill(q: number[]): void { add(q); }
}
const a: number[] = [1, 2];
const f = new Filler();
f.fill(a);
console.log(a.length, a[2]);`,
    expected: "3 7",
    extra: ({ rust }) => {
      expect(rust).toContain("fn fill(&self, q: &mut Vec<f64>)");
      expect(rust).toContain("add(q)");
    },
  },
  {
    name: "TR4 forward + local direct mutation coexist (no double-borrow)",
    src: `function inner(q: number[]): void { q.push(0); }
function outer(q: number[]): void { q.push(5); inner(q); }
const a: number[] = [1];
outer(a);
console.log(a.length, a[1], a[2]);`,
    expected: "3 5 0",
    extra: ({ rust }) => {
      expect(rust).toContain("fn outer(q: &mut Vec<f64>)");
      expect(rust).toContain("inner(q)");
      expect(rust).not.toContain("inner(&mut q)");
    },
  },

  // ── Regression guards ────────────────────────────────────────────────────────
  {
    name: "TR5 read-only forward still works (unchanged &Vec path)",
    src: `function read(q: number[]): number { return q.length; }
function fwd(q: number[]): number { return read(q); }
const a: number[] = [1, 2, 3];
console.log(fwd(a));`,
    expected: "3",
    extra: ({ rust }) => {
      expect(rust).toContain("fn fwd(q: &Vec<f64>)");
      expect(rust).not.toContain("&mut");
    },
  },
  {
    name: "TR6 non-bare forward stays read-only (fresh local passed, no promotion)",
    src: `function inner(q: number[]): void { q.push(0); }
function outer(q: number[]): void { const c = q.concat([]); inner(c); }
const a: number[] = [1, 2];
outer(a);
console.log(a.length, a[0]);`,
    expected: "2 1",
    extra: ({ rust }) => {
      // `q` is read (concat), never bare-forwarded → stays `&Vec`; the fresh local
      // `c` is the one that gets `&mut c`.
      expect(rust).toContain("fn outer(q: &Vec<f64>)");
      expect(rust).toContain("inner(&mut c)");
    },
  },
]);
