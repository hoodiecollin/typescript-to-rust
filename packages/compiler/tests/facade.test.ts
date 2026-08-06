/**
 * Specs for the `ttr facade` generator (series 122, child of 121 / issue #118).
 * The oracle here is not TTR's usual TS-vs-Rust differential — a codegen tool is
 * validated against a **checked-in rustdoc-JSON fixture** (the captured
 * `--output-format json` of `crates/ttr-facade-fixture`, the generator's analog of
 * `@ttr/plugin-leftpad`) plus **one live integration spec** that reshells nightly
 * rustdoc and asserts the fixture is still current, skipping loudly without it.
 * IDs → series 122 (FAC1–FAC15).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FACADE_FORMAT_VERSION,
  FacadeError,
  emitFacade,
  generateFacade,
} from "../src/facade";
import {
  hasNightlyRustdocJson,
  obtainRustdocJson,
  parseFacadeArgs,
  runFacade,
} from "../src/facade-cli";

const FIXTURE_PATH = join(
  import.meta.dir,
  "fixtures",
  "facade",
  "ttr-facade-fixture.rustdoc.json",
);
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CRATE = "ttr-facade-fixture";
const COMBINE = "ttr_facade_fixture::Combine";

function fixtureJson(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

function model(allowTraits: string[] = []) {
  return generateFacade(fixtureJson(), { crate: CRATE, allowTraits });
}

// ── §1 CLI + invocation (FAC1–FAC3) ──────────────────────────────────────────

describe("facade CLI + invocation", () => {
  test("FAC1 writes exactly two artifacts under --out", async () => {
    const writes = new Map<string, string>();
    const dirs: string[] = [];
    const result = await runFacade([CRATE, "--out", "gen"], {
      loadRustdoc: async () => fixtureJson(),
      writeFile: (p, c) => writes.set(p, c),
      mkdir: (d) => dirs.push(d),
      log: () => {},
    });
    expect(writes.size).toBe(2);
    expect(writes.has(join("gen", `${CRATE}.d.ts`))).toBe(true);
    expect(writes.has(join("gen", `${CRATE}.facade.json`))).toBe(true);
    expect(dirs).toContain("gen");
    expect(result.dtsPath).toBe(join("gen", `${CRATE}.d.ts`));
  });

  test("FAC2 <crate>@<version> pins the source; header records name/version/format", async () => {
    const args = parseFacadeArgs([`${CRATE}@1.2.3`, "--out", "gen"]);
    expect(args.crate).toBe(CRATE);
    expect(args.version).toBe("1.2.3");

    let table: string | undefined;
    await runFacade([`${CRATE}@1.2.3`], {
      loadRustdoc: async () => fixtureJson(),
      writeFile: (p, c) => {
        if (p.endsWith(".facade.json")) table = c;
      },
      mkdir: () => {},
      log: () => {},
    });
    const header = JSON.parse(table!);
    expect(header.crate).toBe(CRATE);
    expect(header.version).toBe("1.2.3");
    expect(header.formatVersion).toBe(FACADE_FORMAT_VERSION);
  });

  test("FAC3 a missing nightly rustdoc capability fails loud (non-zero exit)", async () => {
    let caught: unknown;
    try {
      await obtainRustdocJson(CRATE, {
        cwd: REPO_ROOT,
        spawn: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "error: toolchain 'nightly' is not installed",
        }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FacadeError);
  });

  test("FAC3 an unspawnable toolchain fails loud naming the toolchain", async () => {
    let caught: unknown;
    try {
      await obtainRustdocJson(CRATE, {
        cwd: REPO_ROOT,
        spawn: async () => {
          throw new Error("spawn cargo ENOENT");
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FacadeError);
    expect((caught as Error).message).toMatch(/nightly/);
  });
});

// ── §2 format_version pinning (FAC4) ─────────────────────────────────────────

describe("facade format_version gate", () => {
  test("FAC4 a differing format_version throws naming both versions", () => {
    const doc = {
      ...(fixtureJson() as Record<string, unknown>),
      format_version: 999,
    };
    expect(() => generateFacade(doc, { crate: CRATE })).toThrow(FacadeError);
    try {
      generateFacade(doc, { crate: CRATE });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("999");
      expect(msg).toContain(String(FACADE_FORMAT_VERSION));
    }
  });
});

// ── §3 resolution: re-export, macro method, alias error (FAC5–FAC7) ──────────

describe("facade resolution", () => {
  test("FAC5 a cross-crate pub use maps to its canonical path + one owned type", () => {
    const gadget = model().types.find((t) => t.ts === "Gadget");
    expect(gadget).toBeDefined();
    expect(gadget!.path).toBe("ttr_facade_fixture_inner::Gadget");
    expect(gadget!.reexport).toBe(true);
    expect(emitFacade(model()).dts).toContain("export declare class Gadget");
  });

  test("FAC6 a macro-generated method appears with a resolved signature", () => {
    const raw = model().methods.find((m) => m.ts === "Widget.raw");
    expect(raw).toBeDefined();
    expect(raw!.path).toBe("ttr_facade_fixture::Widget::raw");
    expect(raw!.receiver).toBe("&self");
    expect(raw!.ret).toBe("number");
  });

  test("FAC7 a Result-alias return is fallible with the resolved error path", () => {
    const scale = model().methods.find((m) => m.ts === "Widget.try_scale");
    expect(scale!.fallible).toBe(true);
    expect(scale!.error).toBe("ttr_facade_fixture::Error");
    expect(scale!.ret).toBe("Widget");
  });
});

// ── §4 borrow + shape mapping (FAC8–FAC10) ───────────────────────────────────

describe("facade borrow + shape mapping", () => {
  test("FAC8 receiver + per-param borrow shapes are recorded", () => {
    const combine = model().methods.find((m) => m.ts === "Widget.combine")!;
    expect(combine.receiver).toBe("&self");
    expect(combine.params).toEqual([
      { name: "rhs", ts: "Widget", borrow: "&" },
      { name: "n", ts: "number", borrow: "owned" },
    ]);
    const bump = model().methods.find((m) => m.ts === "Widget.bump")!;
    expect(bump.receiver).toBe("&mut self");
  });

  test("FAC9 a pub struct becomes one owned TS type mapped to its crate path", () => {
    const widget = model().types.find((t) => t.ts === "Widget")!;
    expect(widget.kind).toBe("struct");
    expect(widget.path).toBe("ttr_facade_fixture::Widget");
    expect(widget.reexport).toBe(false);
  });

  test("FAC10 associated ctor + enum unit variants map to namespaced entries", () => {
    const empty = model().methods.find((m) => m.ts === "Widget.empty")!;
    expect(empty.receiver).toBe("static");

    const mode = model().types.find((t) => t.ts === "Mode")!;
    expect(mode.kind).toBe("enum");
    expect(mode.variants).toEqual([
      { ts: "Fast", path: "ttr_facade_fixture::Mode::Fast" },
      { ts: "Slow", path: "ttr_facade_fixture::Mode::Slow" },
    ]);
    const dts = emitFacade(model()).dts;
    expect(dts).toContain("export declare namespace Mode");
    expect(dts).toContain("const Fast: Mode;");
  });
});

// ── §5 fail-loud on unmappable items (FAC11–FAC12) ───────────────────────────

describe("facade fail-loud on unmappable items", () => {
  test("FAC11 a generic method is reported (never faked, never silently skipped)", () => {
    const m = model();
    const reject = m.rejects.find(
      (r) => r.path === "ttr_facade_fixture::Widget::cast",
    );
    expect(reject).toBeDefined();
    expect(m.methods.some((x) => x.name === "cast")).toBe(false);
    const dts = emitFacade(m).dts;
    expect(dts).not.toContain("cast");
    expect(dts).not.toContain("any");
  });

  test("FAC12 a trait method is absent unless --allow-trait names it, and no others", () => {
    expect(model().methods.some((m) => m.ts === "Widget.merged")).toBe(false);

    const allowed = model([COMBINE]);
    expect(allowed.methods.some((m) => m.ts === "Widget.merged")).toBe(true);
    for (const noise of [
      "into",
      "from",
      "borrow",
      "borrow_mut",
      "type_id",
      "try_from",
    ]) {
      expect(allowed.methods.some((m) => m.name === noise)).toBe(false);
    }
  });
});

// ── §6 output validity + determinism (FAC13–FAC15) ───────────────────────────

describe("facade output validity + determinism", () => {
  test("FAC13 the emitted .d.ts type-checks under tsc --noEmit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "facade-dts-"));
    const dtsFile = join(dir, `${CRATE}.d.ts`);
    writeFileSync(dtsFile, emitFacade(model([COMBINE])).dts);
    const proc = Bun.spawn(
      ["bunx", "tsc", "--noEmit", "--strict", "--skipLibCheck", dtsFile],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode, stdout).toBe(0);
  }, 60_000);

  test("FAC14 docs are omitted by default and included under --with-docs", () => {
    expect(emitFacade(model()).dts).not.toContain("/**");
    const withDocs = emitFacade(model(), { withDocs: true }).dts;
    expect(withDocs).toContain("/**");
    expect(withDocs).toContain("The crate's error type");
  });

  test("FAC15 two runs produce byte-identical artifacts", () => {
    const a = emitFacade(model([COMBINE]));
    const b = emitFacade(model([COMBINE]));
    expect(a.dts).toBe(b.dts);
    expect(a.table).toBe(b.table);
  });
});

// ── Live integration: the fixture cannot rot where nightly is present ─────────

describe("facade live integration", () => {
  test("FAC3-live the checked-in fixture still matches fresh nightly rustdoc JSON", async () => {
    if (!(await hasNightlyRustdocJson())) {
      console.warn(
        "SKIP FAC3-live: no `cargo +nightly` rustdoc-json toolchain present — " +
          "fixture currency is unverified on this machine.",
      );
      return;
    }
    const live = await obtainRustdocJson(CRATE, { cwd: REPO_ROOT });
    const liveModel = generateFacade(live, {
      crate: CRATE,
      allowTraits: [COMBINE],
    });
    const fixtureModel = generateFacade(fixtureJson(), {
      crate: CRATE,
      allowTraits: [COMBINE],
    });
    const surface = (m: ReturnType<typeof generateFacade>): string =>
      JSON.stringify({
        types: m.types,
        methods: m.methods,
        rejects: m.rejects,
      });
    expect(surface(liveModel)).toBe(surface(fixtureModel));
  }, 120_000);
});
