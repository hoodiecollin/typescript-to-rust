# 123 — Toolchain requirements: specs

BDD specs for the toolchain policy + `ensureToolchain` bootstrap (design in
`design.md`). Ground rule inherited: **fail loud** — a missing toolchain ends in a
consented install or a precise remediation error, never a silent fallback, hang, or
empty output. Detection and install are exercised through an **injected spawn +
prompt seam**, so specs are hermetic and need no real toolchain mutation.

## Testing approach

- **Detection/precedence/fail-loud specs** run against an injected `spawn` (returns
  scripted `cargo`/`rustup` probe results) and an injected `prompt` (scripted
  y/N/consent). No spec installs a real toolchain or touches the machine.
- **One MSRV spec** asserts the workspace actually pins `rust-version` and a crate
  inherits it — read from the real `Cargo.toml` files (ground truth, not a mock).

## 1. MSRV pinning

- **TOOL1** — `[workspace.package]` declares `rust-version = "1.85"`, and at least
  one member crate inherits it via `rust-version.workspace = true`. The pinned value
  is ≥ the edition-2024 floor that `ts-primitives` already requires.

## 2. Config + precedence

- **TOOL2** — the resolved toolchain config honors precedence **CLI > env > `ttr.toml`
  > `rust-toolchain.toml` > built-in default**. A value set at every layer resolves
  to the CLI one; removing layers top-down falls through in that order.
- **TOOL3** — a `no_std` config key is **rejected fail-loud** as unsupported-yet (it
  is a parked future target), naming it explicitly — never silently accepted/ignored.

## 3. Detection + fail-loud (non-interactive)

- **TOOL4** — with `cargo` present (probe exits 0), `ensureToolchain("harness")`
  resolves without prompting or installing.
- **TOOL5** — with `cargo` **absent** and stdin non-interactive (or `--no-install` /
  `TTR_NO_INSTALL`), `ensureToolchain` **fails loud** naming the exact `rustup`
  remediation command; it never prompts and never installs.
- **TOOL6** — nightly is **required by no role but facade**: `ensureToolchain("harness"
  )` and `("emitted")` succeed on a stable-only *and* on a nightly-only toolchain;
  neither probes for nightly. Only `ensureToolchain("facade")` probes `+nightly`.

## 4. Interactive install (consent seam)

- **TOOL7** — `cargo` absent + interactive + **consent granted** (prompt → yes, or
  `--yes` / `TTR_ASSUME_YES`) runs exactly the resolved `rustup toolchain install
  <channel>` (observed on the injected spawn), then proceeds.
- **TOOL8** — same, but **consent declined** → no install command is spawned and it
  **fails loud** with the remediation, leaving the machine untouched.
- **TOOL9** — `cargo` **and** `rustup` both absent → the remediation surfaces the
  official `rustup-init` bootstrap and is spawned **only** on consent; the generator
  never silently pipes a remote script to a shell.

## 5. Facade nightly gating (generalizes FAC3)

- **TOOL10** — `ttr facade` with nightly rustdoc-json **absent** and `facade.auto_install
  = false` **fails loud** naming the nightly toolchain (the existing `FAC3` behavior,
  now routed through `ensureToolchain("facade")`).
- **TOOL11** — `ttr facade` with nightly absent, `auto_install = true` (or `--yes`) +
  consent installs exactly `rustup toolchain install nightly` (observed on the
  injected spawn), then generates.
- **TOOL12** — an existing `rust-toolchain.toml` whose `channel` is nightly is
  **respected** for the facade role (reused instead of a separate `+nightly` shim).

## Impl-plan

Ordered; each step gated by `bun run typecheck` + the relevant specs RED→GREEN. No
dialect surface is touched, so this proceeds straight through the spec-first flow.

1. **MSRV pin** — `[workspace.package] rust-version` + crate inheritance; TOOL1.
2. **Config loader** — `ttr.toml` + env + CLI → typed config with precedence; the
   `no_std`-rejection gate; TOOL2–TOOL3.
3. **`ensureToolchain(role)`** — detection + non-interactive fail-loud over an
   injected spawn; TOOL4–TOOL6.
4. **Consent/install seam** — mockable prompt; run resolved rustup commands; TOOL7–
   TOOL9.
5. **Facade refactor** — route facade's nightly check through `ensureToolchain`;
   `auto_install`/`--yes`; TOOL10–TOOL12.
6. **GREEN** — all TOOL specs pass; `bun run check` clean.
