/**
 * Specs for the plugin system (epic #95, series 110). A plugin **recognizes**
 * blessed valid-TS shapes (anchored to a reserved import specifier) and
 * **expands** them into **core HIR** — never text — so the emitter stays total
 * and fail-loud is preserved. The reference plugin is `@ttr/plugin-leftpad`,
 * exporting `leftPad(s, width, fill)` (JS `padStart` fidelity), which expands to
 * a `ttr_plugin_leftpad::left_pad` call into the bundled reference crate.
 * IDs → docs/work/110-plugin-system/specs.md (PLUG1–PLUG17).
 *
 * Differential (TS-via-Bun vs Rust) for the behavioral corpus; direct unit +
 * throws for the mechanism (registry, recognition guard, emitter fail-loud).
 */

import { describe, expect, test } from "bun:test";
import { emitModule } from "../src/emitter";
import { DialectError, UnsupportedError } from "../src/errors";
import type { HirModule } from "../src/hir";
import {
  type Plugin,
  pluginForSpecifier,
  registerPlugin,
} from "../src/plugins";
import { compile, defineDifferential } from "./_support/differential";

const LP = `import { leftPad } from "@ttr/plugin-leftpad";\n`;

// ── Mechanism: registry + contract completeness (PLUG4–5) ────────────────────

describe("plugin registry", () => {
  test("PLUG5 the reference plugin resolves by its owned specifier", () => {
    const p = pluginForSpecifier("@ttr/plugin-leftpad");
    expect(p).toBeDefined();
    expect(p?.exports.has("leftPad")).toBe(true);
  });

  test("PLUG5 an unregistered specifier resolves to undefined", () => {
    expect(pluginForSpecifier("@acme/nope")).toBeUndefined();
  });

  test("PLUG4 registration fails loud on a missing contract part", () => {
    const base: Plugin = {
      specifier: "@ttr/plugin-test-incomplete",
      exports: new Set(["foo"]),
      recognize: () => ({}),
      expand: () => ({ kind: "bool", value: true }),
      crate: { name: "x", manifest: "x = 1" },
    };
    expect(() => registerPlugin({ ...base, specifier: "" })).toThrow(
      DialectError,
    );
    expect(() => registerPlugin({ ...base, exports: new Set() })).toThrow(
      DialectError,
    );
    expect(() =>
      registerPlugin({ ...base, crate: { name: "", manifest: "" } }),
    ).toThrow(DialectError);
  });
});

// ── Mechanism: emitter fail-loud guard (PLUG2) ───────────────────────────────

describe("plugin emitter guard", () => {
  test("PLUG2 an unexpanded plugin node reaching the emitter fails loud", () => {
    const mod = {
      items: [],
      main: [
        {
          kind: "expr",
          expr: { kind: "plugin", owner: "@ttr/plugin-leftpad", payload: null },
        },
      ],
    } as unknown as HirModule;
    expect(() => emitModule(mod)).toThrow(UnsupportedError);
  });
});

// ── Recognition guards + import validation (PLUG6, PLUG8) ─────────────────────

describe("plugin recognition guards", () => {
  test("PLUG6 an import of an unregistered specifier fails loud", () => {
    expect(() => compile(`import { foo } from "@acme/nope";\nfoo();`)).toThrow(
      UnsupportedError,
    );
  });

  test("PLUG6 a name not exported by a registered plugin fails loud", () => {
    expect(() =>
      compile(`import { notReal } from "@ttr/plugin-leftpad";\nnotReal();`),
    ).toThrow(/notReal/);
  });

  test("PLUG8 wrong arity for leftPad fails loud (the plugin's guard)", () => {
    expect(() => compile(`${LP}console.log(leftPad("7", 3));`)).toThrow(
      /leftPad/,
    );
  });

  test("PLUG5 a user's own local leftPad (no plugin import) is untouched", () => {
    // No import from the reserved specifier → recognition never fires.
    const rust = compile(
      `function leftPad(s: string): string { return s; }\nconsole.log(leftPad("hi"));`,
    );
    expect(rust).not.toContain("ttr_plugin_leftpad");
  });
});

// ── Behavioral corpus (differential, cargo-backed) — PLUG13–16 ────────────────

defineDifferential("plugins", [
  {
    name: "PLUG13 pad the deficit with a single char",
    src: `${LP}console.log(leftPad("7", 3, "0"));`,
    expected: "007",
    extra: ({ rust }) => expect(rust).toContain("ttr_plugin_leftpad::left_pad"),
  },
  {
    name: "PLUG14 already at width is unchanged",
    src: `${LP}console.log(leftPad("42", 2, "0"));`,
    expected: "42",
  },
  {
    name: "PLUG15 a multi-char fill is cycled and truncated (padStart quirk)",
    src: `${LP}console.log(leftPad("x", 5, "ab"));`,
    expected: "ababx",
  },
  {
    name: "PLUG10/16 the result composes through the standard passes (concat, ternary, nested)",
    src: `${LP}const flag = true;
console.log(leftPad("1", 2, "0") + "/" + (flag ? leftPad("y", 4, "*") : "n") + "/" + leftPad(leftPad("z", 2, "."), 4, "."));`,
    expected: "01/***y/...z",
  },
  {
    name: "PLUG10 a plugin result binds without an annotation (typed by construction)",
    src: `${LP}const p = leftPad("7", 3, "0");
console.log(p);`,
    expected: "007",
  },
]);
