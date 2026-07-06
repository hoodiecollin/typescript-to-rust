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
 * bespoke pass. See `docs/work/028-compiler-directives/arena-spike.md`.
 *
 * Scope of this first increment: `array`-literal-initialized `let`s in the scope
 * body (Copy elements). The binding's type annotation is dropped so bumpalo's
 * lifetime is inferred — the emitter never has to write `'a`. Deferred (heap or
 * cargo-loud): arena `String`/boxed nodes, arena values in signatures/fields,
 * nested arenas, and non-literal `Vec` sources.
 */

import { SCRIPT_SCOPE } from "./analysis";
import type { HirModule, HirStmt } from "./hir";

/** The synthetic arena binding injected at each `"use arena"` scope entry. */
const ARENA = "arena";

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
    if (s.kind === "let" && s.init.kind === "array") {
      used = true;
      return {
        ...s,
        ty: null, // let bumpalo's `Vec<'a, T>` lifetime infer — no `'a` to write.
        init: { kind: "bumpVec", arena: ARENA, elements: s.init.elements },
      };
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
