/**
 * `defineDifferential` — the batched differential-test driver.
 *
 * The suite's oracle is: compile TS → Rust, run it, and assert the Rust stdout
 * equals both the Bun-run TS stdout AND a pinned literal. Historically each such
 * test called `runRust(src)` on its own, paying a full cargo invocation per test.
 * Here a whole file's specs are declared as DATA and built in ONE cargo batch
 * (`harness.runBatch` → `cargo build --examples --keep-going`): the heavy rlibs
 * compile once, cargo parallelizes the per-example codegen, and the Bun oracles
 * run bounded-parallel. Each spec then becomes a `test()` that asserts against the
 * pre-built result — no per-test cargo.
 *
 * A spec may also `expectFail` (the emitted Rust is *meant* to fail to compile or
 * panic at runtime — the fail-loud carve-outs) and/or attach `extra` assertions
 * (e.g. an emitted-Rust substring check, which is cheap and needs no cargo).
 *
 * TS→Rust-rejection tests (`expect(() => compile(...)).toThrow(...)`) do NOT
 * belong here — they never reach cargo; keep them as plain `test()`s.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../../src/ast";
import { resolveCrate } from "../../src/crate";
import { type CrateFile, emit, emitCrate } from "../../src/emitter";
import { harness } from "../../src/harness";
import {
  type CargoResult,
  type IoInput,
  mapBounded,
} from "../../src/harness/cargo";
import { lowerCrate } from "../../src/lower";

/** Emit Rust for a TS source (oracle mode — source threaded for provenance). */
export function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program, src);
}

/**
 * Compile a **multi-file crate** (series 050): resolve the entry's `./`-relative
 * imports over the in-memory `files` map, lower the whole crate, and emit one Rust
 * file per module. Returns the `CrateFile[]` written as a directory example.
 */
export function compileCrate(
  files: Record<string, string>,
  entry: string,
): CrateFile[] {
  const readFile = (key: string): string | null =>
    Object.prototype.hasOwnProperty.call(files, key) ? files[key]! : null;
  return emitCrate(lowerCrate(resolveCrate(entry, readFile)));
}

let tsSrcCounter = 0;

/**
 * Run a TS program under Bun and return its trimmed stdout (the oracle). When an
 * `io` is supplied (series 100) its `env`/`args` are threaded to both runs; a
 * spec that reads **stdin** is run from a temp source **file** (written under the
 * repo root so `@ttr/std` resolves) so the piped stdin carries the *program's*
 * input rather than the script source (`bun run -` would collide).
 */
