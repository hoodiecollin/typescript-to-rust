/**
 * Specs for series 028c — the `"use arena"` per-scope directive. A leading
 * `"use arena"` opts a scope into bump allocation (`bumpalo`): a single
 * `let arena = bumpalo::Bump::new();` is injected, and `Vec` literals are built
 * from it (`bumpalo::vec![in &arena; …]`), freed all at once at scope exit.
 *
 * Soundness is by the oracle: an arena value that escapes the scope is a Rust
 * lifetime error cargo rejects — cargo *is* the escape analysis. So the no-escape
 * case behaves identically to the heap version, and escape is loud, never silent.
 * See series 028.
 */

import { describe, expect, test } from "bun:test";
import { UnsupportedError } from "../src/errors";
import { compile, defineDifferential } from "./_support/differential";

const build = `"use arena";
const xs: Array<number> = [1, 2, 3];
xs.push(4);
console.log(xs.length);`;

defineDifferential("arena-directive", [
  {
    name: "an arena-built Vec behaves as a faithful heap drop-in (no escape)",
    // Same observable result as the heap version — the arena is an allocation
    // strategy, not a semantic change, for the no-escape case.
    src: build,
    expected: "4",
  },
  {
    name: "an escaping arena value is rejected by the oracle (cargo), not miscompiled",
    // Returning the arena vec ties `Vec<'a>` to the local arena's lifetime — a
    // Rust lifetime/type error. Cargo is the escape check: loud, never silent.
    src: `function build(): Array<number> {
  "use arena";
  const xs: Array<number> = [1, 2, 3];
  return xs;
}
console.log(build().length);`,
    expectFail: true,
    extra: ({ rust }) => {
      expect(rust).toContain("bumpalo::vec!");
    },
  },
]);

describe("028c use arena", () => {
  test("emits the bump arena and its vec macro; no directive string leaks", () => {
    const rust = compile(build);
    expect(rust).toContain("let arena = bumpalo::Bump::new();");
    expect(rust).toContain("bumpalo::vec![in &arena; 1.0, 2.0, 3.0]");
    expect(rust).not.toContain('"use arena"');
  });

  test("`use arena` outside a free fn / script (a method body) fails loud", () => {
    expect(() =>
      compile(`class C {
  m(): void { "use arena"; }
}`),
    ).toThrow(UnsupportedError);
  });
});
