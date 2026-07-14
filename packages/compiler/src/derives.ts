/**
 * Struct trait derivation (series 037b) — the single source of truth for which
 * `#[derive(...)]` a generated data struct carries, and (via the same cloneability
 * test) whether a struct-typed value may participate in the ownership pass's
 * move→`.clone()` refinement.
 *
 * **Principle: derive on-demand, never speculatively.** Each trait is gated on (a)
 * an actual feature that needs it and (b) field-type *eligibility* — a derive we
 * add that fails to compile (`#[derive(Hash)]` on an `f64`, `#[derive(Copy)]` on a
 * `String`) would be fail-loud pointing the wrong way (us breaking a valid input).
 * This mirrors the enum logic, which derives `Clone, Copy, PartialEq` only because
 * a `switch` guard needs comparison.
 *
 * Today the eligible set is **`Clone` + `Debug`**:
 *   - `Clone` — the ownership pass clones a moved struct that is used again; gated
 *     on every field being (transitively) cloneable.
 *   - `Debug` — unblocks `console.log(struct)` → `{:?}` (the whole-struct-printing
 *     deferral, issue #22). Every in-dialect data-field type is `Debug`, so it is
 *     effectively unconditional — but still computed, not assumed.
 *
 * Deliberately *not* derived here (each its own gated predicate once its feature
 * lands): `PartialEq`/`Eq` (a `===` semantics decision — issue #28), `Hash`+`Eq`
 * (struct map keys), `PartialOrd`/`Ord` (struct sort), `Copy` (interacts with the
 * ownership pass), serde `Serialize`/`Deserialize` (JSON).
 */

import type { HirItem, RustType } from "./hir";

/** Field lists of every generated data struct (from `interface`s and `class`es), by name. */
export type StructTable = Map<string, { name: string; ty: RustType }[]>;

/** Build the struct table from module items. Error classes are excluded — they carry hand-written impls. */
export function buildStructTable(items: HirItem[]): StructTable {
  const table: StructTable = new Map();
  for (const item of items) {
    if (item.kind === "struct" || item.kind === "class") {
      table.set(item.name, item.fields);
    }
  }
  return table;
}

/**
 * Is a type (transitively) `Clone`-able? Scalars/`String`/`bool` are; a `Vec`/
 * `HashMap` is iff its elements are; a `struct` is iff all its fields are (with a
 * cycle guard for recursive structs). An unknown struct name, or any non-data type
 * (`ref`, `result`, `rc`, …) is treated as not cloneable — conservative, so it
 * stays out of both the derive and the movable set.
 */
export function isTypeCloneable(
  ty: RustType,
  table: StructTable,
  seen: Set<string> = new Set(),
): boolean {
  switch (ty.kind) {
    case "f64":
    case "usize":
    case "i64":
    case "String":
    case "bool":
      return true;
    case "vec":
      return isTypeCloneable(ty.elem, table, seen);
    case "option":
      return isTypeCloneable(ty.inner, table, seen);
    case "hashmap":
      return (
        isTypeCloneable(ty.key, table, seen) &&
        isTypeCloneable(ty.value, table, seen)
      );
    case "set":
      return isTypeCloneable(ty.elem, table, seen);
    case "orderedFloat":
      return true;
    case "structKey":
      // The 074 key newtype derives `Clone` (via its wrapped struct).
      return isStructCloneable(ty.name, table, seen);
    case "struct":
      return isStructCloneable(ty.name, table, seen);
    default:
      return false;
  }
}

/** Is every field of the named struct (transitively) cloneable? */
export function isStructCloneable(
  name: string,
  table: StructTable,
  seen: Set<string> = new Set(),
): boolean {
  if (seen.has(name)) return true; // recursive struct — assume the cycle is fine
  const fields = table.get(name);
  if (!fields) return false;
  const next = new Set(seen).add(name);
  return fields.every((f) => isTypeCloneable(f.ty, table, next));
}

/** Is a type (transitively) `Debug`? Every in-dialect data-field type is. */
function isTypeDebug(
  ty: RustType,
  table: StructTable,
  seen: Set<string> = new Set(),
): boolean {
  switch (ty.kind) {
    case "f64":
    case "usize":
    case "i64":
    case "String":
    case "str":
    case "bool":
      return true;
    case "vec":
      return isTypeDebug(ty.elem, table, seen);
    case "option":
      return isTypeDebug(ty.inner, table, seen);
    case "hashmap":
      return (
        isTypeDebug(ty.key, table, seen) && isTypeDebug(ty.value, table, seen)
      );
    case "set":
      return isTypeDebug(ty.elem, table, seen);
    case "orderedFloat":
      return true;
    case "structKey":
      // The 074 key newtype derives `Debug` (via its wrapped struct).
      return isTypeDebug({ kind: "struct", name: ty.name }, table, seen);
    case "struct": {
      if (seen.has(ty.name)) return true;
      const fields = table.get(ty.name);
      if (!fields) return false;
      const next = new Set(seen).add(ty.name);
      return fields.every((f) => isTypeDebug(f.ty, table, next));
    }
    default:
      return false;
  }
}

