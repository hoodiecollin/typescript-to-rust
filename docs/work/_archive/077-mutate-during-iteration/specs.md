# 077 — Specs: robust mutate-during-iteration over an aliased container

Differential-oracle BDD (compile → `cargo run` → compare stdout vs Bun-run TS).
The correctness bar is **NEVER-PANIC + JS-semantics-faithful**: the 062 panic
pattern must now run and match JS for the faithful cases, and the residual edges
stay **fail-loud** (`cargo check` rejects / `DialectError`), never a silent
miscompile. IDs map to `packages/compiler/tests/mutate-during-iteration.test.ts`.

## Array container — live positional walk

- **MDI1 — the 062 panic pattern (array).**
  `const a = new Bag(); const b = a; for (const x of a.items) b.add(x)` — the
  container is reached through an `Rc<RefCell<T>>` alias and the body mutates the
  same cell. Compiles, runs, **no panic**; differential-matches JS. The self-feeding
  append is visited (JS's live-index growth), so a seeded finite array whose body
  appends a *bounded* number of new elements terminates and matches.

- **MDI2 — array splice/shrink-during-iteration through the alias.** The body
  removes from the aliased array mid-iteration; the index walk re-reads `len()`
  each step, so it shifts exactly as JS's positional `for-of` does — differential
  match.

- **MDI3 — array: value read is live.** The body mutates an already-visited slot;
  a later step over a re-read slot observes the update, matching JS.

## Map/Set container — key-snapshot + append-buffer + live recheck

- **MDI4 — Map delete-before-visit through the alias.** The body deletes a
  not-yet-visited key; the per-step `contains`/`get` recheck skips it —
  differential-match (deleted key never visited).

- **MDI5 — Map value-update during iteration.** The body updates the value of a
  key not yet reached; the live `get` per step observes the updated value —
  differential-match.

- **MDI6 — Map add-during-iteration (visible `.set`).** The body inserts a new key
  through a *visible* alias `.set`; the new key **is** enqueued (`__added`) and
  visited in insertion order — differential-match. A bounded self-feeding add loop
  grows the drain and terminates, matching JS's cursor visitation.

- **MDI7 — Set add-during-iteration (visible `.add`).** Mirror of MDI6 for a Set
  field — the added element is enqueued and visited.

## Regression — no change to clean loops (byte-for-byte)

- **MDI8 — non-aliased loop is unchanged.** A `for-of` over an unaliased container
  whose body mutates it stays on the existing lowering (still cargo-loud per 078's
  FC8 — no `Rc`, no index-based form). The index-based branch is gated on the 062
  alias trigger.

- **MDI9 — aliased loop, non-mutating body is unchanged.** An `Rc`-promoted
  container iterated with a body that does **not** mutate the cell keeps the clean
  `for x in a.borrow().items.iter()` lowering — no index-based rewrite.

## Fail-loud residuals

- **MDI10 — opaque add during Map/Set iteration.** An insert into the iterated
  Map/Set cell through a call the emitter cannot see/rewrite (an opaque user method
  that inserts) can't be enqueued → **fail-loud** (`DialectError`), no silently
  unvisited add.

- **MDI11 — non-`Clone` element container.** The iterated container's element is
  non-`Clone`, so the per-step clone-out that releases the borrow is impossible →
  **fail-loud** (`DialectError`).
</content>
</invoke>
