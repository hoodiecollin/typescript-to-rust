/**
 * Specs for series 041 — `Object.keys`/`values` over `IndexMap`-backed records.
 * JS objects iterate in insertion order, so the `Record` backing type is
 * `indexmap::IndexMap` (not `HashMap`) and `Object.keys(m)[i]` is deterministic.
 * Differential: emitted Rust compiles (linking `indexmap`) AND matches the TS
 * run. IDs map to specs.md.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";
import { UnsupportedError } from "../src/emitter";

const REC3 = `const m: Record<string, number> = { "a": 1, "b": 2, "c": 3 };`;

defineDifferential("object-methods", [
  {
    name: "OBJ1 Object.keys preserves insertion order",
    src: `${REC3}
const ks: Array<string> = Object.keys(m);
console.log(ks[0], ks[1], ks[2]);`,
    expected: "a b c",
    extra: ({ rust }) => expect(rust).toContain(".keys().cloned().collect"),
  },
  {
    name: "OBJ2 Object.values preserves insertion order",
    src: `${REC3}
const vs: Array<number> = Object.values(m);
console.log(vs[0], vs[1], vs[2]);`,
    expected: "1 2 3",
  },
  {
    name: "OBJ3 Object.keys(m).length is the entry count",
    src: `${REC3}
console.log(Object.keys(m).length);`,
    expected: "3",
  },
]);

test("OBJ4 a record module imports IndexMap, not HashMap", () => {
  const rust = compile(`${REC3}\nconsole.log(Object.keys(m)[0]);`);
  expect(rust).toContain("use indexmap::IndexMap;");
  expect(rust).not.toContain("std::collections::HashMap");
});

// Object.entries graduated in series 043; Object.assign in 044. An unknown
// Object static stays fail-loud.
test("OBJ5 an unknown Object static is fail-loud", () => {
  expect(() =>
    compile(`${REC3}\nconst f = Object.freeze(m);`),
  ).toThrow(UnsupportedError);
});
