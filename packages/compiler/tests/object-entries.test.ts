/**
 * Specs for series 043 — Object.entries over IndexMap records. for-of
 * destructuring `for (const [k, v] of Object.entries(m))` → `for (k, v) in
 * m.iter()`; a stored `const es = Object.entries(m)` is `Vec<(String, V)>` with
 * `es[i][0]`/`es[i][1]` → tuple `.0`/`.1`. Differential + shape. IDs → specs.md.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

const REC3 = `const m: Record<string, number> = { "a": 1, "b": 2, "c": 3 };`;

defineDifferential("object-entries", [
  {
    name: "ENT1 iterates pairs in insertion order",
    src: `${REC3}
for (const [k, v] of Object.entries(m)) {
  console.log(k, v);
}`,
    expected: "a 1\nb 2\nc 3",
    extra: ({ rust }) => expect(rust).toContain("for (k, v) in m.iter()"),
  },
  {
    name: "ENT3 a stored entries binding drives destructuring too",
    src: `${REC3}
const es = Object.entries(m);
for (const [k, v] of es) {
  console.log(k, v);
}`,
    expected: "a 1\nb 2\nc 3",
  },
  {
    name: "ENT4 pair index → tuple field; length works",
    src: `${REC3}
const es = Object.entries(m);
console.log(es[0][0], es[0][1], es.length);`,
    expected: "a 1 3",
    extra: ({ rust }) => {
      expect(rust).toContain(".0");
      expect(rust).toContain(".1");
    },
  },
]);

test("ENT5 the entries value is the iter().map().collect() chain", () => {
  expect(
    compile(`${REC3}\nconst es = Object.entries(m);\nconsole.log(es.length);`),
  ).toContain(".iter().map(|(k, v)| (k.clone(), v.clone())).collect");
});

test("ENT6 a plain array-destructuring binding now compiles (graduated in 097)", () => {
  // Series 097 graduates array-over-Vec: elements bind `Option<T>` (OOB → `None`).
  expect(() =>
    compile(`const xs: Array<number> = [1, 2];\nconst [a, b] = xs;\nconsole.log(a, b);`),
  ).not.toThrow();
});
