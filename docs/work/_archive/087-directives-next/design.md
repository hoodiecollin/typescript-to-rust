# 087 — `"use rc"` / `"use arena"` next slices (design)

> **Status: SHIPPED.** R1/R2 (rc method calls, fields/params) lock-in specs green;
> R3 cross-call — promoted-param clone (lock-in) + the new read-into-non-promoted
> `f(&a.borrow())` wrap (`src/rc.ts` `call` case) — green; A1 arena `String`
> (`bumpString` HIR + `bumpalo::collections::String::from_str_in`) and A2 nested
> arenas (recursive `routeArena` in `src/arena.ts`) green. Residuals (R3 mut/owned
> into a non-promoted param; A3 arena-in-signature/field escape) stay cargo-loud.
> Specs: `packages/compiler/tests/rc-directive-next.test.ts`,
> `arena-directive-next.test.ts`. Verified serially.

> **Design is complete in 028** (`docs/work/028-compiler-directives/design.md`,
> `specs.md`, `arena-spike.md`). This doc only records **which next slices from
> issue #27 land in 087** and the fail-loud residual that remains. No new
> dialect decision is taken here — every slice either follows the 028 design or
> stays cargo-loud exactly as 028 predicted.

## Starting point (what already ships)

`refineRc` (`src/rc.ts`) and `refineArena` (`src/arena.ts`) are post-lowering
HIR→HIR passes gated to a leading directive on a free fn / top-level script
(`analysis.rcScopes` / `analysis.arenaScopes`; a directive in a method body is
`UnsupportedError` via `takeDirectives`). Crucially, **`refineRc` runs the same
`rewrite`/`walkStmt` machinery for both directive scopes and the auto-`Rc`
promotion analysis (062/069/086)** — the two are *orthogonal*:

- the **directive** promotes *class-typed local `let` bindings* in the scope
  (`const promote = (directive && classTy) || promotedLocals.has(s.name)`), and
- **auto-`Rc`** independently selects params / fields / cross-call callee params
  when its alias-escape analysis flags them.

So a directive-scope program that *also* has an aliasing shape auto-`Rc` detects
already emits correct `.borrow()`/`.borrow_mut()` method routing, promoted
fields, and cross-call handle clones. The three #27 `"use rc"` slices are
therefore split into **lock-in** (already correct via composition — pin with
specs) and one **genuinely new** rewrite (pure-directive cross-call).

## `"use rc"` slices

### R1 — method calls on an rc binding — LOCK-IN (already correct)

`a.foo()` on a directive-promoted rc binding already routes through
`.borrow()` / `.borrow_mut()` (the `method` case in `rewrite`: `isRcIdent`
splices the borrow, `mutatingMethods` picks the mode). Verified end-to-end:
`a.bump()` → `a.borrow_mut().bump()`, `b.get()` → `b.borrow().get()`, cargo-green,
differential-correct. **Slice = a spec that pins it**, using a program whose
promotion comes from the *directive* (not only from auto-`Rc`).

### R2 — rc fields / params — LOCK-IN (auto-`Rc`-driven, composes under the directive)

