/**
 * Specs for series 113 — inferring a plugin call's type *through* a container
 * binding (graduates #97, the one v1 residual of the plugin system, epic #95).
 *
 * A plugin-bound intrinsic call (`leftPad(…)`) is typed by construction, so a
 * direct binding needs no annotation. This series extends that to a call nested
 * inside an **array literal** (incl. nested arrays): the type oracle resolves the
 * plugin's TS package (`typeResolvablePluginSpecifiers()`), so the series-099
 * inference tier sees the call as `string` and the binding infers with no
 * container-specific logic. An anonymous **object** literal stays fail-loud (a
 * general dialect rule — object shapes need a named struct), and resolution stays
 * specifier-anchored (a user's own `leftPad` is never hijacked). A plugin call
 * inside a `.map`/`.filter` callback is a *separate* capability (the numeric-only
 * callback-body lifter) and is out of scope here.
 *
 * IDs → docs/work/113-plugin-infer-through-containers/specs.md (PIC1–PIC6).
 */

import { describe, expect, test } from "bun:test";
import { UnsupportedError } from "../src/errors";
import { typeResolvablePluginSpecifiers } from "../src/plugins";
import { compile, defineDifferential } from "./_support/differential";

const LP = `import { leftPad } from "@ttr/plugin-leftpad";\n`;

// ── PIC1: registry scope guard ───────────────────────────────────────────────

describe("type-resolvable plugin specifiers (PIC1)", () => {
  test("PIC1 includes a pure expand-to-HIR plugin, excludes @ttr/std", () => {
    const specs = typeResolvablePluginSpecifiers();
    expect(specs).toContain("@ttr/plugin-leftpad");
    // @ttr/std is SPECIAL_LOWERED: its fallible surface must NOT auto-infer.
    expect(specs).not.toContain("@ttr/std");
  });
});

// ── PIC2 / PIC6 / PIC7: lowering + negatives (direct unit) ────────────────────

describe("plugin inference through containers (PIC2, PIC5, PIC6)", () => {
  test("PIC2 an array-literal binding of plugin calls infers (no annotation)", () => {
    const rust = compile(
      `${LP}const a = [leftPad("7", 3, "0"), leftPad("42", 4, "*")];\nconsole.log(a.join(","));`,
    );
    expect(rust).toContain("ttr_plugin_leftpad::left_pad");
    // inferred (not annotation-coerced) → Rust infers the binding type itself.
    expect(rust).toContain("vec!");
  });

  test("PIC5 an anonymous object literal binding stays fail-loud", () => {
    // Matches `const o = { a: "x" }` — object shapes need a named struct, plugin
    // or not. The 113 change must NOT relax this.
    expect(() =>
      compile(`${LP}const o = { a: leftPad("7", 3, "0") };\nconsole.log(o.a);`),
    ).toThrow(UnsupportedError);
  });

  test("PIC6 a user's own local leftPad in an array is not hijacked", () => {
    const rust = compile(
      `function leftPad(s: string): string { return s; }\nconst a = [leftPad("hi"), leftPad("yo")];\nconsole.log(a.join(","));`,
    );
    expect(rust).not.toContain("ttr_plugin_leftpad");
  });
});

// ── PIC3–PIC4: behavior parity (differential, cargo-backed) ───────────────────

defineDifferential("plugin-infer", [
  {
    name: "PIC3 array-literal binding of plugin calls joins correctly",
    src: `${LP}const a = [leftPad("7", 3, "0"), leftPad("42", 4, "*")];\nconsole.log(a.join(","));`,
    expected: "007,**42",
  },
  {
    // A template literal (not `+`) reads the nested indices: `String + String`
    // via indexed access is a pre-existing, general string-concat limitation
    // (it breaks on an annotated `string[][]` too), unrelated to inference.
    name: "PIC4 a nested array literal of plugin calls infers (Vec<Vec<String>>)",
    src: `${LP}const a = [[leftPad("7", 3, "0")], [leftPad("42", 4, "*")]];\nconsole.log(\`\${a[0][0]}\${a[1][0]}\`);`,
    expected: "007**42",
  },
]);

// A plugin call inside a `.map` callback (non-numeric callback body) is a
// separate capability — the numeric-only callback-body lifter — and is a noted
// follow-up, not part of this series.
