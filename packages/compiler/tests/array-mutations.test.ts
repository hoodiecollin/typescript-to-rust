/**
 * Specs for series 116 — array mutation methods (issue #78). Design + spec IDs:
 * docs/work/116-array-mutations/{design,specs}.md. Differentials (emitted Rust runs;
 * stdout === TS-via-Bun).
 *
 * Ground truth (verified 2026-07-24): `push` (statement) and `pop` already lower
 * correctly (AM1–AM4, characterization). New work: `shift`/`unshift` → `VecDeque`
 * (container-classification), `splice` → a tslib helper, and the `push`/`unshift`
 * return-value (new length) block-expr.
 */

import { defineDifferential } from "./_support/differential";

defineDifferential("array-mutations", [
  // ── Vec arrays: push/pop (characterization — already green) ──────────────────
  {
    name: "AM1 push (statement) appends",
    src: `const a: number[] = [];
a.push(1); a.push(2);
console.log(a.length, a[0], a[1]);`,
    expected: "2 1 2",
  },
  {
    name: "AM2 pop → Option, threaded through 066 ??",
    src: `const a: number[] = [1, 2];
const x = a.pop() ?? -1;
console.log(x, a.length);`,
    expected: "2 1",
  },
  {
    name: "AM3 pop on empty → undefined parity",
    src: `const a: number[] = [];
const x = a.pop();
console.log(x);`,
    expected: "undefined",
  },
  {
    name: "AM4 push non-Copy (string[]) + pop moves owned String",
    src: `const s: string[] = [];
s.push("x"); s.push("y");
const last = s.pop() ?? "";
console.log(last, s.length);`,
    expected: "y 1",
  },

  // ── VecDeque arrays: shift/unshift (front mutation → VecDeque) ────────────────
  {
    name: "AM5 shift → pop_front on a VecDeque",
    src: `const a: number[] = [1, 2, 3];
const x = a.shift() ?? -1;
console.log(x, a.length, a[0]);`,
    expected: "1 2 2",
    extra: ({ rust }) => {
      // container promoted to VecDeque
      if (!/VecDeque/.test(rust)) throw new Error("expected VecDeque in emit");
    },
  },
  {
    name: "AM6 unshift → push_front on a VecDeque",
    src: `const a: number[] = [1];
a.unshift(0);
console.log(a.length, a[0], a[1]);`,
    expected: "2 0 1",
  },
  {
    name: "AM7 push+shift FIFO queue (both → VecDeque back/front)",
    src: `const q: number[] = [];
q.push(1); q.push(2); q.push(3);
const first = q.shift() ?? -1;
const second = q.shift() ?? -1;
console.log(first, second, q.length);`,
    expected: "1 2 1",
  },
  {
    name: "AM8 index + iter + adapter on a VecDeque array",
    src: `const a: number[] = [1, 2, 3];
a.unshift(0);
let sum = 0;
for (const x of a) sum += x;
console.log(a.length, a[0], sum);`,
    expected: "4 0 6",
  },

  // ── splice (full support via tslib helper) ───────────────────────────────────
  {
    name: "AM14 splice remove → returns removed, mutates receiver",
    src: `const a: number[] = [1, 2, 3, 4];
const removed = a.splice(1, 2);
console.log(removed.join(","), a.join(","));`,
    expected: "2,3 1,4",
  },
  {
    name: "AM15 splice remove+insert",
    src: `const a: number[] = [1, 2, 3];
const removed = a.splice(1, 1, 9, 8);
console.log(removed.join(","), a.join(","));`,
    expected: "2 1,9,8,3",
  },
  {
    name: "AM16 splice insert-only (deleteCount 0)",
    src: `const a: number[] = [1, 2, 3];
a.splice(2, 0, 5);
console.log(a.join(","));`,
    expected: "1,2,5,3",
  },

  // ── return values ────────────────────────────────────────────────────────────
  {
    name: "AM18 push returns new length when consumed",
    src: `const a: number[] = [1];
const n = a.push(2);
console.log(n);`,
    expected: "2",
  },
  {
    name: "AM19 unshift returns new length (VecDeque binding)",
    src: `const a: number[] = [1];
const n = a.unshift(0);
console.log(n, a[0]);`,
    expected: "2 0",
  },
]);
