# 112 — Specs: lazy `split` count & single-index consumers

Spec file: `packages/compiler/tests/split-consumers.test.ts`. Cargo-compiled + byte-identical
via the differential harness. IDs:

## Count — `.count() as f64`

- **SC1** temp — `const parts = s.split("5"); const n: number = parts.length` →
  `s.split("5").count() as f64`; no `tslib::string::split`, no `let parts`.
- **SC2** inline — `s.split("5").length` → `s.split("5").count() as f64`.
- **SC-mut** (negative) — source written between producer and count → stays
  `tslib::string::split` (the snapshot must outlive the mutation).

## Single index — `.nth(i).unwrap()`, read-only only

- **SI1** inline read-only — `s.split("=")[1] === "b"` →
  `s.split("=").nth((1) as usize).unwrap() == …` (a comparison slot; `&str == String` is
  valid).
- **SI2** temp read-as-length — `parts[0].length` →
  `s.split(",").nth((0) as usize).unwrap()….`
- **SI-esc** (negative) — `return parts[0]` (owned `String` escape) stays
  `tslib::string::split`; no `.nth(`. Pins the read-only guard incl. the
  `.clone()`/`.to_string()` exclusion.

## forEach (emit-only)

- **SF** — `s.split("5").forEach(p => …)` lowers to a `for &p` ref pattern; the pass must
  **not** stream it (no `for &p in s.split(…)`), because a `&str` stream can't bind `str`
  through `&p`.

## Verification gate

- `split-consumers.test.ts` green; `split-lazy.test.ts` (107) still green (the guard changes
  touch the shared escape analysis); full compiler suite no regression.
- Adapter/forEach over split is out of scope (057 non-Copy-element residual) and recorded as a
  re-homed follow-up in `design.md`.
