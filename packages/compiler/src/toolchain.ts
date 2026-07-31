/**
 * The toolchain policy + bootstrap seam (series 123, issue #121). Formalizes which
 * Rust toolchains TTR requires and generalizes `ttr facade`'s ad-hoc nightly check
 * (FAC3) into one `ensureToolchain(role)` gate every cargo-spawning path can route
 * through. Three roles carry different requirements:
 *
 *   - **emitted** — a consumer building TTR's output: stable ≥ MSRV (1.85).
 *   - **harness** — TTR verifying emitted Rust: any stable cargo; never nightly.
 *   - **facade**  — `ttr facade` only: nightly rustdoc-json, opt-in.
 *
 * Nightly is *allowed* for emitted/harness but *required* by none — only facade
 * probes for it. Every missing-toolchain path terminates in exactly one of: a
 * consented install that then proceeds, or a fail-loud {@link ToolchainError}
 * naming the exact rustup command — never a silent fallback, hang, or empty output.
 *
 * Detection, consent, and install run through an **injected spawn + prompt seam**
 * so the TOOL specs are hermetic and never mutate a real machine.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { FACADE_NIGHTLY } from "./facade";

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

/** A `y/N` consent prompt — returns true only on an explicit yes. Injected in specs. */
export type PromptLike = (question: string) => Promise<boolean>;

/**
 * Default interactive consent prompt — reads a `y/N` answer from stdin (writing the
 * question to stderr so it never contaminates stdout artifacts). Yes only on an
 * explicit `y`/`yes`.
 */
export const defaultPrompt: PromptLike = async (question) => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
};

/** Fail-loud error for every unmet or unbootstrappable toolchain requirement. */
export class ToolchainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolchainError";
  }
}

/** The three toolchain roles — who needs a toolchain and for what. */
export type ToolchainRole = "emitted" | "harness" | "facade";

/**
 * A partial config contribution from one source (CLI, env, `ttr.toml`, or
 * `rust-toolchain.toml`). Undefined fields do not override lower-precedence layers.
 */
export interface ToolchainConfigLayer {
  /** Default channel for the emitted/harness roles when none is on `PATH`. */
  channel?: string;
  /** Role-3 (facade) rustdoc-json channel. */
  facadeToolchain?: string;
  /** Whether facade may offer to install its nightly channel when missing. */
  facadeAutoInstall?: boolean;
  /** Never prompt or install; fail loud with the remediation instead. */
  noInstall?: boolean;
  /** Assume-yes for any install consent (`--yes` / `TTR_ASSUME_YES`). */
  assumeYes?: boolean;
  /** Informational + CI-enforceable MSRV floor. */
  msrv?: string;
}

/** The fully-resolved toolchain config after precedence is applied. */
export interface ResolvedToolchainConfig {
  channel: string;
  facadeToolchain: string;
  facadeAutoInstall: boolean;
  noInstall: boolean;
  assumeYes: boolean;
  msrv: string;
}

/** Built-in defaults — the lowest-precedence layer. */
export const TOOLCHAIN_DEFAULTS: ResolvedToolchainConfig = {
  channel: "stable",
  facadeToolchain: "nightly",
  facadeAutoInstall: false,
  noInstall: false,
  assumeYes: false,
  msrv: "1.85",
};