export async function runTs(src: string, io?: IoInput): Promise<string> {
  const enc = new TextEncoder();
  let srcFile: string | null = null;
  let cmd: string[];
  let stdin: Uint8Array | "ignore";
  if (io?.stdin !== undefined) {
    srcFile = join(process.cwd(), `.ttr-io-src-${tsSrcCounter++}.ts`);
    writeFileSync(srcFile, src);
    cmd = ["bun", "run", srcFile, ...(io.args ?? [])];
    stdin = enc.encode(io.stdin);
  } else {
    cmd = ["bun", "run", "-", ...(io?.args ?? [])];
    stdin = enc.encode(src);
  }
  try {
    const proc = Bun.spawn(cmd, {
      stdin,
      stdout: "pipe",
      stderr: "ignore",
      // Pin `TZ=UTC` (series 102): the emitted Rust `Date` is UTC-only, and the
      // dialect UTC-normalizes JS's short local accessors, so the Bun oracle must
      // read UTC too for `getHours`/`toDateString`/… to match byte-for-byte. A
      // per-spec `io.env.TZ` still overrides. Harmless for non-Date suites (every
      // differential program is a pure function of its inputs).
      env: { ...process.env, TZ: "UTC", ...io?.env },
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim();
  } finally {
    if (srcFile) rmSync(srcFile, { force: true });
  }
}

/**
 * Run a **multi-file crate** (series 050) under Bun and return the entry's trimmed
 * stdout (the oracle for the emitted Rust crate). The `files` map is written into a
 * temp directory **under the repo root** (so `@ttr/std` still resolves and the
 * `./`-relative imports resolve against each other), then `bun run <dir>/<entry>`
 * executes it. `io` is threaded identically to the Rust run.
 */
export async function runTsCrate(
  files: Record<string, string>,
  entry: string,
  io?: IoInput,
): Promise<string> {
  const enc = new TextEncoder();
  const dir = mkdtempSync(join(process.cwd(), ".ttr-crate-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const dest = join(dir, path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    }
    const proc = Bun.spawn(["bun", "run", join(dir, entry), ...(io?.args ?? [])], {
      stdin: io?.stdin === undefined ? "ignore" : enc.encode(io.stdin),
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, TZ: "UTC", ...io?.env },
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A deterministic local loopback HTTP server (design §6c) both runs of a network
 * spec hit via `T2R_BASE_URL`. `GET` → a fixed 200 body; `POST` → an echo of the
 * posted body (both differential-stable). Bound to `127.0.0.1` on an OS-assigned
 * port (`port: 0`).
 */
function startLoopback(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "POST") {
        const body = await req.text();
        return new Response(`echo:${body}`, { status: 200 });
      }
      return new Response("hello from loopback", { status: 200 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

/** The pre-built context handed to a spec's assertions. */
export interface DiffContext {
  /**
   * The compiled Rust source. For a single-file spec, the emitted module; for a
   * multi-file crate (series 050), every emitted file concatenated (each under a
   * `// === <path> ===` header) so a `toContain` assertion spans the whole crate.
   */
  rust: string;
  /** The emitted crate files (series 050) — for a file-layout assertion (MOD5b). */
  files?: CrateFile[];
  /** The batch cargo result for this program (`.ok`/`.stdout`/`.errors`). */
  result: CargoResult;
  /** The Bun-run TS stdout (the differential oracle), trimmed. */
  ts: string;
}

export interface DiffSpec {
  name: string;
  /** Single-file source. Omit when `files` (a multi-file crate) is given. */
  src?: string;
  /**
   * A multi-file crate (series 050): a `path → source` map fed to the resolver.
   * The entry defaults to `main.ts` (override with `entry`).
   */
  files?: Record<string, string>;
  /** The crate entry file key within `files` (default `main.ts`). */
  entry?: string;
  /** Pinned expected stdout. Omit to assert only Rust===TS (oracle match). */
  expected?: string;
  /** The emitted Rust is expected to fail (compile error or runtime panic). */
  expectFail?: boolean;
  /** Extra assertions beyond the differential (e.g. an emitted-Rust substring). */
  extra?: (ctx: DiffContext) => void | Promise<void>;
  /**
   * Program I/O (series 100) fed **identically** to the Bun and Rust runs —
   * `stdin`/`args`/`env`. See `IoInput`.
   */
  io?: IoInput;
  /**
   * Allocate a fresh temp dir for this spec and expose its path to **both** runs
   * via the `T2R_TMP` env var (series 100). A file-I/O fixture writes/reads there
   * so a round-trip is isolated + auto-cleaned; both runs share the one dir.
   */
  tmp?: boolean;
  /**
   * Start the shared loopback HTTP server and expose its base URL to **both**
   * runs via `T2R_BASE_URL` (series 100, design §6c) so `http.get`/`post` are
   * differential.
   */
  net?: boolean;
}

function exId(suite: string, index: number): string {
  const safe = suite.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `s_${safe}_${index}`;
}

/**
 * Declare a file's differential specs. Builds them all in one cargo batch in a
 * `beforeAll`, then emits one `test()` per spec asserting the pre-built result.
 */
export function defineDifferential(suite: string, specs: DiffSpec[]): void {
  const ctx = new Array<DiffContext>(specs.length);
  const tmpDirs: string[] = [];
  let server: { url: string; stop: () => void } | null = null;

  // The batch cargo build is the single expensive step (the per-spec `test()`s
  // below are just map lookups), so give the hook a generous ceiling — far above
  // any real batch, well under a genuine hang.
  beforeAll(async () => {
    if (specs.some((s) => s.net)) server = startLoopback();
    // Per-spec I/O (series 100): allocate a temp dir / bind the loopback base URL
    // and merge them into the `env` fed identically to both runs.
    const ios: (IoInput | undefined)[] = specs.map((s) => {
      if (!s.io && !s.tmp && !s.net) return undefined;
      const env: Record<string, string> = { ...(s.io?.env ?? {}) };
      if (s.tmp) {
        const dir = mkdtempSync(join(tmpdir(), "ttr-io-"));
        tmpDirs.push(dir);
        env.T2R_TMP = dir;
      }
      if (s.net && server) env.T2R_BASE_URL = server.url;
      return { stdin: s.io?.stdin, args: s.io?.args, env };
    });
    const entryOf = (s: DiffSpec): string => s.entry ?? "main.ts";
    // Multi-file crates (series 050) compile to a `CrateFile[]`; single-file specs
    // to one `.rs` string.
    const crateFiles = specs.map((s) =>
      s.files ? compileCrate(s.files, entryOf(s)) : undefined,
    );
    const programs = specs.map((s, i) => {
      const id = exId(suite, i);
      const cf = crateFiles[i];
      if (cf) return { id, files: cf, io: ios[i] };
      return { id, src: compile(s.src ?? ""), io: ios[i] };
    });
    const [built, tsOut] = await Promise.all([
      harness.runBatch(programs),
      mapBounded(specs, 8, (s, i) =>
        s.files
          ? runTsCrate(s.files, entryOf(s), ios[i])
          : runTs(s.src ?? "", ios[i]),
      ),
    ]);
    specs.forEach((_, i) => {
      const id = exId(suite, i);
      const cf = crateFiles[i];
      const rust = cf
        ? cf.map((f) => `// === ${f.path} ===\n${f.content}`).join("\n")
        : (programs[i] as { src: string }).src;
      ctx[i] = { rust, files: cf, result: built.get(id)!, ts: tsOut[i]! };
    });
  }, 120_000);

  afterAll(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    server?.stop();
  });

  specs.forEach((s, i) => {
    test(s.name, async () => {
      const c = ctx[i]!;
      if (s.expectFail) {
        expect(c.result.ok).toBe(false);
      } else {
        expect(c.result.ok).toBe(true);
        expect(c.result.stdout.trim()).toBe(c.ts);
        if (s.expected !== undefined) {
          expect(c.result.stdout.trim()).toBe(s.expected);
        }
      }
      if (s.extra) await s.extra(c);
    });
  });
}