/**
 * Is a type (transitively) `PartialEq`? (series 047 — struct `===` defaults to
 * structural equality.) Scalars/`String`/`str`/`bool` are; a `Vec`/`Option` iff
 * its element/inner is; a `HashMap`/`IndexMap` iff key **and** value are; a
 * `struct` iff every field is (cycle-guarded). Everything else — notably an
 * `fnPtr` field (function values) or any non-data `RustType` — is **not**
 * `PartialEq`. NB: `f64` IS `PartialEq` (unlike `Eq`/`Hash`) — so ordinary
 * numeric records are comparable; this deliberately does *not* imply `Eq`, so it
 * does not unlock struct map/set keys (#21).
 */
export function isTypePartialEq(
  ty: RustType,
  table: StructTable,
  seen: Set<string> = new Set(),
): boolean {
  switch (ty.kind) {
    case "f64":
    case "usize":
    case "i64":
    case "String":
    case "str":
    case "bool":
      return true;
    case "vec":
      return isTypePartialEq(ty.elem, table, seen);
    case "option":
      return isTypePartialEq(ty.inner, table, seen);
    case "hashmap":
      return (
        isTypePartialEq(ty.key, table, seen) &&
        isTypePartialEq(ty.value, table, seen)
      );
    case "set":
      return isTypePartialEq(ty.elem, table, seen);
    case "orderedFloat":
      return true;
    case "structKey":
      // The 074 key newtype has a custom `PartialEq` (SameValueZero).
      return true;
    case "struct": {
      if (seen.has(ty.name)) return true;
      const fields = table.get(ty.name);
      if (!fields) return false;
      const next = new Set(seen).add(ty.name);
      return fields.every((f) => isTypePartialEq(f.ty, table, next));
    }
    default:
      return false;
  }
}

/**
 * The `#[derive(...)]\n` line for a generated data struct (or `""` when nothing is
 * eligible). `Clone` when all fields are cloneable; `Debug` when all fields are
 * `Debug`; `PartialEq` when all fields are `PartialEq` (series 047). Order:
 * `Clone, Debug, PartialEq` (matches the enum convention of `Clone` first).
 */
export function structDeriveClause(
  s: {
    name: string;
    fields: { name: string; ty: RustType }[];
    hashEq?: boolean;
  },
  table: StructTable,
  usesJson = false,
): string {
  const traits: string[] = [];
  if (s.fields.every((f) => isTypeCloneable(f.ty, table, new Set([s.name])))) {
    traits.push("Clone");
  }
  const isDebug = s.fields.every((f) =>
    isTypeDebug(f.ty, table, new Set([s.name])),
  );
  if (isDebug) traits.push("Debug");
  // Structural equality (series 047): a struct is comparable with `===`/`!==` iff
  // every field is `PartialEq`. This is the documented divergence from JS
  // identity equality (see dialect.md). A non-`PartialEq` field (an `fnPtr`) is
  // caught at the comparison site with a clean `UnsupportedError` (047c). A struct
  // used as a `Map` key / `Set` element (series 061, `hashEq`) also needs
  // `PartialEq` (for `Eq`), so the two triggers union.
  if (
    s.hashEq ||
    s.fields.every((f) => isTypePartialEq(f.ty, table, new Set([s.name])))
  ) {
    traits.push("PartialEq");
  }
  // `Hash, Eq` for a struct used as a `Map` key / `Set` element (series 061). Its
  // field eligibility (no `f64`) was enforced fail-loud at collection time, so the
  // derive is sound here.
  if (s.hashEq) {
    traits.push("Eq", "Hash");
  }
  // serde `Serialize`/`Deserialize` are derived only when the module uses JSON
  // (series 045) and every field is (de)serializable — the same in-dialect data
  // set as `Debug`. Fully-qualified so no `use serde::…` prelude is needed.
  if (usesJson && isDebug) {
    traits.push("serde::Serialize", "serde::Deserialize");
  }
  return traits.length > 0 ? `#[derive(${traits.join(", ")})]\n` : "";
}
