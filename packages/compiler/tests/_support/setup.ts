/**
 * Global bun-test preload (wired via the root `bunfig.toml`).
 *
 * The cargo-backed harness compiles real Rust per unbatched test; on a cold or
 * contended `rust-oracle` target a single `runRust`/`checkRust` can take several
 * seconds, which tripped bun's 5s per-test default with spurious
 * "timed out after 5000ms" flakes. Raise the default to 60s — ample headroom
 * over a cold build, still failing fast on a genuine hang. Batched differential
 * suites set their own (longer) `beforeAll` ceiling, so this does not affect them.
 *
 * It also pre-warms the oracle's dependency rlibs BEFORE any spec touches cargo
 * (`ensureDepsWarm`). When a crate is added to the oracle's `Cargo.toml`, the cold
 * compile of that crate + its transitive deps would otherwise land on the first
 * differential batch and race its timeout, corrupting the shared `target/` into a
 * burst of unrelated failures (the cargo thundering-herd flake). Change-detected
 * via a fingerprint sentinel, so warm runs pay nothing.
 */

import { setDefaultTimeout } from "bun:test";
import { ensureDepsWarm } from "../../src/harness";

setDefaultTimeout(60_000);

await ensureDepsWarm();
