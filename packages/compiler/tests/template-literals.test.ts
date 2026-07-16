/**
 * Specs for series 095 — template literals `` `hi ${x}` `` → JS-faithful string
 * building. Design + spec IDs: docs/work/095-template-literals/{design,specs}.md.
 * Differentials (emitted Rust runs; stdout === TS-via-Bun) unless a plain `test()`
 * fail-loud pin.
 *
 * Covers: plain (no holes), string/number/bool/expression scalar holes, escapes,
 * typed-position, nesting; and the JS-fidelity interpolations Collin chose —
 * arrays → `join(",")`, plain structs → `[object Object]`, optionals → `undefined`,
 * union enums → their `Display` inner; plus tagged-template and nested-array /
 * Map fail-loud residuals.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("template-literals", [
  // ── scalar holes (the common case) ─────────────────────────────────────────
  {
    name: "TMPL1 plain template, no interpolation",
    src: "console.log(`plain text`);",
    expected: "plain text",
  },
  {
    name: "TMPL2 single string interpolation",
    src: `const name: string = "Ada";
console.log(\`hi \${name}\`);`,
    expected: "hi Ada",
  },
  {
    name: "TMPL3 number interpolation, leading hole",
    src: `const count: number = 3;
console.log(\`\${count} items\`);`,
    expected: "3 items",
  },
  {
    name: "TMPL4 adjacent string holes",
    src: `const a: string = "x";
const b: string = "y";
console.log(\`\${a}-\${b}\`);`,
    expected: "x-y",
  },
  {
    name: "TMPL5 multiple mixed scalar holes + literal chunks",
    src: `const who: string = "world";
const n: number = 2;
console.log(\`hello \${who}, you are #\${n} today\`);`,
    expected: "hello world, you are #2 today",
  },
  {
    name: "TMPL6 boolean interpolation",
    src: `const b: boolean = true;
console.log(\`flag=\${b}\`);`,
    expected: "flag=true",
  },
  {
    name: "TMPL7 expression hole (arithmetic)",
    src: `const n: number = 5;
console.log(\`sum=\${n + 1}\`);`,
    expected: "sum=6",
  },
  {
    name: "TMPL8 escapes in cooked text round-trip",
    src: `const n: number = 1;
console.log(\`a"b\\\\c\\ttab=\${n}\`);`,
    expected: 'a"b\\c\ttab=1',
  },

  // ── typed position + nesting ───────────────────────────────────────────────
  {
    name: "TMPL9 template in a typed const position",
    src: `const n: number = 42;
const s: string = \`v=\${n}\`;
console.log(s);`,
    expected: "v=42",
  },
  {
    name: "TMPL10 template nested inside another template",
    src: `const inner: string = "z";
const n: number = 9;
console.log(\`outer[\${\`in-\${inner}\`}]=\${n}\`);`,
    expected: "outer[in-z]=9",
  },

  // ── JS-fidelity interpolations (Collin's decision) ─────────────────────────
  {
    name: "TMPL11 number-array interpolation → JS join",
    src: `const xs: number[] = [1, 2, 3];
console.log(\`\${xs}\`);`,
    expected: "1,2,3",
    extra: ({ rust }) => expect(rust).toContain("tslib::array::join"),
  },
  {
    name: "TMPL12 string-array interpolation",
    src: `const names: string[] = ["a", "b", "c"];
console.log(\`[\${names}]\`);`,
    expected: "[a,b,c]",
  },
  {
    name: "TMPL13 plain-struct interpolation → [object Object]",
    src: `interface Point { x: number; y: number; }
const p: Point = { x: 1, y: 2 };
console.log(\`\${p}\`);`,
    expected: "[object Object]",
  },
  {
    name: "TMPL14 optional interpolation, present",
    src: `const maybe: number | undefined = 5;
console.log(\`x=\${maybe}\`);`,
    expected: "x=5",
  },
  {
    name: "TMPL15 optional interpolation, absent → undefined",
    src: `const maybe: number | undefined = undefined;
console.log(\`x=\${maybe}\`);`,
    expected: "x=undefined",
    extra: ({ rust }) => expect(rust).toContain("fmt_opt"),
  },
  {
    name: "TMPL16 union-enum interpolation renders Display inner",
    src: `type SN = string | number;
const u: SN = "hi";
console.log(\`val=\${u}\`);`,
    expected: "val=hi",
  },
]);

test("TMPL-FL1 tagged template is fail-loud", () => {
  const src = `function tag(strings: TemplateStringsArray): string { return strings[0]; }
console.log(tag\`hi\`);`;
  expect(() => compile(src)).toThrow();
});

test("TMPL-FL2 nested/object-element array interpolation is fail-loud", () => {
  const src = `const xss: number[][] = [[1], [2]];
console.log(\`\${xss}\`);`;
  expect(() => compile(src)).toThrow(/nested.*array|object array/);
});

test("TMPL-FL3 Map interpolation is fail-loud", () => {
  const src = `const m: Map<string, number> = new Map<string, number>();
console.log(\`\${m}\`);`;
  expect(() => compile(src)).toThrow(/template interpolation/);
});
