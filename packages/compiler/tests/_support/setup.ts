/**
 * Global bun-test preload (wired via the root `bunfig.toml`).
 *
 * The cargo-backed harness compiles real Rust per unbatched test; on a cold or
 * contended `.scratch` target a single `runRust`/`checkRust` can take several
 * seconds, which tripped bun's 5s per-test default with spurious
 * "timed out after 5000ms" flakes. Raise the default to 60s — ample headroom
 * over a cold build, still failing fast on a genuine hang. Batched differential
 * suites set their own (longer) `beforeAll` ceiling, so this does not affect them.
 */

import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(60_000);
