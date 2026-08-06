/**
 * Specs for series 083 — String library methods over the unified
 * `receiverTypeOf` backbone. Native rows (STRN*) and tslib-quirk rows (STRT*).
 * Each spec differential-matches (compile → cargo run → TS-via-Bun); a `Tf` row
 * observes the JS quirk it reproduces. IDs map to
 * series 083.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

defineDifferential("library-methods-string", [
  {
    name: "STRN1 toUpperCase / toLowerCase",
    src: `const s: string = "Hello";
console.log(s.toUpperCase());
console.log(s.toLowerCase());`,
    expected: "HELLO\nhello",
    extra: ({ rust }) => {
      expect(rust).toContain(".to_uppercase()");
      expect(rust).toContain(".to_lowercase()");
    },
  },
  {
    name: "STRN2 trim / trimStart / trimEnd",
    src: `const s: string = "  hi  ";
console.log("[" + s.trim() + "]");
console.log("[" + s.trimStart() + "]");
console.log("[" + s.trimEnd() + "]");`,
    expected: "[hi]\n[hi  ]\n[  hi]",
    extra: ({ rust }) => {
      expect(rust).toContain(".trim()");
      expect(rust).toContain(".trim_start()");
      expect(rust).toContain(".trim_end()");
    },
  },
  {
    name: "STRN3 includes / startsWith / endsWith",
    src: `const s: string = "Hello World";
console.log(s.includes("World"), s.startsWith("He"), s.endsWith("ld"));
console.log(s.includes("nope"));`,
    expected: "true true true\nfalse",
    extra: ({ rust }) => {
      expect(rust).toContain(".contains(");
      expect(rust).toContain(".starts_with(");
      expect(rust).toContain(".ends_with(");
    },
  },
  {
    name: "STRN4 repeat(n)",
    src: `const s: string = "ab";
console.log(s.repeat(3));`,
    expected: "ababab",
    extra: ({ rust }) => expect(rust).toContain(".repeat("),
  },
  {
    name: "STRT1 replace — first match only (quirk)",
    // JS `replace` with a string replaces only the FIRST occurrence.
    src: `const s: string = "a-b-c";
console.log(s.replace("-", "+"));`,
    expected: "a+b-c",
    extra: ({ rust }) => expect(rust).toContain("tslib::string::replace_first"),
  },
  {
    name: "STRT2 replaceAll — all matches (native)",
    src: `const s: string = "a-b-c";
console.log(s.replaceAll("-", "+"));`,
    expected: "a+b+c",
    extra: ({ rust }) => expect(rust).toContain(".replace("),
  },
  {
    name: "STRT3 split — non-empty separator",
    src: `const s: string = "a,b,c";
const parts: Array<string> = s.split(",");
console.log(parts.length, parts[0], parts[2]);`,
    expected: "3 a c",
    extra: ({ rust }) => expect(rust).toContain("tslib::string::split"),
  },
  {
    name: "STRT4 split('') — empty separator splits into units (quirk)",
    src: `const s: string = "abc";
const cs: Array<string> = s.split("");
console.log(cs.length, cs[0], cs[2]);`,
    expected: "3 a c",
    extra: ({ rust }) => expect(rust).toContain("tslib::string::split_chars"),
  },
  {
    name: "STRT5 slice / substring / charAt (UTF-16-vs-char quirk family)",
    // substring swaps args when start>end; charAt out-of-range → "" (JS quirk).
    // The trailing empty line (charAt(100)="") is stripped by the harness trim.
    src: `const s: string = "Hello World";
console.log(s.slice(0, 5));
console.log(s.slice(-5));
console.log(s.substring(6, 11));
console.log(s.substring(11, 6));
console.log(s.charAt(1));
console.log(s.charAt(100));`,
    expected: "Hello\nWorld\nWorld\nWorld\ne",
    extra: ({ rust }) => {
      expect(rust).toContain("tslib::string::str_slice");
      expect(rust).toContain("tslib::string::substring");
      expect(rust).toContain("tslib::string::char_at");
    },
  },
  {
    name: "INF1 un-annotated getX() return resolves via the oracle tier",
    src: `function getName(): string { return "abc"; }
console.log(getName().toUpperCase());`,
    expected: "ABC",
    extra: ({ rust }) => expect(rust).toContain(".to_uppercase()"),
  },
  {
    name: "INF3 string concat where both operands are method calls (#48)",
    src: `const a: string = "x";
const b: string = "y";
console.log(a.toUpperCase() + b.toUpperCase());`,
    expected: "XY",
    extra: ({ rust }) => expect(rust).toContain("format!"),
  },
]);
