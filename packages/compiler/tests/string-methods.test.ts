/**
 * Specs for series 098 — the everyday-stuff campaign's final item. Graduates the
 * remaining common `String.prototype` methods over the 083 `receiverTypeOf` gate
 * (indexOf/lastIndexOf/at/1-arg-pad/concat/split-limit/substr), switches string
 * `.length` to a char count, and converts the deferred UTF-16 / RegExp / locale
 * surface from cargo-loud to a clean transpiler fail-loud. IDs map to
 * docs/work/098-string-methods/specs.md.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("string-methods", [
  {
    name: "SM1 indexOf — position and -1 sentinel",
    src: `const s: string = "abracadabra";
console.log(s.indexOf("b"), s.indexOf("z"));`,
    expected: "1 -1",
    extra: ({ rust }) => expect(rust).toContain("tslib::string::index_of"),
  },
  {
    name: "SM2 indexOf(x, from) — skips earlier matches",
    src: `const s: string = "abracadabra";
console.log(s.indexOf("a", 2));`,
    expected: "3",
  },
  {
    name: "SM3 lastIndexOf — last occurrence and -1 sentinel",
    src: `const s: string = "abracadabra";
console.log(s.lastIndexOf("a"), s.lastIndexOf("z"));`,
    expected: "10 -1",
    extra: ({ rust }) => expect(rust).toContain("tslib::string::last_index_of"),
  },
  {
    name: "SM4 at — negative-from-end, consumed via ??",
    src: `const s: string = "hello";
console.log(s.at(0) ?? "?", s.at(-1) ?? "?");`,
    expected: "h o",
    extra: ({ rust }) => {
      expect(rust).toContain("tslib::string::str_at");
      expect(rust).toContain(".unwrap_or(");
    },
  },
  {
    name: "SM5 at out-of-range → None → prints undefined (066)",
    src: `const s: string = "hi";
const c = s.at(10);
console.log(c);`,
    expected: "undefined",
    extra: ({ rust }) => expect(rust).toContain("fmt_opt"),
  },
  {
    name: "SM6 at result narrows with `!== undefined`",
    src: `const s: string = "hello";
const last = s.at(-1);
if (last !== undefined) {
  console.log(last.toUpperCase());
} else {
  console.log("none");
}`,
    expected: "O",
    extra: ({ rust }) => expect(rust).toContain("if let Some"),
  },
  {
    name: "SM7 padStart/padEnd — 1-arg default-space",
    src: `const s: string = "42";
console.log("[" + s.padStart(5) + "]");
console.log("[" + s.padEnd(5) + "]");`,
    expected: "[   42]\n[42   ]",
    extra: ({ rust }) => {
      expect(rust).toContain("tslib::string::pad_start");
      expect(rust).toContain("tslib::string::pad_end");
    },
  },
  {
    name: "SM8 concat — variadic join",
    src: `const a: string = "foo";
console.log(a.concat("bar", "baz"));`,
    expected: "foobarbaz",
    extra: ({ rust }) => expect(rust).toContain("format!"),
  },
  {
    name: "SM9 split(sep, limit) — truncates to limit pieces",
    src: `const s: string = "a,b,c,d";
const parts: Array<string> = s.split(",", 2);
console.log(parts.length, parts[0], parts[1]);`,
    expected: "2 a b",
    extra: ({ rust }) => expect(rust).toContain("tslib::string::split_limit"),
  },
  {
    name: "SM10 split('', limit) — empty-sep + limit",
    src: `const s: string = "abcd";
const cs: Array<string> = s.split("", 2);
console.log(cs.length, cs[0], cs[1]);`,
    expected: "2 a b",
    extra: ({ rust }) => expect(rust).toContain("tslib::string::split_chars_limit"),
  },
  {
    name: "SM11 substr — from-end start and length count",
    src: `const s: string = "hello";
console.log(s.substr(2));
console.log(s.substr(1, 2));
console.log(s.substr(-2));`,
    expected: "llo\nel\nlo",
    extra: ({ rust }) => expect(rust).toContain("tslib::string::substr"),
  },
  {
    name: "SM12 length — char count, not bytes (non-ASCII BMP)",
    // "héllo" is 6 bytes but 5 chars — the value alone proves char-count (not a byte
    // `.len()`), and the shape asserts the `.chars().count()` emit.
    src: `const s: string = "héllo";
console.log(s.length);`,
    expected: "5",
    extra: ({ rust }) => expect(rust).toContain("chars().count()"),
  },
]);

test("SM-FL1 fail-loud: charCodeAt (UTF-16 fork deferred)", () => {
  const src = `const s: string = "abc";
console.log(s.charCodeAt(0));`;
  expect(() => compile(src)).toThrow(/UTF-16|charCodeAt|code unit/i);
});

test("SM-FL2 fail-loud: codePointAt (UTF-16 fork deferred)", () => {
  const src = `const s: string = "abc";
console.log(s.codePointAt(0));`;
  expect(() => compile(src)).toThrow(/UTF-16|codePointAt|code point/i);
});

test("SM-FL3 fail-loud: String.fromCharCode static (UTF-16 fork deferred)", () => {
  const src = `console.log(String.fromCharCode(65));`;
  expect(() => compile(src)).toThrow(/UTF-16|fromCharCode/i);
});

test("SM-FL4 fail-loud: match (RegExp deferred)", () => {
  const src = `const s: string = "abc";
console.log(s.match("b"));`;
  expect(() => compile(src)).toThrow(/RegExp|regex|match/i);
});

test("SM-FL5 fail-loud: localeCompare (locale not modeled)", () => {
  const src = `const s: string = "abc";
const t: string = "abd";
console.log(s.localeCompare(t));`;
  expect(() => compile(src)).toThrow(/locale/i);
});
