/**
 * Specs for series 087 — the next `"use rc"` directive slices (issue #27):
 * method calls on an rc binding, rc fields / params, and cross-call rc values.
 *
 * The directive path and the auto-`Rc` promotion analysis (062/069/086) are
 * orthogonal and compose. Two cross-call shapes matter:
 *  - a binding the *analysis* promotes propagates to its callee param, which is
 *    also promoted → the arg clones the handle (`Rc::clone(&x)`), 069;
 *  - a binding promoted *purely by the directive* (a class local with no aliasing
 *    signal) passed to a callee whose param the analysis leaves as the inner
 *    class (`x: &Box`) → the new 087 rewrite wraps the read `show(&a.borrow())`
 *    instead of the bare `&a` that would be an `E0308` type mismatch.
 * A `refMut`/owned use into a non-promoted param stays cargo-loud (never silent).
 * See series 087.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

// ── R1: method calls on an rc binding ──────────────────────────────────────
const methodSrc = `"use rc";
class Counter {
  count: number;
  constructor(start: number) { this.count = start; }
  bump(): void { this.count = this.count + 1; }
  get(): number { return this.count; }
}
const a: Counter = new Counter(1);
const b: Counter = a;
a.bump();
console.log(b.get());`;

// ── R2: rc fields / params ─────────────────────────────────────────────────
const fieldSrc = `"use rc";
class Node { val: number; constructor(v: number) { this.val = v; } }
class Holder { child: Node; constructor(c: Node) { this.child = c; } }
const n: Node = new Node(1);
const h: Holder = new Holder(n);
n.val = 9;
console.log(h.child.val);`;

defineDifferential("rc-directive-next", [
  {
    // `a.bump()` (a `&mut self` method) mutates through the shared cell; `b.get()`
    // reads it through the alias. Both compile and the alias observes the bump.
    // (Inside the method `self` is already `&mut Counter`, so `self.count =
    // self.count + 1` is a plain field write — no RefCell re-borrow.)
    name: "R1 method calls on an rc binding route through borrow / borrow_mut",
    src: methodSrc,
    expected: "2",
  },
  {
    // `n` is stored into `h.child`, then mutated through `n` — the read through
    // the promoted field sees it (both handles alias one cell).
    name: "R2 a shared class field observes a mutation through the stored handle",
    src: fieldSrc,
    expected: "9",
  },
  {
    // The arg aliases a mutated binding, so the alias-escape analysis promotes
    // the callee param; the directive scope drives the caller-side promotion. The
    // write reads a *fresh* value (`n`), not the cell itself, so there is no
    // RefCell re-borrow.
    name: "R2 a promoted param enters scope already Rc<RefCell<T>> and borrows in its body",
    src: `"use rc";
class Box { v: number; constructor(v: number) { this.v = v; } }
function setTo(x: Box, n: number): void { x.v = n; }
const a: Box = new Box(1);
const b: Box = a;
setTo(a, 8);
console.log(b.v);`,
    expected: "8",
    extra: ({ rust }) => {
      expect(rust).toContain("fn setTo(x: Rc<RefCell<Box>>");
      expect(rust).toContain("x.borrow_mut().v = n");
    },
  },
  {
    name: "R3 passing an rc binding into a promoted callee param clones the handle",
    src: `"use rc";
class Box { v: number; constructor(v: number) { this.v = v; } }
function setTo(x: Box, n: number): void { x.v = n; }
const a: Box = new Box(1);
const b: Box = a;
setTo(a, 4);
console.log(b.v);`,
    expected: "4",
    extra: ({ rust }) => expect(rust).toContain("setTo(Rc::clone(&a)"),
  },
  {
    // `a` is promoted *purely by the directive* (a class local, no aliasing
    // signal), and `show` only reads its param — so the analysis leaves the param
    // as the inner `x: &Box`. The caller holds an `Rc<RefCell<Box>>`, so a bare
    // `&a` would be `&Rc<RefCell<Box>>` (`E0308`). The 087 rewrite wraps the read
    // `show(&a.borrow())` (a `Ref<Box>` derefs to `&Box`).
    name: "R3 (new) a read into a non-promoted callee param borrows the cell",
    src: `"use rc";
class Box { v: number; constructor(v: number) { this.v = v; } }
function show(x: Box): number { return x.v; }
const a: Box = new Box(5);
console.log(show(a));`,
    expected: "5",
    extra: ({ rust }) => {
      expect(rust).toContain("fn show(x: &Box)");
      expect(rust).toContain("show(&a.borrow())");
    },
  },
  {
    // `a` is directive-promoted (`Rc<RefCell<Box>>`); pushing it into a
    // `Vec<Box>` needs an owned `Box` moved out of the shared cell — impossible.
    // The 087 read-wrap only handles the `ref` case; an owned/`refMut` use into a
    // non-promoted position is left for the oracle (cargo) to reject. Loud, never
    // a silent miscompile.
    name: "R3 (residual) a move of a directive rc binding into a by-value collection is cargo-loud",
    src: `"use rc";
class Box { v: number; constructor(v: number) { this.v = v; } }
const a: Box = new Box(1);
const store: Array<Box> = [];
store.push(a);
console.log(store.length);`,
    expectFail: true,
  },
]);

test("R1 emits borrow_mut for the mutator and borrow for the reader", () => {
  const rust = compile(methodSrc);
  expect(rust).toContain("a.borrow_mut().bump()");
  expect(rust).toContain("b.borrow().get()");
  expect(rust).not.toContain("let mut a");
  expect(rust).not.toContain('"use rc"');
});

test("R2 emits an Rc<RefCell> field and a nested borrow read", () => {
  const rust = compile(fieldSrc);
  expect(rust).toContain("child: Rc<RefCell<Node>>");
  expect(rust).toContain("h.borrow().child.borrow().val");
  expect(rust).not.toContain('"use rc"');
});
