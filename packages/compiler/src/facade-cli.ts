/**
 * The `ttr facade` CLI seam (series 122) — the side-effecting half that obtains a
 * crate's rustdoc JSON, drives the pure generator (`./facade`), and writes the two
 * artifacts. Kept separate from the generator core so the FAC parser/mapper/emit
 * specs stay hermetic against the checked-in fixture; here the `cargo +nightly`
 * spawn and the filesystem writes are injectable, so FAC1–FAC3 exercise the flow
 * without a nightly toolchain (the live integration spec supplies the real one).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FACADE_NIGHTLY,
  type FacadeModel,
  FacadeError,
  emitFacade,
  generateFacade,
} from "./facade";

/** The minimal spawn contract this module needs — satisfied by {@link bunSpawn}. */
export type SpawnLike = (
  cmd: string[],
  cwd: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Default {@link SpawnLike}: inherit the environment so rustup shims resolve. */
export const bunSpawn: SpawnLike = async (cmd, cwd) => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

/** Cargo package name → the snake-cased basename rustdoc writes under `target/doc`. */
function rustdocJsonName(crate: string): string {
  return `${crate.replace(/-/g, "_")}.json`;
}

/** Options controlling how rustdoc JSON is obtained (all injectable for specs). */
export interface ObtainOptions {
  /** Workspace root the cargo invocation runs in (defaults to cwd). */
  cwd?: string;
  spawn?: SpawnLike;
  readFile?: (path: string) => string;
}

/**
 * Shell `cargo +nightly rustdoc -p <crate> -- -Zunstable-options --output-format
 * json` and return the parsed document (FAC3). A missing nightly rustdoc-json
 * capability — a non-zero cargo exit or an unspawnable toolchain — **fails loud**
 * naming the required toolchain, never a silent empty facade.
 */
export async function obtainRustdocJson(
  crate: string,
  opts: ObtainOptions = {},
): Promise<unknown> {
  const cwd = opts.cwd ?? process.cwd();
  const spawn = opts.spawn ?? bunSpawn;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  let result: Awaited<ReturnType<SpawnLike>>;
  try {
    result = await spawn(
      [
        "cargo",
        "+nightly",
        "rustdoc",
        "-p",
        crate,
        "--",
        "-Zunstable-options",
        "--output-format",
        "json",
      ],
      cwd,
    );
  } catch (err) {
    throw new FacadeError(
      `facade: could not run cargo +nightly rustdoc for '${crate}' — ` +
        `is the ${FACADE_NIGHTLY} rustdoc-json toolchain installed? (${String(err)})`,
    );
  }
  if (result.exitCode !== 0) {
    throw new FacadeError(
      `facade: cargo +nightly rustdoc failed for '${crate}' (exit ${result.exitCode}). ` +
        `Ensure the ${FACADE_NIGHTLY} rustdoc-json toolchain is installed.\n${result.stderr}`,
    );
  }

  const jsonPath = join(cwd, "target", "doc", rustdocJsonName(crate));
  let raw: string;
  try {
    raw = readFile(jsonPath);
  } catch (err) {
    throw new FacadeError(
      `facade: rustdoc reported success but ${jsonPath} was not readable (${String(err)})`,
    );
  }
  return JSON.parse(raw);
}

/** True when a nightly rustdoc-json capability is present (for skip-loud specs). */
export async function hasNightlyRustdocJson(
  spawn: SpawnLike = bunSpawn,
): Promise<boolean> {
  try {
    const { exitCode } = await spawn(
      ["cargo", "+nightly", "--version"],
      process.cwd(),
    );
    return exitCode === 0;
  } catch {
    return false;
  }
}

/** Parsed `ttr facade` arguments. */
export interface FacadeArgs {
  crate: string;
  version: string | null;
  out: string;
  allowTraits: string[];
  withDocs: boolean;
}

/** Parse `<crate>[@version] [--out dir] [--allow-trait path]... [--with-docs]`. */
export function parseFacadeArgs(argv: string[]): FacadeArgs {
  let crateSpec: string | undefined;
  let out = ".";
  const allowTraits: string[] = [];
  let withDocs = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--out": {
        const v = argv[++i];
        if (!v)
          throw new FacadeError("facade: --out requires a directory argument");
        out = v;
        break;
      }
      case "--allow-trait": {
        const v = argv[++i];
        if (!v)
          throw new FacadeError("facade: --allow-trait requires a trait path");
        allowTraits.push(v);
        break;
      }
      case "--with-docs":
        withDocs = true;
        break;
      default:
        if (arg.startsWith("-"))
          throw new FacadeError(`facade: unknown flag ${arg}`);
        if (crateSpec)
          throw new FacadeError(`facade: unexpected extra argument ${arg}`);
        crateSpec = arg;
    }
  }

  if (!crateSpec) {
    throw new FacadeError(
      "usage: ttr facade <crate>[@version] [--out <dir>] [--allow-trait <path>]... [--with-docs]",
    );
  }
  const at = crateSpec.lastIndexOf("@");
  const crate = at > 0 ? crateSpec.slice(0, at) : crateSpec;
  const version = at > 0 ? crateSpec.slice(at + 1) : null;
  return { crate, version, out, allowTraits, withDocs };
}

/** Result of a facade run — the model plus the paths written. */
export interface FacadeRunResult {
  model: FacadeModel;
  dtsPath: string;
  tablePath: string;
}

/** How {@link runFacade} obtains its rustdoc JSON (injected in specs). */
export interface RunOptions {
  loadRustdoc?: (crate: string, version: string | null) => Promise<unknown>;
  writeFile?: (path: string, content: string) => void;
  mkdir?: (dir: string) => void;
  log?: (message: string) => void;
}

/**
 * Run the `ttr facade` subcommand end-to-end: obtain the crate's rustdoc JSON,
 * generate + emit the facade, write `<crate>.d.ts` + `<crate>.facade.json` under
 * `--out` (FAC1), and **loudly report** any unmappable items to stderr (FAC11 —
 * reported, never faked). Returns the model and the written paths.
 */
export async function runFacade(
  argv: string[],
  opts: RunOptions = {},
): Promise<FacadeRunResult> {
  const args = parseFacadeArgs(argv);
  const load =
    opts.loadRustdoc ?? ((crate: string) => obtainRustdocJson(crate));
  const writeFile =
    opts.writeFile ?? ((p: string, c: string) => writeFileSync(p, c));
  const mkdir =
    opts.mkdir ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const log = opts.log ?? ((m: string) => console.error(m));

  const json = await load(args.crate, args.version);
  const model = generateFacade(json, {
    crate: args.crate,
    version: args.version,
    allowTraits: args.allowTraits,
  });
  const { dts, table } = emitFacade(model, { withDocs: args.withDocs });

  mkdir(args.out);
  const dtsPath = join(args.out, `${args.crate}.d.ts`);
  const tablePath = join(args.out, `${args.crate}.facade.json`);
  writeFile(dtsPath, dts);
  writeFile(tablePath, table);

  if (model.rejects.length > 0) {
    log(
      `facade: ${model.rejects.length} item(s) could not be mapped and were omitted (not faked):`,
    );
    for (const r of model.rejects) log(`  - ${r.path}: ${r.reason}`);
  }

  return { model, dtsPath, tablePath };
}
