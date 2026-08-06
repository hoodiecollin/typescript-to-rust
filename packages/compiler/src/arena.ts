/**
 * `"use arena"` refinement (series 028c) — bump allocation via `bumpalo`.
 *
 * A post-lowering HIR → HIR pass (like `rc.ts` / `ownership.ts`). Within a scope
 * opted in by a leading `"use arena"` directive, `Vec` literals are built from a
 * bump arena instead of the global heap: a single `let arena = bumpalo::Bump::new();`
 * is injected at scope entry, and each `array`-literal `let` init becomes a
 * `bumpalo::vec![in &arena; …]`. The whole arena is freed at once at scope exit.
 *
 *   "use arena";
 *   const xs: number[] = [1, 2, 3];   →   let arena = bumpalo::Bump::new();
 *   xs.push(4);                            let mut xs = bumpalo::vec![in &arena; 1.0, 2.0, 3.0];
 *   console.log(xs.length);               xs.push(4.0);
 *                                          println!("{}", xs.len());
 *
 * Soundness is by the oracle: an arena value that **escapes** the scope
 * (returned, stored past the arena's lifetime) is a Rust lifetime error cargo
 * rejects — cargo *is* the escape analysis, so this stays fail-loud without a
 * bespoke pass. See series 028.
 *
 * Slices: `array`-literal `let`s (028c), plus (series 087) `string`-literal `let`s
 * → `bumpalo::collections::String::from_str_in(…, &arena)` and **nested**
 * literals — an `array` element that is itself an `array`/`string` literal is
 * recursively routed into the same arena. The binding's type annotation is
 * dropped so bumpalo's lifetime is inferred — the emitter never has to write `'a`.
 * Deferred (heap or cargo-loud): arena boxed nodes, arena values in
 * signatures/fields (an escape → cargo lifetime error), and non-literal sources.
 */

import { SCRIPT_SCOPE } from "./analysis";
import type { HirExpr, HirModule, HirStmt } from "./hir";

/** The synthetic arena binding injected at each `"use arena"` scope entry. */
const ARENA = "arena";

/**
 * Route a `let`-init expression into the arena (series 087). An `array` literal
 * becomes a `bumpVec` whose *elements* are themselves recursively routed (so a
 * nested `[[…], …]` / `["…", …]` allocates every level from the arena); a
 * `string` literal becomes a `bumpString`. Any other expression is left as-is
 * (heap / cargo-loud). Returns null when nothing was routed, so the caller knows
 * whether to prepend the arena binding.
 */
function routeArena(e: HirExpr): HirExpr | null {
  if (e.kind === "array") {
    const elements = e.elements.map((el) => routeArena(el) ?? el);
    return { kind: "bumpVec", arena: ARENA, elements };
  }
  if (e.kind === "string") {
    return { kind: "bumpString", arena: ARENA, value: e.value };
  }
  return null;
}

export function refineArena(
  module: HirModule,
  arenaScopes: ReadonlySet<string>,
): HirModule {
  if (arenaScopes.size === 0) return module;
  if (arenaScopes.has(SCRIPT_SCOPE)) module.main = arenaBody(module.main);
  for (const item of module.items) {
    if (item.kind === "fn" && arenaScopes.has(item.name)) {
      item.body = arenaBody(item.body);
    }
  }
  return module;
}

/**
 * Rewrite one `"use arena"` body: route `array`-literal `let` inits to
 * `bumpalo::vec![in &arena; …]` (dropping the type annotation), and — if any were
 * routed — prepend the arena binding. Straight-line over the top level of the
 * body; a literal nested inside control flow is left heap (a later increment).
 */
function arenaBody(body: HirStmt[]): HirStmt[] {
  let used = false;
  const out = body.map((s): HirStmt => {
    if (s.kind === "let") {
      const routed = routeArena(s.init);
      if (routed) {
        used = true;
        return {
          ...s,
          // Drop the annotation so bumpalo's `Vec<'a, T>` / `String<'a>` lifetime
          // infers — the emitter never has to write `'a`.
          ty: null,
          init: routed,
        };
      }
    }
    return s;
  });
  if (!used) return out;
  const arenaLet: HirStmt = {
    kind: "let",
    name: ARENA,
    mut: false,
    ty: null,
    init: { kind: "bumpNew" },
  };
  return [arenaLet, ...out];
}
