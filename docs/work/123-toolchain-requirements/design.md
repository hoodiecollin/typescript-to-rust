# 123 — Toolchain requirements + configurable options

Formalizes which Rust toolchains TTR requires, for what, and how a user configures
and bootstraps them. Today TTR pins nothing and assumes a working `cargo` on
`PATH`; the facade generator (122) added the first *nightly* requirement, ad-hoc.
This series turns that into an explicit, configurable policy with a fail-loud
bootstrap — generalizing facade's `FAC3` (fail loud when nightly rustdoc-json is
absent) into a repo-wide `ensureToolchain` seam.

## Ground truth (at design time)

- **No `rust-toolchain.toml`.** TTR pins no channel; the harness spawns `cargo` /
  `cargo +nightly` inheriting the environment (rustup shims). A missing `cargo`
  surfaces today only as a raw spawn error, not a guided remediation.
- **Root `Cargo.toml`** — workspace, `resolver = "2"`, **no** `[workspace.package]
  rust-version` or `edition`. Each crate sets its own edition.
- **Editions are mixed** — `ts-primitives` is **edition 2024** (⇒ Rust **1.85+**);
  `tslib`, `ttr-plugin-leftpad`, and the fixtures are 2021. The emitted-crate MSRV
  is therefore *already implicitly* **1.85**, set by `ts-primitives`.
- **No `no_std`.** `tslib` pulls `reqwest` + `chrono` (std); everything assumes std.
- **Nightly** is required by exactly one surface: `ttr facade` (rustdoc-json).

## The three toolchain roles (the framing everything else hangs on)

Requirements differ by *who* needs the toolchain and *for what*. Conflating them is
what makes "does TTR need nightly?" ambiguous. There are three roles:

| Role | Who / when | Requirement |
|---|---|---|
| **1. Emitted-crate (MSRV)** | a *consumer* building TTR's output | **stable Rust ≥ 1.85** (edition 2024 floor from `ts-primitives`) |
| **2. Harness / oracle** | TTR itself verifying emitted Rust (`--check`/`--run`, the test suite) | any **stable** `cargo` ≥ MSRV — **never** nightly |
| **3. Facade generator** | `ttr facade <crate>` only (dev-time) | **nightly** rustdoc-json — **opt-in**, never at compile/run time |

**Nightly is *allowed* for roles 1–2 but *required* by none of them** — a user whose
only toolchain is nightly can compile, run, and verify fine. Nightly is *required*
solely by role 3, and only when that command is invoked.

## Locked decisions

