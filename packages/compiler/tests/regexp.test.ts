/**
 * Specs for series 101 — RegExp via the Rust `regex` crate (issue #56, Tier-3).
 *
 * A regex literal `/pat/flags` and `new RegExp("lit", "flags")` translate to a
 * `tslib::regex::Regex` **at transpile time** (the pattern is statically known),
 * validated against the finite-automaton `regex` engine: the faithful core ships,
 * and backreferences / lookaround / the sticky `y` / indices `d` flags fail loud
 * *naming the construct*. Differential specs byte-diff the Rust run against Bun
 * running the same TS; fail-loud specs assert the transpile-time throw.
 *
 * The regex is a **stateless value** in v1 (sub-decision RE-STATE): `re.test`,
 * `s.match`/`matchAll`/`replace`/`split`/`search`, and a single `re.exec` ship;
 * the stateful `exec`-loop and `re.lastIndex` fail loud → `s.matchAll(re)`.
 *
 * First run may flake while the oracle builds `regex` cold (the cargo dep
 * thundering herd) — re-run to confirm green. IDs map to series 101.
 */

import { describe, expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("regexp", [
  // ── test / flags ──────────────────────────────────────────────────────────
  {
    name: "RE-1 re.test with \\d+",
    src: `const re = /\\d+/;
console.log(re.test("abc123"));
console.log(re.test("abcdef"));`,
    expected: "true\nfalse",
    extra: ({ rust }) => {
      expect(rust).toContain("tslib::regex::Regex::new_lit");
      expect(rust).toContain(".is_match(");
    },
  },
  {
    name: "RE-2 case-insensitive flag i → (?i)",
    src: `console.log(/hello/i.test("HELLO WORLD"));`,
    expected: "true",
    extra: ({ rust }) => expect(rust).toContain("(?i)hello"),
  },
  {
    name: "RE-3 multiline m and dotAll s flags",
    src: `console.log(/^bar$/m.test("foo\\nbar\\nbaz"));
console.log(/a.b/s.test("a\\nb"));`,
    expected: "true\ntrue",
  },
  // ── match / matchAll ──────────────────────────────────────────────────────
  {
    name: "RE-4 s.match with numbered groups",
    src: `const m = "ab".match(/(\\w)(\\w)/);
console.log(m !== null);
console.log(m![0]);
console.log(m![1]);
console.log(m![2]);`,
    expected: "true\nab\na\nb",
    extra: ({ rust }) => expect(rust).toContain(".captures("),
  },
  {
    name: "RE-5 s.match with the g flag (full matches)",
    src: `const all = "a1b2c3".match(/\\d/g)!;
console.log(all.length);
console.log(all.join(","));`,
    expected: "3\n1,2,3",
    extra: ({ rust }) => expect(rust).toContain(".find_all("),
  },
  // ── replace ───────────────────────────────────────────────────────────────
  {
    name: "RE-6 replace first-only vs global",
    src: `console.log("banana".replace(/a/, "o"));
console.log("banana".replace(/a/g, "o"));
console.log("banana".replaceAll(/a/g, "o"));`,
    expected: "bonana\nbonono\nbonono",
    extra: ({ rust }) => {
      expect(rust).toContain(".replace_first(");
      expect(rust).toContain(".replace_all(");
    },
  },
  {
    name: "RE-7 numbered replacement template $1",
    src: `console.log("John Smith".replace(/(\\w+)\\s(\\w+)/, "$2 $1"));`,
    expected: "Smith John",
    extra: ({ rust }) => expect(rust).toContain("${2} ${1}"),
  },
  {
    name: "RE-8 named group capture + $<name> replacement",
    src: `const s = "2026-07-16";
const m = s.match(/(?<y>\\d{4})-(?<mo>\\d{2})-(?<d>\\d{2})/);
console.log(m!.groups!.y);
console.log(s.replace(/(?<y>\\d{4})-(?<mo>\\d{2})-(?<d>\\d{2})/, "$<d>/$<mo>/$<y>"));`,
    expected: "2026\n16/07/2026",
    extra: ({ rust }) => {
      expect(rust).toContain('.group("y")');
      expect(rust).toContain("${d}/${mo}/${y}");
    },
  },
  {
    name: "RE-9 $& whole-match replacement",
    src: `console.log("cat".replace(/cat/, "[$&]"));`,
    expected: "[cat]",
    extra: ({ rust }) => expect(rust).toContain("[${0}]"),
  },
  // ── split / matchAll / search ─────────────────────────────────────────────
  {
    name: "RE-10 s.split(re)",
    src: `const parts = "a, b,c ,  d".split(/,\\s*/);
console.log(parts.length);
console.log(parts.join("|"));`,
    expected: "4\na|b|c |d",
    extra: ({ rust }) => expect(rust).toContain(".split("),
  },
  {
    name: "RE-11 s.matchAll iteration",
    src: `let out = "";
for (const m of "a1b2".matchAll(/([a-z])(\\d)/g)) {
  out = out + m[1] + "=" + m[2] + ";";
}
console.log(out);`,
    expected: "a=1;b=2;",
    extra: ({ rust }) => expect(rust).toContain(".captures_all("),
  },
  {
    name: "RE-12 s.search(re) → char index / -1",
    src: `console.log("hello world".search(/o/));
console.log("hello".search(/z/));`,
    expected: "4\n-1",
    extra: ({ rust }) => expect(rust).toContain(".search("),
  },
  {
    name: "RE-13 new RegExp(string-literal, flags)",
    src: `const re = new RegExp("\\\\d+", "g");
console.log("x9y8".match(re)!.join(","));`,
    expected: "9,8",
    extra: ({ rust }) => expect(rust).toContain("tslib::regex::Regex::new_lit"),
  },
  // ── exec / optional group ─────────────────────────────────────────────────
  {
    name: "RE-14 single re.exec first match",
    src: `const m = /(\\d+)/.exec("abc42def");
console.log(m !== null);
console.log(m![1]);`,
    expected: "true\n42",
    extra: ({ rust }) => expect(rust).toContain(".exec("),
  },
  {
    name: "RE-15 non-participating optional group → undefined",
    src: `const m = "b".match(/(a)?(b)/);
console.log(m![1] === undefined);
console.log(m![2]);`,
    expected: "true\nb",
  },
]);

// ── Fail-loud — unsupported constructs (transpile-time, names the construct) ──

describe("101 fail-loud — unsupported RegExp constructs", () => {
  test("RE-F1 backreference in a literal pattern", () => {
    expect(() => compile(`const re = /(a)\\1/;`)).toThrow(/backreference/);
  });
  test("RE-F2 lookahead", () => {
    expect(() => compile(`const re = /a(?=b)/;`)).toThrow(/lookahead/);
  });
  test("RE-F3 lookbehind", () => {
    expect(() => compile(`const re = /(?<=a)b/;`)).toThrow(/lookbehind/);
  });
  test("RE-F4 sticky y flag", () => {
    expect(() => compile(`const re = /a/y;`)).toThrow(/sticky|y.*flag/);
  });
  test("RE-F5 d (hasIndices) flag", () => {
    expect(() => compile(`const re = /a/d;`)).toThrow(/hasIndices|indices|`d`/);
  });
  test("RE-F6 re.lastIndex access", () => {
    expect(() =>
      compile(`const re = /a/g;
re.lastIndex = 2;`),
    ).toThrow(/lastIndex/);
  });
  test("RE-F7 stateful exec loop", () => {
    expect(() =>
      compile(`const re = /\\d/g;
let m;
while ((m = re.exec("a1b2")) !== null) { console.log(m[0]); }`),
    ).toThrow(/exec.*loop|matchAll/);
  });
  test("RE-F8 runtime-variable RegExp pattern", () => {
    expect(() =>
      compile(`const p = "abc";
const re = new RegExp(p);`),
    ).toThrow(/non-literal pattern/);
  });
  test("RE-F9 function replacer", () => {
    expect(() =>
      compile(`console.log("abc".replace(/./g, (c) => c.toUpperCase()));`),
    ).toThrow(/function replacer/);
  });
  test("RE-F10 $` / $' replacement special", () => {
    expect(() =>
      compile("console.log(\"mid\".replace(/mid/, \"[$`|$']\"));"),
    ).toThrow(/before-\/after-match|replacement special/);
  });
});