A class field / callee param that the alias-escape analysis flags is promoted to
`Rc<RefCell<T>>` and its reads/stores route correctly *inside a directive scope*
(field store clones the handle, a read borrows through both levels). Verified:
`Holder { child: Rc<RefCell<Node>> }`, `h.borrow().child.borrow().val`,
cargo-green. **Slice = a spec that pins field + param behavior under the
directive.** The directive alone never wraps a param/field type — that stays
analysis-selected by design (028 "only the flagged bindings, to keep the rest
idiomatic").

### R3 — cross-call rc values — NEW rewrite + fail-loud tail

Two cross-call shapes:

- **Into an auto-`Rc`-promoted callee param** — already handled: the `call` case
  clones `Rc::clone(&x)` into a promoted param (069). LOCK-IN spec.
- **Into a *non-promoted* callee param of the inner class type** (`readV(x: Box)`
  reading `x.v`, called with a directive rc binding `a: Rc<RefCell<Box>>`) —
  **new**: today this emits `readV(&a)` (a `&Rc<RefCell<Box>>` where `&Box` is
  expected → cargo `E0308`, loud). The 087 rewrite: when a **read-only** (`ref`,
  not `refMut`) argument is a directive rc ident and the callee param is *not*
  auto-promoted, wrap it `readV(&a.borrow())` — the `Ref<Box>` derefs to `&Box`.
  This graduates the "passing an rc value across a call boundary" residual named
  in 028b/specs.md for the read case.

**Fail-loud residual (R3):** a callee param taken **by `&mut`** (mutated through
the call) stays cargo-loud — `&mut a.borrow_mut()` would hand a `&mut Box` out of
a `RefMut` temporary whose borrow ends at the `;`, and a faithful mutate-through
would need the callee itself promoted (auto-`Rc`, which already covers the
aliased case). A directive-only mutate-through-a-non-promoted-param stays
`UnsupportedError`-free but cargo-loud (never silent). Reject-spec pins it.

## `"use arena"` slices

### A1 — arena `String` — NEW

A `let s: string = "…"` in an arena scope becomes
`bumpalo::collections::String::from_str_in("…", &arena)` with its `String` type
annotation dropped (lifetime inferred, mirroring the vec case). `.len()`,
`.push_str`, indexing all exist on `bumpalo::collections::String`, so the
existing `len` / `method` emission works unchanged — only **construction**
differs (exactly the vec-literal shape). New HIR expr `bumpString`, one emitter
arm. Verified target Rust compiles + runs. **Escape stays cargo-loud** (a
returned arena `String` is a lifetime error — cargo *is* the escape analysis).

### A2 — nested arenas (arena vec of arena vecs / arena strings) — NEW

An `array`-literal element that is itself an `array` literal (or a `string`
literal) is *recursively* routed to the same arena: `[[1,2],[3]]` →
`bumpalo::vec![in &arena; bumpalo::vec![in &arena; 1.0, 2.0], bumpalo::vec![in &arena; 3.0]]`.
Today only the outer vec is arena'd (inner stay heap `vec![…]`, which compiles
but doesn't arena the inner allocations). The rewrite recurses element
expressions through the same `array`→`bumpVec` / `string`→`bumpString` mapping.
Verified target Rust compiles + runs.

### A3 — arena values in signatures / fields — STAYS FAIL-LOUD (documented)

An arena value crossing a fn signature or stored in a struct field needs an
explicit `'a` lifetime written into the annotation — the single thorniest part
the 028c lifetime-elision insight deliberately sidesteps. An arena value that
escapes into a signature/field is a Rust lifetime error **cargo rejects** (loud,
never silent). Not attempted in 087 — kept as the 028c-documented residual.
Reject-spec pins that an escaping arena value fails the oracle.

## Slice → outcome summary

| Slice | Kind | Outcome |
|---|---|---|
| R1 method calls | lock-in | already correct; spec pins |
| R2 fields / params | lock-in | auto-`Rc`-driven; spec pins under directive |
| R3 cross-call (read into non-promoted param) | **new** | `&a.borrow()` wrap |
| R3 cross-call (into promoted param) | lock-in | `Rc::clone(&x)` (069); spec pins |
| R3 cross-call (mut through non-promoted param) | residual | cargo-loud, reject-spec |
| A1 arena `String` | **new** | `String::from_str_in(…, &arena)` |
| A2 nested arenas | **new** | recurse element literals into the arena |
| A3 arena in signatures / fields | residual | cargo-loud (escape), reject-spec |

## Non-goals (unchanged from 028)

Directives stay scope-local (free fn / script), method bodies reject, unknown
`"use …"` → `DialectError`. No proactive escape diagnostic (turning the cargo
lifetime error into a nicer `UnsupportedError`) — an ergonomics upgrade, not a
soundness one, out of 087.