1. **MSRV = Rust 1.85 / edition 2024.** Make today's implicit floor explicit: set
   `[workspace.package] rust-version = "1.85"`, inherited by crates via
   `rust-version.workspace = true`; enforce in CI. (Editions stay per-crate; the MSRV
   is the max across crates, which `ts-primitives`'s 2024 already sets.)
2. **rustup is the assumed toolchain manager.** Detection, install commands, and
   channel selection are expressed in rustup terms (`rustup toolchain install`,
   `+<channel>` shims). A non-rustup setup still *works* if the needed binaries are
   on `PATH`; it just doesn't get the guided auto-install path.
3. **Missing `cargo` → interactive bootstrap**, never a silent failure. Detect →
   present exactly what's missing + the precise remediation → prompt for consent →
   run it. Non-interactive/CI/`--no-install` instead **fails loud** with the command.
4. **Nightly is checked (and offered for auto-install) *only* under the facade
   feature.** No other command probes for or mentions nightly. This is the general
   form of facade's `FAC3`.
5. **`no_std` is parked** (see §no_std) — std everywhere for v1; documented as a
   future series, not built now.
6. **Config surface = `rust-toolchain.toml` + a `ttr.toml`**, with **CLI flags and
   env overriding**. Precedence (highest first):
   **CLI flag → env var → `ttr.toml` → `rust-toolchain.toml` → built-in default.**

## Config surface

- **`ttr.toml`** (project root) — TTR-specific preferences that have no rustup-native
  home. Dedicated file (not `[package.metadata.ttr]`) so it is cargo-agnostic and
  discoverable:

  ```toml
  [toolchain]
  msrv = "1.85"                 # informational + CI-enforceable floor
  channel = "stable"            # default role-1/2 channel when none on PATH

  [facade]
  toolchain = "nightly"         # role-3 channel (rustdoc-json)
  auto_install = false          # prompt to install nightly if missing (facade only)
  ```

- **`rust-toolchain.toml`** — rustup-native. TTR *reads* an existing one (if its
  `channel` is nightly, facade reuses it instead of a separate `+nightly` shim) and
  can *generate* one to pin a consumer's emitted crate; TTR does not *require* one
  for its own operation.
- **CLI flags** — `--toolchain <name>`, `--no-install` (never prompt; fail loud),
  `--yes` (assume-yes for install consent). **Env** — `TTR_TOOLCHAIN`,
  `TTR_FACADE_TOOLCHAIN`, `TTR_NO_INSTALL`, `TTR_ASSUME_YES`.

## Bootstrap / install workflow (`ensureToolchain(role)`)

A single harness seam all cargo-spawning paths route through:

1. **Detect** — probe the needed binary: `cargo --version` (roles 1–2) or
   `cargo +<channel> --version` (role 3); also probe `rustup --version`.
2. **Present + consent** — if absent and stdin is a TTY and not `--no-install`:
   print what's missing and the *exact* remediation, then prompt `y/N`.
   - **rustup present, toolchain/channel missing** → offer
     `rustup toolchain install <channel>` (+ `rustup component add …` if a component
     is needed).
   - **no cargo *and* no rustup** → surface the official `rustup-init` command; **do
     not** silently `curl … | sh`. The command is shown and run only on consent.
   - **facade nightly missing** → offer `rustup toolchain install nightly` (rustdoc
     ships in the default profile; no extra component for rustdoc-json — to confirm
     during impl).
3. **Non-interactive / `--no-install` / CI** → **fail loud** naming the exact command;
   never hang on a prompt, never auto-install.
4. **Consent is mandatory** for any install (prompt, or `--yes` / `TTR_ASSUME_YES`).
   Installing a toolchain is an outward, machine-modifying action — it follows the
   global "confirm before hard-to-reverse actions" rule; there is no silent install.

## Fail-loud alignment (TTR's spine)

Every missing-toolchain path terminates in exactly one of: **(a)** a consented
install that then proceeds, or **(b)** a fail-loud error naming the exact rustup
command. Never a silent fallback, a hang, or empty output. This is the generalization
of facade's existing `FAC3`; facade's ad-hoc nightly check is refactored onto
`ensureToolchain("facade")`.

## no_std (parked — future series, not v1)

- **Current:** std everywhere. `ts-primitives` and `tslib` assume std; `tslib`'s
  `reqwest` + `chrono` make real `no_std` non-trivial.
- **Future target:** `ts-primitives` `#![no_std]` + `alloc`; a default `std` feature;
  `tslib` (and anything pulling std-only deps) gated behind `std`. Tracked as a
  follow-up series; a `no_std` config key is **rejected fail-loud as unsupported-yet**
  until then (never silently accepted). See `docs/theory/` for the roadmap note.

## Dependencies / status

- **Generalizes:** 122 (`ttr facade`) — facade's nightly check becomes
  `ensureToolchain("facade")`; `FAC3` is the first instance of the general rule.
- **Relates to:** `120-public-release` — a defined toolchain + MSRV story is a
  release gate.
- **Status:** implemented. Phases 1–5 shipped; TOOL1–TOOL12 green over an injected
  spawn + prompt. The stretch phase (6) is deferred to a follow-up.

## Impl phases

Phases 1–5 shipped. Ground truth: MSRV pin lives in the root `Cargo.toml`
(`[workspace.package] rust-version = "1.85"`) inherited by every crate; the config
loader + precedence + `no_std` fail-loud gate + `ensureToolchain(role)` + the
consent/install seam live in `packages/compiler/src/toolchain.ts`; `ttr facade` now
routes its nightly check through `ensureToolchain("facade")`
(`packages/compiler/src/facade-cli.ts`), with `obtainRustdocJson` honoring the
resolved channel shim (so a nightly `rust-toolchain.toml` is reused, no `+nightly`).
Specs: `packages/compiler/tests/toolchain.test.ts` (TOOL1–TOOL12).

1. **Pin MSRV** — shipped.
2. **Config loader** — shipped (`resolveToolchainConfig` / `loadToolchainConfig`).
3. **`ensureToolchain(role)`** — shipped (detection + non-interactive fail-loud).
4. **Interactive install** — shipped (consent prompt behind the injected seam).
5. **Facade refactor** — shipped (`ensureToolchain("facade")`, `auto_install`/`--yes`).
6. **(stretch) rust-toolchain.toml generation** — **deferred** to a follow-up; TTR
   *reads* an existing one but does not yet *generate* one to pin a consumer's crate.
