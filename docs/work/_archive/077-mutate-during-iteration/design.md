# 077 — Robust mutate-during-iteration over an aliased container (index-based re-borrow)

> **Status: SHIPPED (2026-07-14).** Graduates the sole hard `DialectError` 062 left
> behind, issue **#41** (split from #38). Dialect calls made with Collin 2026-07-11
> (`needs-user-input` cleared). Turns the pattern into a **correct lowering that never
> panics** — neither a `DialectError` nor a 056 warning. Rides 062's alias-escape /
> `refineRc` machinery. Specs: `specs.md` →
> `packages/compiler/tests/mutate-during-iteration.test.ts` (11 specs, all green).
>
> **Impl notes / deviations:**
> - **`alias-escape.ts`** — `AutoRcResult` gains `aliasRootOf` (promoted union-find key →
>   component root), so the lowering can ask "does this loop body mutate the **same** cell
>   it iterates?" — reusing 062's transitive closure, no new analysis.
> - **`rc.ts` `refineRc`** — a new `tryReborrow` on each `for-of` over a promoted
>   `owner.field.iter()` whose body mutates the same cell rewrites it to the
>   `forInReborrow` HIR node (the dedicated-node route from the open sub-detail). The
>   array branch is uninstrumented; the map/set branch instruments each **visible**
>   `insert` on the cell with an `__added` enqueue guard and rejects an **opaque** cell
>   mutation (fail-loud). Loop binders are materialized as real HIR `let`s over the owned
>   per-step clones so `refineOwnership` sees them (clone-on-reuse) and the body's
>   comparisons type-check against owned values. A `strConcat` case was added to
>   `refineRc`'s `rewrite` (a latent gap: a `+`-concat part reading a promoted field
>   missed its `.borrow()`).
> - **`emitter.ts`** — `emitReborrowLoop` renders the array live-positional walk and the
>   map/set two-phase drain (`__keys077` snapshot + `__added077` buffer + `__seen077`
>   guard + per-step `contains`/`get` recheck). The `__…077` scaffolding names avoid user
>   collisions.
> - **`analysis.ts` `mutatesThis`** — extended to mark an indexed field-element write
>   `this.items[i] = v` as `&mut self` (a latent gap surfaced by the array live-write
>   spec; without it such a method emitted `&self` and failed to borrow the element mut).
> - **`hir.ts` / `ownership.ts` / `task-escape.ts`** — the `forInReborrow` node threads
>   through the post-`refineRc` passes (body-recursion + `owner`-liveness), disjoint from
>   `forIn`.
>
> Spec-first: this `design.md` → mock → RED `specs.md` → impl → archive.

## Problem

062 auto-lowers escaping shared-mutable aliasing to `Rc<RefCell<T>>`, but kept
**mutate-during-iteration over an aliased container** as a hard `DialectError`
(`docs/work/_archive/062-alias-escape-auto-rc/design.md`, §Decision + residuals):

```ts
const a = new Bag(); const b = a;        // alias → both become Rc<RefCell<Bag>>
for (const x of a.items) { b.add(x); }   // iterate a; mutate the SAME cell through b
```

The `for-of` must `a.borrow()` to reach `.items` and **holds that borrow across the loop
body**; the body's `b.add(x)` needs `b.borrow_mut()` on the same cell → **`RefCell` runtime
panic**. JS never panics — its `for-of` over an array is a **live positional index walk**
(`arr[i]` / `arr.length` re-read each step), so the mutation is simply observed (or not) with
no error. Emitting the panic would diverge from the differential oracle, so 062 fails loud.
At the 2026-07-10 session Collin rejected **both** interim routes (keep the `DialectError`;
downgrade to a 056 warning — a warning still emits panicking code) in favor of a **robust**
lowering.

## Decision — index-based re-borrow, no borrow held across the body (2026-07-11)

Lower the loop so **no `.borrow()` spans the mutation**: re-`borrow()` each step to read one
element, release it, then run the body (which may `borrow_mut()` freely). This reproduces
JS's live-index-walk semantics and cannot panic. Two container shapes:

### Arrays — live positional walk (fully JS-faithful)

An array field is already a live positional surface, exactly like JS:

```rust
let mut __i = 0;
loop {
    let x = {
        let __g = a.borrow();
        if __i >= __g.items.len() { break; }
        __g.items[__i].clone()          // read element i; borrow released at block end
    };
    __i += 1;
    b.borrow_mut().add(x);              // safe — no borrow outstanding
}
```

