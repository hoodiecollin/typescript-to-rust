/**
 * Specs for series 087 — the next `"use arena"` directive slices (issue #27):
 * arena `String`, nested arenas, and the arena-in-signature/field residual.
 *
 * Mirrors the vec-literal first slice: only the *construction* differs — a
 * `string` literal becomes `bumpalo::collections::String::from_str_in(…, &arena)`
 * and a nested `array` literal element is recursively routed into the same arena.
 * `.len()`/methods exist on both bumpalo collections, so existing emission works
 * unchanged. Escape (into a signature/field) stays cargo-loud — cargo is the
 * escape analysis. See docs/work/087-directives-next/design.md.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

// ── A1: arena String ───────────────────────────────────────────────────────
const strSrc = `"use arena";
const s: string = "hello";
console.log(s.length);`;

// ── A2: nested arenas ──────────────────────────────────────────────────────
const nestedSrc = `"use arena";
const xs: Array<Array<number>> = [[1, 2], [3, 4]];
console.log(xs.length);`;

defineDifferential("arena-directive-next", [
  {
    name: "A1 an arena-built String behaves as a faithful heap drop-in (no escape)",
    src: strSrc,
    expected: "5",
  },
  {
    name: "A2 a nested arena vec behaves as a faithful heap drop-in",
    src: nestedSrc,
    expected: "2",
  },
  {
    name: "A2 an arena vec of arena strings routes both levels",
    src: `"use arena";
const xs: Array<string> = ["a", "bc"];
console.log(xs.length);`,
    expected: "2",
    extra: ({ rust }) => {
      expect(rust).toContain("bumpalo::vec![in &arena;");
      expect(rust).toContain("bumpalo::collections::String::from_str_in(");
    },
  },
  {
    // ── A3: arena values in signatures / fields (residual) ─────────────────
    // Returning the arena String ties its lifetime to the local arena — a Rust
    // lifetime error. Cargo is the escape check: loud, never silent.
    name: "A3 an escaping arena String is rejected by the oracle (cargo), not miscompiled",
    src: `function build(): string {
  "use arena";
  const s: string = "hello";
  return s;
}
console.log(build().length);`,
    expectFail: true,
    extra: ({ rust }) => {
      expect(rust).toContain("bumpalo::collections::String::from_str_in(");
    },
  },
]);

test("A1 emits from_str_in + the bump arena; the String annotation is dropped", () => {
  const rust = compile(strSrc);
  expect(rust).toContain("let arena = bumpalo::Bump::new();");
  expect(rust).toContain(
    'bumpalo::collections::String::from_str_in("hello", &arena)',
  );
  expect(rust).not.toContain("let s: String");
  expect(rust).not.toContain('"use arena"');
});

test("A2 routes both levels into the arena — the inner literal is arena'd too", () => {
  const rust = compile(nestedSrc);
  // The inner `[1, 2]` is a `bumpalo::vec![in &arena; …]`, not a heap `vec![`.
  expect(rust).toContain(
    "bumpalo::vec![in &arena; bumpalo::vec![in &arena; 1.0, 2.0]",
  );
  expect(rust).not.toContain("vec![1.0, 2.0]");
  expect(rust).not.toContain('"use arena"');
});
