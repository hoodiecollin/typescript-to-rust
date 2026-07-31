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
import {
  type EnsureResult,
  type PromptLike,
  type ResolvedToolchainConfig,
  type SpawnLike,
  type ToolchainConfigLayer,
  bunSpawn,
  defaultPrompt,
  ensureToolchain,
  loadToolchainConfig,
} from "./toolchain";

export type { SpawnLike };
export { bunSpawn };

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
  /**
   * The cargo channel shim to reach nightly rustdoc-json — `["+nightly"]` by
   * default, or `[]` when the default toolchain is already nightly (a
   * `rust-toolchain.toml` pinned to nightly, resolved by `ensureToolchain`).
   */
  shim?: string[];
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
  const shim = opts.shim ?? ["+nightly"];

  let result: Awaited<ReturnType<SpawnLike>>;
  try {
    result = await spawn(
      [
        "cargo",
        ...shim,
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
  /** Toolchain overrides parsed from `--toolchain`/`--yes`/`--no-install`/…. */
  cli: ToolchainConfigLayer;
}

/**
 * Parse `<crate>[@version] [--out dir] [--allow-trait path]... [--with-docs]` plus
 * the toolchain overrides (`--toolchain`, `--facade-toolchain`,
 * `--facade-auto-install`, `--yes`/`-y`, `--no-install`) that the highest-precedence
 * config layer draws from.
 */
export function parseFacadeArgs(argv: string[]): FacadeArgs {
  let crateSpec: string | undefined;
  let out = ".";
  const allowTraits: string[] = [];
  let withDocs = false;
  const cli: ToolchainConfigLayer = {};

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
      case "--toolchain": {
        const v = argv[++i];
        if (!v)
          throw new FacadeError("facade: --toolchain requires a channel name");
        cli.channel = v;
        break;
      }
      case "--facade-toolchain": {
        const v = argv[++i];
        if (!v)
          throw new FacadeError(
            "facade: --facade-toolchain requires a channel name",
          );
        cli.facadeToolchain = v;
        break;
      }
      case "--facade-auto-install":
        cli.facadeAutoInstall = true;
        break;
      case "--yes":
      case "-y":
        cli.assumeYes = true;
        break;
      case "--no-install":
        cli.noInstall = true;
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
  return { crate, version, out, allowTraits, withDocs, cli };
}

/** Result of a facade run — the model plus the paths written. */
export interface FacadeRunResult {
  model: FacadeModel;
  dtsPath: string;
  tablePath: string;
}

/** How {@link runFacade} obtains its rustdoc JSON + toolchain (injected in specs). */
export interface RunOptions {
  loadRustdoc?: (crate: string, version: string | null) => Promise<unknown>;
  writeFile?: (path: string, content: string) => void;
  mkdir?: (dir: string) => void;
  log?: (message: string) => void;
  /** Pre-resolved config; loaded from `cwd` + parsed CLI flags when omitted. */
  config?: ResolvedToolchainConfig;
  cwd?: string;
  spawn?: SpawnLike;
  prompt?: PromptLike;
  isInteractive?: boolean;
  /** The toolchain gate; defaults to the real {@link ensureToolchain}. */
  ensure?: (role: "facade") => Promise<EnsureResult>;
}

/**
 * Run the `ttr facade` subcommand end-to-end: **ensure the nightly rustdoc-json
 * toolchain** (`ensureToolchain("facade")` — the generalized FAC3 gate, TOOL10–
 * TOOL12), obtain the crate's rustdoc JSON via the resolved channel shim, generate +
 * emit the facade, write `<crate>.d.ts` + `<crate>.facade.json` under `--out`
 * (FAC1), and **loudly report** any unmappable items to stderr (FAC11 — reported,
 * never faked). Returns the model and the written paths.
 *
 * The toolchain gate only runs on the default rustdoc-loading path; a spec that
 * injects `loadRustdoc` supplies the JSON directly and stays hermetic.
 */
export async function runFacade(
  argv: string[],
  opts: RunOptions = {},
): Promise<FacadeRunResult> {
  const args = parseFacadeArgs(argv);
  const cwd = opts.cwd ?? process.cwd();
  const writeFile =
    opts.writeFile ?? ((p: string, c: string) => writeFileSync(p, c));
  const mkdir =
    opts.mkdir ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const log = opts.log ?? ((m: string) => console.error(m));

  const load =
    opts.loadRustdoc ??
    (async (crate: string) => {
      const config = opts.config ?? loadToolchainConfig({ cwd, cli: args.cli });
      const ensure =
        opts.ensure ??
        ((role: "facade") =>
          ensureToolchain(role, {
            config,
            cwd,
            spawn: opts.spawn,
            prompt: opts.prompt ?? defaultPrompt,
            isInteractive: opts.isInteractive,
            log,
          }));
      const { shim } = await ensure("facade");
      return obtainRustdocJson(crate, { cwd, spawn: opts.spawn, shim });
    });

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
