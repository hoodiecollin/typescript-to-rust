/**
 * Specs for series 117 — VecDeque interop + cross-boundary propagation (issue #101,
 * the residual tail of 116/#78). Design + spec IDs:
 * docs/work/117-vecdeque-interop-propagation/{design,specs}.md. Cargo-compiled +
 * differential (emitted Rust runs; stdout === TS-via-Bun).
 *
 * Three graduations: (1) whole-program deque propagation across arg→param / return /
 * alias edges (full call-graph, mirroring ownership's refMut fixpoint); (2) Vec-only
 * ops (sort/join/concat/flat) on a deque binding routed through the existing interop
 * helpers (`deque_as_slice_mut`/`deque_to_vec`); (3) multi-arg push/unshift.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

defineDifferential("vecdeque-interop", [
  // ── Cross-boundary propagation (full call-graph) ─────────────────────────────
  {
    name: "VD1 backward param→arg: front-mutated callee param promotes the caller's arg",
    src: `function drain(q: number[]): number { return q.shift() ?? -1; }
const a: number[] = [1, 2, 3];
const first = drain(a);
console.log(first, a.length, a[0]);`,
    expected: "1 2 2",
    extra: ({ rust }) => {
      expect(rust).toContain("VecDeque");
      expect(rust).toContain("pop_front");
      expect(rust).toContain("deque_from_vec");
    },
  },
  {
    name: "VD2 forward arg→param: pass a deque into a reader fn",
    src: `function total(xs: number[]): number { let s = 0; for (const x of xs) s += x; return s; }
const a: number[] = [1, 2, 3];
a.unshift(0);
console.log(total(a));`,
    expected: "6",
  },
  {
    name: "VD3 return: a fn returning a front-mutated array types its ret VecDeque",
    src: `function make(): number[] { const q: number[] = [1, 2, 3]; q.unshift(0); return q; }
const x = make();
console.log(x.length, x[0], x[3]);`,
    expected: "4 0 3",
  },
  {
    name: "VD4 alias: a deque binding aliased keeps its class (no re-wrap)",
    src: `const a: number[] = [1, 2, 3];
a.unshift(0);
const b = a;
console.log(b.length, b[0]);`,
    expected: "4 0",
  },
  {
    name: "VD5 chained boundary: deque forwarded caller→sum1→sum2 (2 read-only hops)",
    src: `function sum2(xs: number[]): number { let s = 0; for (const x of xs) s += x; return s; }
function sum1(xs: number[]): number { return sum2(xs); }
const a: number[] = [1, 2, 3];
a.unshift(0);
console.log(sum1(a));`,
    expected: "6",
  },
  {
    name: "VD5b &mut chained boundary: deque forwarded caller→push1→pushFront (2 mut hops, #102/119)",
    src: `function pushFront(q: number[]): void { q.unshift(0); }
function push1(q: number[]): void { pushFront(q); }
const a: number[] = [1, 2, 3];
a.unshift(9);
push1(a);
console.log(a.length, a[0]);`,
    expected: "5 0",
    extra: ({ rust }) => {
      // Transitive refMut promoted the middle hop's param to `&mut`, and the forward
      // is a bare reborrow (series 119) — not a double `&mut` borrow.
      expect(rust).toContain("fn push1(q: &mut VecDeque<f64>)");
      expect(rust).toContain("pushFront(q)");
      expect(rust).not.toContain("pushFront(&mut q)");
    },
  },
  {
    name: "VD6 &mut param mutation reflects back (why full propagation, not convert-at-boundary)",
    src: `function pushFront(q: number[]): void { q.unshift(0); }
const a: number[] = [1, 2];
pushFront(a);
console.log(a.length, a[0]);`,
    expected: "3 0",
  },

  // ── Vec-only ops on a deque binding (interop wiring) ──────────────────────────
  {
    name: "VD7 sort() default on a deque → deque_as_slice_mut",
    src: `const a: number[] = [3, 1, 2];
a.unshift(10);
a.sort();
console.log(a.join(","));`,
    expected: "1,10,2,3",
    extra: ({ rust }) => expect(rust).toContain("deque_as_slice_mut"),
  },
  {
    name: "VD8 sort(comparator) on a deque",
    src: `const a: number[] = [3, 1, 2];
a.unshift(10);
a.sort((x, y) => x - y);
console.log(a.join(","));`,
    expected: "1,2,3,10",
  },
  {
    name: "VD9 join on a deque → deque_to_vec boundary",
    src: `const a: number[] = [1, 2, 3];
a.unshift(0);
console.log(a.join("-"));`,
    expected: "0-1-2-3",
    extra: ({ rust }) => expect(rust).toContain("deque_to_vec"),
  },
  {
    name: "VD10 concat on a deque receiver",
    src: `const a: number[] = [1, 2];
a.unshift(0);
const b: number[] = [3, 4];
const c = a.concat(b);
console.log(c.join(","), a.length);`,
    expected: "0,1,2,3,4 3",
  },
  {
    name: "VD11 flat on a deque-of-arrays receiver",
    src: `const a: number[][] = [[1, 2], [3, 4]];
a.unshift([0]);
const f = a.flat();
console.log(f.join(","));`,
    expected: "0,1,2,3,4",
  },
  {
    name: "VD12 sort then continued front-mutation (still a deque after make_contiguous)",
    src: `const a: number[] = [3, 1, 2];
a.unshift(10);
a.sort((x, y) => x - y);
const first = a.shift() ?? -1;
console.log(first, a.join(","));`,
    expected: "1 2,3,10",
  },

  // ── Multi-arg push / unshift ─────────────────────────────────────────────────
  {
    name: "VD13 statement multi-arg push (Vec)",
    src: `const a: number[] = [1];
a.push(2, 3);
console.log(a.length, a[1], a[2]);`,
    expected: "3 2 3",
  },
  {
    name: "VD14 value multi-arg push returns new length",
    src: `const a: number[] = [1];
const n = a.push(2, 3);
console.log(n, a.length);`,
    expected: "3 3",
  },
  {
    name: "VD15 multi-arg unshift on a deque preserves JS order",
    src: `const a: number[] = [1, 2];
a.unshift(9, 8);
console.log(a.join(","));`,
    expected: "9,8,1,2",
  },

  // ── Corpus workload: front-mutated queue → free fn → sort/join ────────────────
  {
    name: "VD-corpus work queue drained through a free fn then sorted+joined",
    src: `function process(queue: number[]): number[] {
  const out: number[] = [];
  while (queue.length > 0) {
    const item = queue.shift() ?? 0;
    out.push(item * 2);
  }
  return out;
}
const work: number[] = [3, 1, 2];
work.unshift(5);
const results = process(work);
results.sort((x, y) => x - y);
console.log(results.join(","));`,
    expected: "2,4,6,10",
  },
]);