Appends **are** visited (including JS's infinite-loop footgun), splice-shifts reindex exactly
as JS does. Fully faithful.

### Map/Set — stable key-snapshot + append-buffer + live `contains` recheck (Collin's refinement)

A `Map`/`Set` is **not** positionally live in JS (it uses an entry cursor), and IndexMap's
`shift_remove` reindexes positionally — so a naive `.get_index(i)` walk would skip/revisit on
delete-during-iteration. Instead, **convert the Map/Set to a stable indexable surface** and
reproduce the cursor with a **two-phase drain**: snapshot the **keys** into an ordered `Vec`
at loop entry, then walk (1) the snapshot, then (2) a **growing `__added` buffer** of keys
inserted mid-iteration — re-checking `contains(k)` per step (deletes skipped) and reading the
value **live** (updates observed):

```rust
let __keys: Vec<K> = a.borrow().items.keys().cloned().collect();   // stable surface, borrow released
let mut __added: Vec<K> = Vec::new();                              // mid-iteration inserts, appended
let mut __seen: HashSet<K> = HashSet::new();                       // once-only guard (delete-then-readd)
let mut __src = 0;                                                 // phase-1 index (snapshot), then phase-2 (__added grows)
loop {
    let __k = match next_key(&__keys, &mut __added, &mut __src) { Some(k) => k, None => break };
    if !__seen.insert(__k.clone()) { continue; }                  // already visited → skip
    let entry = { let __g = a.borrow();
        match __g.items.get(&__k) { Some(v) => v.clone(), None => continue } };  // deleted → skip
    // body — each visible insert on the alias closure is instrumented:
    //   let __new = !x.borrow().items.contains_key(&k2);
    //   x.borrow_mut().items.insert(k2.clone(), v2);
    //   if __new { __added.push(k2); }
}
```

Because every mid-iteration insert lands **after** all originals (and later inserts after
earlier ones), the two-phase drain preserves JS's single insertion-order sequence — including
the **infinite-loop footgun** when the body keeps inserting (the `__added` drain keeps
growing, exactly as JS's cursor never terminates). Faithful on: **delete-before-visit**
(skipped), **value updates** (live read), **add-during-iteration** (enqueued + visited),
insertion order.

**Deletes need no instrumentation** — the live `contains` recheck catches them however they
happen (even inside an opaque called method). **Adds do** — a new key can only be enqueued at
an insert site we can *see and rewrite*; an add through an **opaque user-method call** on the
cell can't be enqueued → **fail-loud** (below). Arrays need none of this — they stay live.

## Mechanism

### Detection (reuse 062, narrowly)

Emit the index-based form **only** for the 062 panic pattern — no change to ordinary loops:

- The iterated container is reached through a binding in an **`Rc<RefCell<T>>` alias closure**
  (062's `alias-escape.ts` promoted set), **and**
- the loop **body mutates that same alias closure** — a `&mut self` method (`mutatingMethods`,
  `analysis.ts`) or a field write on any binding transitively aliased with the iterated one.

A non-aliased loop, or an aliased loop whose body doesn't mutate the cell, stays on the
existing clean `for x in a.borrow().items.iter()` lowering — **byte-for-byte unchanged**. The
trigger reuses 062's transitive alias closure + backward liveness; no new analysis.

### Container-shape routing

- **Array field** (`Vec<T>`) → live positional walk (`items[i]`, `len()` re-read).
- **`Map`/`Set` field** (`IndexMap`/`IndexSet`) → key-snapshot Vec + per-step `contains`/`get`
  recheck. `IndexSet` mirrors it (`items.iter().cloned().collect()`, `contains(&k)`).

### Element handling

Each step **clones** the element out so the read-borrow is released before the body. Elements
must be `Clone`/`Copy` (consistent with the ownership layer's clone-insertion). **Non-`Clone`
elements → fail-loud** (can't release the borrow without moving out of a `RefCell` by index).

### Reuse

062 `alias-escape.ts` promoted set + `refineRc` (`.borrow()`/`.borrow_mut()` emission);
`ownership.ts` CFG/liveness (already computes the "mutated while aliased-live" trigger);
`mutatingMethods` (`analysis.ts`); the existing `for-of` lowering site in `lower.ts` (gains
the index-based branch, gated on the trigger).

## Fail-loud residuals

- **Non-`Clone` elements** in the iterated container — can't clone out per step to release the
  borrow.
- **Opaque add during Map/Set iteration** — an insert into the iterated cell through a call the
  emitter can't see/rewrite (an opaque user method that might `.set`/`.add`) can't be enqueued
  into `__added`, so the add would be silently unvisited → **fail-loud** on that loop shape.
  (Visible `.set`/`.add` inserts are instrumented and visited; *deletes* through opaque calls
  are fine — the live `contains` recheck catches them.)
- **Delete-then-re-add the *same* key mid-iteration** — the `__seen` guard visits it **once**
  at its original position rather than at the end (JS would visit the re-add at the end).
  Single visit, minor order divergence — documented, not a panic/miscompile.
- **Iteration source that isn't a known indexable field** (`for-of` over a call result, a
  non-collection iterable, a generator) reached through an aliased cell — no positional
  surface; stays fail-loud.
- Everything 062 already ships fail-loud downstream (`Rc` cycles, `Weak`, interprocedural
  promotion boundaries) — unchanged; this series touches **only** the iteration pattern.

## Impl sequence

1. Trigger: in the `for-of` lowering, detect (iterated container ∈ 062 alias closure) ∧ (body
   mutates that closure) via `alias-escape.ts` + `mutatingMethods`.
2. Array branch: emit the live positional `loop { borrow → read i → release → body }`.
3. Map/Set branch: emit the key-snapshot Vec + `__added` append-buffer + `__seen` once-guard;
   two-phase drain; per-step `contains`/`get` recheck (live value). **Instrument visible
   inserts** on the alias closure inside the body (`!contains` → `insert` → `__added.push`);
   an **opaque** cell-mutating call in the body → `DialectError`.
4. Element clone-out; non-`Clone` → `DialectError`.
5. RED `specs.md` → GREEN (differential — the 062 panic pattern now runs and matches JS for
   the faithful cases; Map/Set add-during-iteration documented divergence has its own guarded
   spec).

## Specs sketch

- **The 062 panic pattern** — `const a=new Bag(); const b=a; for (const x of a.items) b.add(x)`
  — compiles, runs, no panic; differential-matches (array live-append semantics incl. the
  self-feeding growth).
- **Array splice-during-iteration** through an aliased cell → index shift matches JS.
- **Map delete-before-visit** through an aliased cell → the deleted key is skipped
  (differential-match).
- **Map value-update during iteration** → the live (updated) value is observed.
- **Map add-during-iteration** (visible `.set`/`.add`) → the new key **is** enqueued and
  visited; differential-matches JS insertion-order visitation. A self-feeding add loop grows
  the `__added` drain (matches JS's non-termination — guarded spec / bounded variant).
- **Map delete-then-re-add same key** → visited exactly once (`__seen`); documented order
  divergence asserted.
- Fail-loud: non-`Clone` element container; **opaque add** into the iterated Map/Set (insert
  through an un-instrumentable call); iteration over a non-indexable aliased source.
- Regression: an aliased loop with a **non-mutating** body, and any **non-aliased** loop, take
  the existing `iter()` lowering — **byte-for-byte unchanged**.

## Open sub-details (impl, not dialect forks)

- Whether to hoist a `snapshot`-fast-path: when liveness proves the body cannot observe its
  own mutation, a single up-front clone-to-iterate is cheaper than per-step re-borrow (an
  optimization; index-based is the uniform default).
- Where the index-based branch lives in the `for-of` lowering (a dedicated HIR node vs. a flag
  on the existing for-of node carrying the container shape + trigger).
- `IndexSet` value read: the element *is* the key, so the per-step `get` collapses to the
  `contains` check — confirm no double clone.
- **Membership recheck is O(1), not O(n²).** IndexMap `get`/`contains_key` are O(1) hash
  lookups (hash table + order Vec), so the per-step recheck is O(1) — O(n) total. A
  **delete-sentinel / tombstone** alternative (snapshot full entries, rewrite the body's
  `delete` calls to also tombstone the snapshot slot, skip tombstones) was **considered and
  rejected**: (1) it couples the body's mutation sites back to the iteration snapshot (the
  `contains`-recheck needs no such wiring — it just queries the live map), and (2) reading
  values from a full-entry snapshot loses **live value-update fidelity** (the `contains`
  design reads `map.get(k)` per step precisely so a mid-iteration value update is observed,
  matching JS). A tombstone addresses only deletes, not the add-not-visited residual, so it is
  strictly less faithful for no asymptotic win.