function isTable(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/** True for any truthy env flag (`1`, `true`, `yes`, present-but-empty is false). */
function envFlag(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const t = v.trim().toLowerCase();
  if (t === "" || t === "0" || t === "false" || t === "no") return false;
  return true;
}

/**
 * Parse a `ttr.toml` document into a config layer. A `no_std` key — top-level or
 * under `[toolchain]` — is **rejected fail-loud** (it is a parked future target, per
 * the design's no_std §), naming it explicitly; never silently accepted or ignored.
 */
export function parseTtrToml(doc: unknown): ToolchainConfigLayer {
  if (!isTable(doc)) return {};
  const toolchain = isTable(doc.toolchain) ? doc.toolchain : {};
  const facade = isTable(doc.facade) ? doc.facade : {};
  if ("no_std" in doc || "no_std" in toolchain) {
    throw new ToolchainError(
      "ttr.toml: `no_std` is not supported yet — std is assumed everywhere for " +
        "v1. It is a parked future target (see docs/theory/), not a silently " +
        "ignored key. Remove `no_std` from your ttr.toml.",
    );
  }
  return {
    channel: asString(toolchain.channel),
    msrv: asString(toolchain.msrv),
    facadeToolchain: asString(facade.toolchain),
    facadeAutoInstall: asBool(facade.auto_install),
  };
}

/** Parse a `rust-toolchain.toml` document into a config layer (its `channel`). */
export function parseRustToolchainToml(doc: unknown): ToolchainConfigLayer {
  if (!isTable(doc)) return {};
  const toolchain = isTable(doc.toolchain) ? doc.toolchain : {};
  return { channel: asString(toolchain.channel) };
}

/** Build a config layer from the process environment. */
export function envLayer(
  env: Record<string, string | undefined>,
): ToolchainConfigLayer {
  return {
    channel: env.TTR_TOOLCHAIN,
    facadeToolchain: env.TTR_FACADE_TOOLCHAIN,
    noInstall: envFlag(env.TTR_NO_INSTALL),
    assumeYes: envFlag(env.TTR_ASSUME_YES),
  };
}

/** The four precedence layers, highest-precedence (`cli`) last. */
export interface ConfigLayers {
  cli?: ToolchainConfigLayer;
  env?: ToolchainConfigLayer;
  ttrToml?: ToolchainConfigLayer;
  rustToolchainToml?: ToolchainConfigLayer;
}

function applyLayer(
  base: ResolvedToolchainConfig,
  layer: ToolchainConfigLayer | undefined,
): ResolvedToolchainConfig {
  if (!layer) return base;
  const next = { ...base };
  if (layer.channel !== undefined) next.channel = layer.channel;
  if (layer.facadeToolchain !== undefined)
    next.facadeToolchain = layer.facadeToolchain;
  if (layer.facadeAutoInstall !== undefined)
    next.facadeAutoInstall = layer.facadeAutoInstall;
  if (layer.noInstall !== undefined) next.noInstall = layer.noInstall;
  if (layer.assumeYes !== undefined) next.assumeYes = layer.assumeYes;
  if (layer.msrv !== undefined) next.msrv = layer.msrv;
  return next;
}

/**
 * Resolve the four layers into one config, honoring precedence (highest first):
 * **CLI → env → `ttr.toml` → `rust-toolchain.toml` → built-in default.**
 */
export function resolveToolchainConfig(
  layers: ConfigLayers,
): ResolvedToolchainConfig {
  let cfg = { ...TOOLCHAIN_DEFAULTS };
  cfg = applyLayer(cfg, layers.rustToolchainToml);
  cfg = applyLayer(cfg, layers.ttrToml);
  cfg = applyLayer(cfg, layers.env);
  cfg = applyLayer(cfg, layers.cli);
  return cfg;
}

/** How {@link loadToolchainConfig} reads its sources (all injectable for specs). */
export interface LoadConfigOptions {
  cwd?: string;
  /** Highest-precedence overrides from parsed CLI flags. */
  cli?: ToolchainConfigLayer;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
}

/**
 * Load the resolved toolchain config from `ttr.toml` + `rust-toolchain.toml` (read
 * from `cwd` when present), the environment, and CLI overrides. The `no_std`
 * fail-loud gate fires during `ttr.toml` parsing.
 */
export function loadToolchainConfig(
  opts: LoadConfigOptions = {},
): ResolvedToolchainConfig {
  const cwd = opts.cwd ?? process.cwd();
  const exists = opts.exists ?? existsSync;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const env = opts.env ?? process.env;

  const readToml = (name: string): unknown => {
    const path = join(cwd, name);
    if (!exists(path)) return undefined;
    return Bun.TOML.parse(readFile(path));
  };

  return resolveToolchainConfig({
    cli: opts.cli,
    env: envLayer(env),
    ttrToml: parseTtrToml(readToml("ttr.toml")),
    rustToolchainToml: parseRustToolchainToml(readToml("rust-toolchain.toml")),
  });
}

/**
 * Normalize a bare `major.minor` version (`"1.85"`) into the full `major.minor.patch`
 * (`"1.85.0"`) that a `rust-toolchain.toml` version channel requires — rustup
 * version channels need all three components. Named channels (`stable`, `nightly`,
 * `1.86.0`, `nightly-2026-06-19`) pass through unchanged.
 */
export function normalizeChannelVersion(channel: string): string {
  return /^\d+\.\d+$/.test(channel) ? `${channel}.0` : channel;
}

/**
 * The default channel to pin an emitted crate to: the MSRV as a full version
 * (`"1.85"` → `"1.85.0"`). Pinning to the exact edition-2024 floor makes the emitted
 * crate build reproducibly against the toolchain TTR targets; a caller may override.
 */
export function emittedPinChannel(config: ResolvedToolchainConfig): string {
  return normalizeChannelVersion(config.msrv);
}

/** Options for {@link generateRustToolchainToml}. */
export interface RustToolchainTomlOptions {
  channel: string;
  components?: string[];
}

/**
 * Generate the contents of a `rust-toolchain.toml` pinning an emitted crate's
 * toolchain (design decision 6 / stretch phase). What TTR writes here round-trips
 * back through {@link parseRustToolchainToml} to the same channel. TTR generates
 * this only on request (`--pin-toolchain`); it never requires one for its own use.
 */
export function generateRustToolchainToml(
  opts: RustToolchainTomlOptions,
): string {
  const lines = ["[toolchain]", `channel = "${opts.channel}"`];
  if (opts.components && opts.components.length > 0) {
    const list = opts.components.map((c) => `"${c}"`).join(", ");
    lines.push(`components = [${list}]`);
  }
  return `${lines.join("\n")}\n`;
}

function channelIsNightly(channel: string): boolean {
  return channel === "nightly" || channel.startsWith("nightly-");
}

async function cargoPresent(
  spawn: SpawnLike,
  cwd: string,
  shim: string[],
): Promise<boolean> {
  try {
    const { exitCode } = await spawn(["cargo", ...shim, "--version"], cwd);
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function rustupPresent(spawn: SpawnLike, cwd: string): Promise<boolean> {
  try {
    const { exitCode } = await spawn(["rustup", "--version"], cwd);
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * The official `rustup-init` bootstrap, run through a shell only after explicit
 * consent — TTR never silently pipes a remote script to a shell (design decision 3).
 */
export const RUSTUP_INIT_CMD: string[] = [
  "sh",
  "-c",
  "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y",
];

/** How {@link ensureToolchain} detects, consents, and installs (injected in specs). */
export interface EnsureOptions {
  /** Pre-resolved config; loaded from disk (`cwd`) when omitted. */
  config?: ResolvedToolchainConfig;
  cwd?: string;
  spawn?: SpawnLike;
  prompt?: PromptLike;
  /** Whether stdin is a TTY — a prompt is only offered when true. */
  isInteractive?: boolean;
  log?: (message: string) => void;
}

/** What {@link ensureToolchain} guarantees to its caller once it resolves. */
export interface EnsureResult {
  role: ToolchainRole;
  /** The channel confirmed present (or freshly installed). */
  channel: string;
  /**
   * The spawn prefix a caller should use to reach this channel: `["+nightly"]` for
   * facade's shim, or `[]` when the default toolchain already is the needed channel
   * (e.g. a `rust-toolchain.toml` pinned to nightly — TOOL12).
   */
  shim: string[];
}

function remediationCommand(
  role: ToolchainRole,
  channel: string,
  hasRustup: boolean,
): string[] {
  if (role === "facade") return ["rustup", "toolchain", "install", channel];
  return hasRustup
    ? ["rustup", "toolchain", "install", channel]
    : RUSTUP_INIT_CMD;
}

function failLoud(
  role: ToolchainRole,
  channel: string,
  cmd: string[],
  reason: string,
): ToolchainError {
  const nightlyNote =
    role === "facade" ? ` (${FACADE_NIGHTLY} rustdoc-json)` : "";
  return new ToolchainError(
    `toolchain: the '${channel}'${nightlyNote} toolchain is required for the ` +
      `${role} role but was not found (${reason}). Install it with:\n    ` +
      `${cmd.join(" ")}`,
  );
}

/**
 * Ensure the toolchain for `role` is available, installing it only with explicit
 * consent. Resolves to the confirmed channel + spawn shim; otherwise throws a
 * fail-loud {@link ToolchainError} naming the exact remediation. Never hangs on a
 * prompt in a non-interactive context and never installs without consent.
 */
export async function ensureToolchain(
  role: ToolchainRole,
  opts: EnsureOptions = {},
): Promise<EnsureResult> {
  const config = opts.config ?? loadToolchainConfig({ cwd: opts.cwd });
  const cwd = opts.cwd ?? process.cwd();
  const spawn = opts.spawn ?? bunSpawn;
  const log = opts.log ?? ((m: string) => console.error(m));
  const interactive = opts.isInteractive ?? Boolean(process.stdin.isTTY);

  const defaultIsNightly = channelIsNightly(config.channel);
  const isFacade = role === "facade";
  const shim =
    isFacade && !defaultIsNightly ? [`+${config.facadeToolchain}`] : [];
  const channel = isFacade
    ? defaultIsNightly
      ? config.channel
      : config.facadeToolchain
    : config.channel;

  if (await cargoPresent(spawn, cwd, shim)) {
    return { role, channel, shim };
  }

  const hasRustup = await rustupPresent(spawn, cwd);
  const cmd = remediationCommand(role, channel, hasRustup);

  const facadeGated =
    isFacade && !(config.facadeAutoInstall || config.assumeYes);
  if (facadeGated) {
    throw failLoud(role, channel, cmd, "facade auto_install disabled");
  }
  if (config.noInstall) {
    throw failLoud(role, channel, cmd, "--no-install / TTR_NO_INSTALL set");
  }
  if (!interactive && !config.assumeYes) {
    throw failLoud(role, channel, cmd, "non-interactive without --yes");
  }

  const consent =
    config.assumeYes ||
    (opts.prompt
      ? await opts.prompt(
          `Install the '${channel}' toolchain now with \`${cmd.join(" ")}\`? [y/N] `,
        )
      : false);
  if (!consent) {
    throw failLoud(role, channel, cmd, "install consent declined");
  }

  log(`toolchain: installing '${channel}' — ${cmd.join(" ")}`);
  const result = await spawn(cmd, cwd);
  if (result.exitCode !== 0) {
    throw new ToolchainError(
      `toolchain: install failed — \`${cmd.join(" ")}\` exited ${result.exitCode}.\n${result.stderr}`,
    );
  }
  return { role, channel, shim };
}
