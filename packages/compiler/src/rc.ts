/**
 * `"use rc"` refinement (series 028b) — the sanctioned Option-B fallback — plus the
 * auto-`Rc` promotion pass (series 062 intraprocedural; 069 interprocedural /
 * field-store).
 *
 * A post-lowering HIR → HIR pass (like `numeric.ts` / `ownership.ts`). A binding of
 * a **class** type is translated under `Rc<RefCell<T>>` instead of a plain move when
 * either (a) a leading `"use rc"` directive opts the whole scope in (028b), or (b)
 * the alias-escape analysis selected it (062/069). This turns shared-mutable
 * aliasing — which Option A's idiomatic borrows cannot express (`const b = a;
 * a.x = …; use(b.x)` is a move error) — into working Rust:
 *
 *   - `const a: C = new C(…)`  →  `let a: Rc<RefCell<C>> = Rc::new(RefCell::new(C::new(…)))`
 *   - `const b: C = a`         →  `let b: Rc<RefCell<C>> = Rc::clone(&a)`   (shared handle)
 *   - read  `a.field`          →  `a.borrow().field`
 *   - write `a.field = v`      →  `a.borrow_mut().field = v`               (interior mutability)
 *
 * Series 069 graduates the interprocedural / field-store tail (the promoted set
 * arrives as an `AutoRcResult`): a promoted **param** takes `Rc<RefCell<T>>` (its
 * type is rewritten and it enters scope already `rc`); a call passing a promoted
 * binding into a promoted param clones the handle (`Rc::clone(&x)`); a promoted
 * **class field** takes `Rc<RefCell<T>>`, a struct literal storing a binding into it
 * clones (`Rc::clone`) or wraps (`Rc::new`), and a read through the field borrows
 * (`obj.f.borrow().g`).
 *
 * Interior mutability means these bindings are never `mut`.
 */

import { SCRIPT_SCOPE } from "./analysis";
import type { AutoRcResult } from "./alias-escape";
import { buildStructTable, isTypeCloneable } from "./derives";
import { UnsupportedError } from "./errors";
import type { HirExpr, HirFn, HirModule, HirStmt, RustType } from "./hir";

export interface RcOpts {
  /** Scopes opted in by a leading `"use rc"` directive (028b) — promote *all* class bindings. */
  rcScopes: ReadonlySet<string>;
  /**
   * The auto-`Rc` promotion result (series 062/069) — the analysis-selected set of
   * promoted bindings/params/fields, keyed by scope / callee / class.
   */
  autoRc: AutoRcResult;
  classes: ReadonlySet<string>;
  /** `&mut self` method names — a method call on a promoted binding routes through
   * `.borrow_mut()` (else `.borrow()`), series 062. */
  mutatingMethods: ReadonlySet<string>;
}

/**
 * The **lowered** HIR names a mutating `Map`/`Set` field-collection call takes
 * (series 078 / issue #45): `set`/`add` → `insert`, `delete` → `shift_remove`.
 * These are not in the class-method `mutatingMethods` fixpoint, so `refineRc`
 * recognizes them here to choose `borrow_mut` and thread the write mode into a
 * promoted-owner field receiver. Mirrors the same set in `alias-escape.ts`.
 */
const COLLECTION_MUT_METHODS: ReadonlySet<string> = new Set([
  "insert",
  "shift_remove",
]);

/**
 * The **lowered** in-place mutators of a promoted **captured container** (series 086 /
 * issue #46): the `Vec` / `IndexSet` / `IndexMap` methods that need `.borrow_mut()` when
 * called on a promoted `Rc<RefCell<T>>` container binding. A read (`get`/`contains`/
 * `len`) is not here, so it stays `.borrow()`. Kept in lockstep with `alias-escape.ts`
 * (`CONTAINER_MUT_METHODS`).
 */
const CONTAINER_MUT_METHODS: ReadonlySet<string> = new Set([
  "insert",
  "shift_remove",
  "push",
  "pop",
  "remove",
  "clear",
  "truncate",
  "sort",
  "sort_by",
  "reverse",
  "swap",
]);

/** The scope key for a class ctor (its associated `new`). */
function ctorScope(cls: string): string {
  return `${cls}::new`;
}
/** The scope key for a class method. */
function methodScope(cls: string, m: string): string {
  return `${cls}.${m}`;
}

/** The class name a lowered type resolves to (`struct C` / `&C` / `Rc<RefCell<C>>`), or null. */
function classOfType(
  ty: RustType | null | undefined,
  classes: ReadonlySet<string>,
): string | null {
  if (!ty) return null;
  if (ty.kind === "struct" && classes.has(ty.name)) return ty.name;
  if (ty.kind === "ref") return classOfType(ty.inner, classes);
  if (ty.kind === "rc") return classOfType(ty.inner, classes);
  return null;
}

/**
 * Does an expression subtree read the promoted rc ident `name` (series 086 re-entrant
 * guard)? A bare `name` ident that is in the `rc` set counts; recurses through every
 * sub-expression. Used to reject `m.set(k, m.get(k)+v)` on a shared cell (the 062
 * `RefCell` re-entrant-panic shape) before it emits a silent panic.
 */
function readsRcIdent(e: HirExpr, name: string, rc: ReadonlySet<string>): boolean {
  if (name === "") return false;
  if (e.kind === "ident") return e.name === name && rc.has(name);
  return subExprsRc(e).some((c) => readsRcIdent(c, name, rc));
}

export function refineRc(module: HirModule, opts: RcOpts): HirModule {
  const { promoted, promotedParams, promotedFields } = opts.autoRc;
  const rcScopes = opts.rcScopes;
  const hasAuto =
    promoted.size > 0 || promotedParams.size > 0 || promotedFields.size > 0;
  if (rcScopes.size === 0 && !hasAuto) return module;

  // Promote class field *types* first (069) — the struct decl the emitter reads and
  // the ctor/method bodies both see the `Rc<RefCell<T>>` field.
  for (const item of module.items) {
    if (item.kind !== "class") continue;
    const fields = promotedFields.get(item.name);
    if (!fields) continue;
    for (const f of item.fields) {
      if (fields.has(f.name)) f.ty = wrapRc(f.ty, opts.classes);
    }
  }

  // Class field types (post field-promotion) — `classOfExpr` unwraps `Rc<RefCell<C>>`
  // back to `C` to resolve a read through a promoted field.
  const classFields = new Map<string, { name: string; ty: RustType }[]>();
  for (const item of module.items) {
    if (item.kind === "class") classFields.set(item.name, item.fields);
  }

  const scopeSet = new Set<string>([...rcScopes, ...promoted.keys()]);
  // A scope with only a promoted param (no local) still needs its body processed.
  for (const k of promotedParams.keys()) scopeSet.add(k);

  // Struct/class field table for the series-077 element-`Clone` gate (a non-`Clone`
  // iterated element can't be cloned out per step to release the borrow → fail-loud).
  const structs = buildStructTable(module.items);

  const run = (fn: HirFn | null, body: HirStmt[], scope: string): void => {
    if (!scopeSet.has(scope) && !rcScopes.has(scope)) return;
    rcBody(
      fn,
      body,
      scope,
      opts,
      promoted.get(scope) ?? new Set(),
      classFields,
      structs,
    );
  };

  run(null, module.main, SCRIPT_SCOPE);
  for (const item of module.items) {
    if (item.kind === "fn") run(item, item.body, item.name);
    if (item.kind === "class") {
      if (item.ctor) run(item.ctor, item.ctor.body, ctorScope(item.name));
      for (const m of item.methods) {
        run(m, m.body, methodScope(item.name, m.name));
      }
    }
  }
  return module;
}

/**
 * Wrap a type in `Rc<RefCell<T>>`, unwrapping any borrow first. A class `&C` and a
 * threaded container `&mut IndexSet` (series 086) both unwrap to their owned inner
 * before wrapping — a promoted handle is an owned `Rc`, never a `&`.
 */
function wrapRc(ty: RustType, classes: ReadonlySet<string>): RustType {
  if (ty.kind === "rc") return ty;
  if (ty.kind === "ref") return wrapRc(ty.inner, classes);
  return { kind: "rc", inner: ty };
}

/**
 * Rewrite one scope body in place. `rc` holds the names bound to an
 * `Rc<RefCell<…>>` so far (document order), seeded with the scope's promoted params;
 * `bindingClass` maps a binding/param to its class name so a read through a promoted
 * field can be routed through `.borrow()`.
 */
function rcBody(
  fn: HirFn | null,
  body: HirStmt[],
  scope: string,
  opts: RcOpts,
  promotedLocals: ReadonlySet<string>,
  classFields: ReadonlyMap<string, { name: string; ty: RustType }[]>,
  structs: ReturnType<typeof buildStructTable>,
): void {
  const { classes, mutatingMethods, autoRc } = opts;
  const { promotedParams, promotedFields } = autoRc;
  const directive = opts.rcScopes.has(scope);

  const rc = new Set<string>();
  const bindingClass = new Map<string, string>();

  // Seed promoted params: they enter scope already `rc`, and their declared type
  // becomes `Rc<RefCell<T>>` (069 interprocedural class param; 086 a threaded
  // `__arrow_n` **container** param). A promoted param is wrapped regardless of whether
  // it is a class — a captured shared container param (`s: IndexSet` → `Rc<RefCell<…>>`)
  // rides the same path. `bindingClass` still only tracks class params (it drives the
  // promoted-field read route, a class-only shape).
  const scopeParams = promotedParams.get(scope);
  if (fn) {
    for (const p of fn.params) {
      const cls = classOfType(p.ty, classes);
      if (cls) bindingClass.set(p.name, cls);
      if (scopeParams?.has(p.name)) {
        p.ty = wrapRc(p.ty, classes);
        rc.add(p.name);
      }
    }
  }

  /**
   * The class an expression evaluates to, resolved through the `rc`-aware forms this
   * pass introduces: an `rc`/class ident (`bindingClass`), a `.borrow()`/`.borrow_mut()`
   * unwrap of an `Rc<RefCell<C>>` (its inner `C`), and a read through a promoted field
   * (that field's class). Drives whether the next projection needs its own `.borrow()`.
   */
  const classOfExpr = (e: HirExpr): string | null => {
    if (e.kind === "ident") return bindingClass.get(e.name) ?? null;
    if (
      e.kind === "method" &&
      (e.name === "borrow" || e.name === "borrow_mut") &&
      e.args.length === 0
    ) {
      return classOfExpr(e.receiver);
    }
    if (e.kind === "field") {
      const cls = classOfExpr(e.object);
      if (cls && promotedFields.get(cls)?.has(e.name)) {
        return classOfType(fieldTypeOf(cls, e.name), classes);
      }
    }
    return null;
  };

  /** The (pre-promotion) declared type of a class field, for `classOfExpr`. */
  const fieldTypeOf = (cls: string, field: string): RustType | null => {
    const item = classFields.get(cls);
    return item?.find((f) => f.name === field)?.ty ?? null;
  };

  /** Is `object` a read through a promoted class field (`obj.f` with `f` promoted)? */
  const promotedFieldRead = (object: HirExpr): boolean => {
    if (object.kind !== "field") return false;
    const cls = classOfExpr(object.object);
    return !!cls && !!promotedFields.get(cls)?.has(object.name);
  };

  /**
   * Wrap a value being stored into a promoted `Rc<RefCell<T>>` field: clone an
   * existing handle (`Rc::clone(&x)`), pass through an already-wrapping node, else
   * construct a fresh handle (`Rc::new(RefCell::new(v))`).
   */
  const wrapForField = (value: HirExpr): HirExpr => {
    if (value.kind === "ident" && rc.has(value.name)) {
      return { kind: "rcClone", expr: value };
    }
    if (value.kind === "rcClone" || value.kind === "rcNew") return value;
    return { kind: "rcNew", inner: value };
  };

  /** Route a possibly-`rc` object (an `rc` ident, or a read through a promoted field)
   * through `.borrow()` (read) / `.borrow_mut()` (write). */
  const maybeBorrow = (object: HirExpr, write: boolean): HirExpr => {
    const isRcIdent = object.kind === "ident" && rc.has(object.name);
    if (isRcIdent || promotedFieldRead(object)) {
      return {
        kind: "method",
        receiver: object,
        name: write ? "borrow_mut" : "borrow",
        args: [],
      };
    }
    return object;
  };

  /**
   * Rewrite reads (and, when `write`, the outermost object of an assignment
   * target) so `rc` accesses go through the `RefCell`. Pure structural recursion
   * over every `HirExpr` kind; only `field`/`index`/`method` on an `rc` ident or a
   * promoted field change.
   */
  const rewrite = (e: HirExpr, write = false): HirExpr => {
    switch (e.kind) {
      case "field":
        return { ...e, object: maybeBorrow(rewrite(e.object), write) };
      case "index":
        return {
          ...e,
          object: maybeBorrow(rewrite(e.object), write),
          index: rewrite(e.index),
        };
      case "assign": {
        const target = rewrite(e.target, true);
        let value = rewrite(e.value);
        // A store into a promoted field (`container.f = a`) wraps the value the same
        // way a struct-literal field does: clone an existing handle, else construct one.
        if (e.target.kind === "field") {
          const cls = classOfExpr(e.target.object);
          if (cls && promotedFields.get(cls)?.has(e.target.name)) {
            value = wrapForField(value);
          }
        }
        return { ...e, target, value };
      }
      case "binary": {
        // Struct identity under `"use rc"` (series 047b): `a === b` over two `rc`
        // handles compares the handles with `Rc::ptr_eq` (JS identity — an alias
        // is equal, a fresh equal value is not), not structural `==`. `!==` wraps
        // in `!`. Mixing an `rc` handle with a non-`rc` operand can't compare a
        // handle to a value → fail loud rather than guess.
        if (e.op === "===" || e.op === "!==") {
          const lRc = e.left.kind === "ident" && rc.has(e.left.name);
          const rRc = e.right.kind === "ident" && rc.has(e.right.name);
          if (lRc && rRc) {
            const ptrEq: HirExpr = {
              kind: "call",
              callee: "Rc::ptr_eq",
              args: [
                { borrow: "ref", expr: e.left },
                { borrow: "ref", expr: e.right },
              ],
            };
            return e.op === "===" ? ptrEq : { kind: "unary", op: "!", operand: ptrEq };
          }
          if (lRc !== rRc) {
            throw new UnsupportedError({
              type: "identity comparison mixes an rc binding with a non-rc operand",
            });
          }
        }
        return { ...e, left: rewrite(e.left), right: rewrite(e.right) };
      }
      case "unary":
        return { ...e, operand: rewrite(e.operand) };
      case "call": {
        // A call passing a promoted binding into a promoted param clones the
        // handle (`Rc::clone(&x)`), so the caller keeps its own handle (069). The
        // borrow drops to `owned` — the clone is an owned `Rc`, not a `&`.
        const order = autoRc.paramOrder.get(e.callee) ?? [];
        const calleePromoted = promotedParams.get(e.callee) ?? EMPTY;
        const args = e.args.map((a, i) => {
          const expr = rewrite(a.expr);
          const pname = order[i];
          const promotedParam = pname !== undefined && calleePromoted.has(pname);
          const isRc = expr.kind === "ident" && rc.has(expr.name);
          if (promotedParam && isRc) {
            return { borrow: "owned" as const, expr: { kind: "rcClone" as const, expr } };
          }
          // Cross-call read of an rc binding into a **non-promoted** callee param
          // (series 087): the param takes the inner class by shared ref (`x: &Box`),
          // but the caller holds an `Rc<RefCell<Box>>`. A bare `&a` would be
          // `&Rc<RefCell<Box>>` — an `E0308` type mismatch. Route the read through
          // the cell: `&a.borrow()` (a `Ref<Box>` that derefs to `&Box`). Only the
          // read (`ref`) form is faithful — a `refMut`/`owned` into a non-promoted
          // param can't hand a `&mut`/owned `Box` out of the shared cell, so it is
          // left as-is and the oracle (cargo) rejects it (loud, never silent).
          if (!promotedParam && isRc && a.borrow === "ref") {
            return {
              borrow: "ref" as const,
              expr: { kind: "method" as const, receiver: expr, name: "borrow", args: [] },
            };
          }
          return { ...a, expr };
        });
        return { ...e, args };
      }
      case "println":
        return { ...e, args: e.args.map((a) => rewrite(a)) };
      case "method": {
        // A call *mutates* its receiver when it is a `&mut self` class method (062)
        // or a lowered collection mutator (`insert`/`shift_remove` — the 078 /
        // issue #45 field-collection case, whose name is not in the class-method
        // `mutatingMethods` fixpoint). This drives both the `borrow` vs `borrow_mut`
        // choice below **and** the write-mode threaded into a `owner.field` receiver.
        const mutatingCall =
          mutatingMethods.has(e.name) ||
          COLLECTION_MUT_METHODS.has(e.name) ||
          // A bare in-place container mutator on a promoted captured container (086) —
          // `a.push(x)` on an rc `Vec` → `a.borrow_mut().push(x)`. Only applies when the
          // receiver is the promoted rc ident itself (a container binding), never a read.
          (CONTAINER_MUT_METHODS.has(e.name) &&
            e.receiver.kind === "ident" &&
            rc.has(e.receiver.name));
        // A field-held collection mutation on a promoted **owner** —
        // `owner.entries.insert(..)` with `owner` an rc binding (078). The `entries`
        // field itself is not promoted; only the owner is. The receiver `field` must
        // borrow the owner `borrow_mut` (a `&mut owner.field`), so thread the write
        // mode into the field rewrite. Today the plain `field` rewrite would default
        // to `.borrow()` — the write-mode bug the design fixes.
        const ownerFieldMut =
          mutatingCall &&
          e.receiver.kind === "field" &&
          e.receiver.object.kind === "ident" &&
          rc.has(e.receiver.object.name);
        // Re-entrant `RefCell` borrow guard (062 residual, surfaced for containers in
        // 086): a **mutating** call on a promoted rc ident whose **argument reads the
        // same cell** would emit `m.borrow_mut().insert(k, m.borrow()…)` — the
        // `borrow_mut()` guard is live while the arg's `borrow()` runs → runtime panic
        // (JS never panics). This is the settled 062 fail-loud shape (not a new fork):
        // `m.set(k, m.get(k) + v)` over a **shared** Map/Set/Vec. Detected on the
        // pre-rewrite args so the `m` read is still a bare ident.
        if (
          mutatingCall &&
          e.receiver.kind === "ident" &&
          rc.has(e.receiver.name) &&
          e.args.some((a) => readsRcIdent(a, e.receiver.kind === "ident" ? e.receiver.name : "", rc))
        ) {
          throw new UnsupportedError({
            type:
              `re-entrant mutation of a shared \`Rc<RefCell>\` container '${e.receiver.name}' — ` +
              `a mutating call whose argument reads the same cell (\`.borrow_mut()\` held ` +
              `across a \`.borrow()\`) would panic at runtime; split the read out into a ` +
              `local before the write (series 086 / 062 re-entrant fail-loud residual)`,
          });
        }
        const recv = rewrite(e.receiver, ownerFieldMut);
        const args = e.args.map((a) => rewrite(a));
        // A method call on a promoted binding (062) — or on a read through a
        // promoted field (069) — routes through `.borrow()` / `.borrow_mut()` per
        // the method's receiver mutability; `Rc<RefCell<C>>` has no `C` methods.
        const isRcIdent = recv.kind === "ident" && rc.has(recv.name);
        if (isRcIdent || promotedFieldRead(e.receiver)) {
          const borrowName = mutatingCall ? "borrow_mut" : "borrow";
          return {
            kind: "method",
            receiver: { kind: "method", receiver: recv, name: borrowName, args: [] },
            name: e.name,
            args,
          };
        }
        return { ...e, receiver: recv, args };
      }
      case "len":
        // `s.len()` / `.size` on an rc container (086) reads through `.borrow()`:
        // `s.borrow().len()`. A non-rc object is returned unchanged by `maybeBorrow`.
        return { ...e, object: maybeBorrow(rewrite(e.object), false) };
      case "strConcat":
        // A `+`-concatenation over parts (series string-concat): each part may read
        // through an `rc` field (`a.items.len()`), so recurse or the read misses its
        // `.borrow()`. Byte-for-byte identical when no part touches an rc handle.
        return { ...e, parts: e.parts.map((p) => rewrite(p)) };
      case "jsObjectStr":
        // A `${struct}` template interpolation (series 095): the borrowed value may
        // read through an rc field, so recurse (mirrors `strConcat`).
        return { ...e, value: rewrite(e.value) };
      case "update":
        // A value-position `++`/`--` (series 096): both the target and the embedded
        // `+= 1` step may read through an rc handle, so recurse into each.
        return { ...e, target: rewrite(e.target), step: rewrite(e.step) };
      case "array":
        return { ...e, elements: e.elements.map((el) => rewrite(el)) };
      case "hashmap":
        return {
          ...e,
          entries: e.entries.map((en) => ({
            key: rewrite(en.key),
            value: rewrite(en.value),
          })),
        };
      case "structLit": {
        // A struct literal storing into a promoted field wraps the value (069):
        // `Rc::clone(&x)` if `x` is already an `rc` handle, else `Rc::new(RefCell::…)`.
        const fields = promotedFields.get(e.name);
        return {
          ...e,
          fields: e.fields.map((f) => {
            const value = rewrite(f.value);
            return {
              ...f,
              value: fields?.has(f.name) ? wrapForField(value) : value,
            };
          }),
        };
      }
      case "ok":
        return e.value ? { ...e, value: rewrite(e.value) } : e;
      case "try":
      case "await":
      case "tryBreak":
        return { ...e, expr: rewrite(e.expr) };
      case "iterMap":
      case "iterFilter":
      case "iterFlatMap":
        return {
          ...e,
          receiver: rewrite(e.receiver),
          forwarded: e.forwarded.map((f) => rewrite(f)),
        };
      case "rcNew":
        return { ...e, inner: rewrite(e.inner) };
      case "rcClone":
        return { ...e, expr: rewrite(e.expr) };
      case "ref":
        return { ...e, expr: rewrite(e.expr) };
      case "collectVec":
        return { ...e, iter: rewrite(e.iter) };
      // Leaves: number, string, bool, ident, path.
      default:
        return e;
    }
  };

  // ── Series 077 — mutate-during-iteration over an aliased container ────────────
  //
  // The 062 panic pattern: iterating a field held in an `Rc<RefCell<T>>` alias
  // closure while the body mutates the **same** cell. The clean `for x in
  // owner.borrow().field.iter()` lowering would hold that `borrow()` across the
  // body's `borrow_mut()` → `RefCell` runtime panic (JS never panics). We rewrite it
  // to an **index-based re-borrow** loop (`forInReborrow`) that holds no borrow
  // across the body. See docs/work/077-mutate-during-iteration/design.md.

  /** The root identifier of a projection chain (`a.b[c].d` → `a`), or null. */
  const rootIdent = (e: HirExpr): string | null => {
    let cur = e;
    while (cur.kind === "field" || cur.kind === "index") cur = cur.object;
    return cur.kind === "ident" ? cur.name : null;
  };

  /** The alias-closure root of an rc local `name` in this scope, or null (unpromoted). */
  const aliasRoot = (name: string): string | null =>
    autoRc.aliasRootOf.get(`${scope}::${name}`) ?? null;

  /** Do two scope-local rc idents alias the same `Rc<RefCell<T>>` cell? */
  const sameCell = (a: string, b: string): boolean => {
    const ra = aliasRoot(a);
    return ra !== null && ra === aliasRoot(b);
  };

  const isCollectionMut = (name: string): boolean =>
    COLLECTION_MUT_METHODS.has(name);
  const isMutatingMethod = (name: string): boolean =>
    mutatingMethods.has(name) && !isCollectionMut(name);

  /**
   * Scan a **pre-rewrite** body expression for a mutation of the cell aliased by
   * `owner` (an rc ident whose iterated field is `field`). Returns:
   *   - `"none"`   — no mutation of that cell here;
   *   - `"insert"` — a **visible** collection insert on `sameCell.field` (an
   *     `__added.push` instrumentation site for the map/set drain);
   *   - `"delete"` — a **visible** collection delete on `sameCell.field` (no
   *     instrumentation; the live `contains` recheck catches it);
   *   - `"opaque"` — a mutation of the cell the emitter can't see through (a `&mut
   *     self` user-method call, or a field write) → for map/set this can't be
   *     enqueued/classified, so the loop is **fail-loud**.
   * Multiple sites in one expression collapse to the strongest signal.
   */
  const cellMutKind = (
    e: HirExpr,
    owner: string,
    field: string,
  ): "none" | "insert" | "delete" | "opaque" => {
    let acc: "none" | "insert" | "delete" | "opaque" = "none";
    const bump = (k: "insert" | "delete" | "opaque"): void => {
      const rank = { none: 0, insert: 1, delete: 1, opaque: 2 } as const;
      if (rank[k] > rank[acc]) acc = k;
      else if (acc !== "opaque" && k !== acc && rank[k] === rank[acc]) {
        // insert + delete on the same cell → treat inserts (need instrumentation)
        // as the classifying signal; deletes ride the live recheck regardless.
        acc = "insert";
      }
    };
    const visit = (x: HirExpr): void => {
      if (x.kind === "method") {
        const recvRoot = rootIdent(x.receiver);
        if (recvRoot && sameCell(recvRoot, owner)) {
          // A `&mut self` user method on the aliased cell — opaque (can't see inside).
          if (isMutatingMethod(x.name)) bump("opaque");
          // A visible collection mutator on `cell.<field>` (the lowered `.set`/`.add`
          // → `insert`, `.delete` → `shift_remove`).
          if (
            isCollectionMut(x.name) &&
            x.receiver.kind === "field" &&
            x.receiver.name === field &&
            x.receiver.object.kind === "ident" &&
            sameCell(x.receiver.object.name, owner)
          ) {
            bump(x.name === "insert" ? "insert" : "delete");
          }
        }
      }
      // A field/index write on the aliased cell is an opaque mutation of it.
      if (x.kind === "assign" && (x.target.kind === "field" || x.target.kind === "index")) {
        const root = rootIdent(x.target);
        if (root && sameCell(root, owner)) bump("opaque");
      }
      for (const c of subExprsRc(x)) visit(c);
    };
    visit(e);
    return acc;
  };

  /** The strongest cell-mutation signal across a whole (pre-rewrite) body. */
  const bodyCellMut = (
    stmts: HirStmt[],
    owner: string,
    field: string,
  ): "none" | "insert" | "delete" | "opaque" => {
    let acc: "none" | "insert" | "delete" | "opaque" = "none";
    const rank = { none: 0, insert: 1, delete: 1, opaque: 2 } as const;
    const merge = (k: "none" | "insert" | "delete" | "opaque"): void => {
      if (rank[k] > rank[acc]) acc = k;
      else if (k !== "none" && k !== acc && rank[k] === rank[acc]) acc = "insert";
    };
    const walk = (s: HirStmt): void => {
      for (const e of stmtExprsRc(s)) merge(cellMutKind(e, owner, field));
      for (const b of childBodiesRc(s)) for (const c of b) walk(c);
    };
    for (const s of stmts) walk(s);
    return acc;
  };

  /**
   * The (pre-promotion) field type of a class, for the container-shape route + the
   * element-`Clone` gate.
   */
  const fieldTy = (cls: string, field: string): RustType | null =>
    classFields.get(cls)?.find((f) => f.name === field)?.ty ?? null;

  /**
   * Detect the 062 panic pattern on a `for-of` and, when found, rewrite it to the
   * index-based `forInReborrow` loop; else return null (the caller keeps the clean
   * lowering). Runs on the **pre-rewrite** `forIn` node so it can read `owner.field`
   * before `.borrow()` is spliced in.
   */
  const tryReborrow = (
    s: Extract<HirStmt, { kind: "forIn" }>,
  ): HirStmt | null => {
    // Shape: `owner.field.iter()` (array/map/set) with `owner` an rc ident.
    if (
      s.iter.kind !== "method" ||
      s.iter.name !== "iter" ||
      s.iter.args.length !== 0 ||
      s.iter.receiver.kind !== "field"
    ) {
      return null;
    }
    const container = s.iter.receiver; // `owner.field`
    if (container.object.kind !== "ident") return null;
    const owner = container.object.name;
    const field = container.name;
    if (!rc.has(owner)) return null; // not an rc-promoted cell — clean lowering.

    // Body must mutate the *same* aliased cell (else the clean lowering is fine —
    // an aliased loop with a non-mutating body stays byte-for-byte unchanged).
    const mut = bodyCellMut(s.body, owner, field);
    if (mut === "none") return null;

    // Container shape + element-`Clone` gate. The field type is the inner collection.
    const cls = bindingClass.get(owner);
    const cty = cls ? fieldTy(cls, field) : null;
    if (!cty) return null; // can't resolve the container shape → leave it cargo-loud.

    const elemNonClone = (elem: RustType): void => {
      if (!isTypeCloneable(elem, structs)) {
        throw new UnsupportedError({
          type:
            "mutate-during-iteration over an aliased container whose element is not " +
            "`Clone` — cannot clone the element out per step to release the borrow " +
            "(series 077 fail-loud residual)",
        });
      }
    };

    /**
     * Wrap each **visible** `insert` on the iterated cell's field (a rc-rewritten
     * `<alias>.borrow_mut().<field>.insert(k, v)` / `.insert(x)`) with the
     * `__added077` enqueue guard: `let __new077 = !<cell>.borrow().<field>.contains…;
     * <insert>; if __new077 { __added077.push(<key>); }`. A newly-added key enters
     * the two-phase drain and is visited in insertion order; a re-insert of an
     * existing key isn't double-queued. Deletes are left untouched — the loop's live
     * `contains`/`get` recheck skips them.
     */
    const instrumentMapInserts = (stmts: HirStmt[], isMap: boolean): void => {
      // The rc-rewritten insert receiver is `<alias>.borrow_mut().<field>`; extract
      // the aliased ident so we can (a) confirm it's the same cell and (b) build a
      // `.borrow()` read handle for the `contains` recheck.
      const aliasIdentOf = (obj: HirExpr): string | null => {
        if (
          obj.kind === "field" &&
          obj.name === field &&
          obj.object.kind === "method" &&
          (obj.object.name === "borrow_mut" || obj.object.name === "borrow") &&
          obj.object.receiver.kind === "ident"
        ) {
          return obj.object.receiver.name;
        }
        return null;
      };
      const cellInsertAlias = (e: HirExpr): string | null => {
        if (e.kind !== "method" || e.name !== "insert" || e.receiver.kind !== "field") {
          return null;
        }
        const alias = aliasIdentOf(e.receiver);
        return alias && sameCell(alias, owner) ? alias : null;
      };
      const rewriteSeq = (list: HirStmt[]): void => {
        for (let i = 0; i < list.length; i++) {
          const st = list[i] as HirStmt;
          const alias = st.kind === "expr" ? cellInsertAlias(st.expr) : null;
          if (st.kind === "expr" && alias) {
            const ins = st.expr as Extract<HirExpr, { kind: "method" }>;
            const key = ins.args[0] as HirExpr;
            // `!<alias>.borrow().<field>.contains(_key)(&<key>)` — is the key new?
            const contains: HirExpr = {
              kind: "method",
              name: isMap ? "contains_key" : "contains",
              receiver: {
                kind: "field",
                name: field,
                object: {
                  kind: "method",
                  name: "borrow",
                  receiver: { kind: "ident", name: alias },
                  args: [],
                },
              },
              args: [{ kind: "ref", mut: false, expr: key }],
            };
            const guardLet: HirStmt = {
              kind: "let",
              name: "__new077",
              mut: false,
              ty: null,
              init: { kind: "unary", op: "!", operand: contains },
            };
            const pushIf: HirStmt = {
              kind: "if",
              cond: { kind: "ident", name: "__new077" },
              conseq: [
                {
                  kind: "expr",
                  expr: {
                    kind: "method",
                    name: "push",
                    receiver: { kind: "ident", name: "__added077" },
                    args: [{ kind: "method", name: "clone", receiver: key, args: [] }],
                  },
                },
              ],
              alt: null,
            };
            list[i] = { kind: "block", body: [guardLet, st, pushIf] };
            continue;
          }
          for (const b of childBodiesRc(st)) rewriteSeq(b);
        }
      };
      rewriteSeq(stmts);
    };

    // Parse the loop pattern back into binders (the string forms `lowerForOf` built).
    const pat = s.pat;

    // Materialize the loop binder as a **real HIR `let`** over an owned per-step
    // clone (`__x077` / `__k077` / `__v077`, provided by the emitter). Owned (not
    // `&T`) so the body's element comparisons/arithmetic type-check, and a real HIR
    // binding so `refineOwnership` clones a reused non-`Copy` binder. A struct-key
    // newtype (074) destructures in the `let` pattern.
    const binderLet = (
      name: string,
      newtype: string | undefined,
      owned: string,
    ): HirStmt => ({
      kind: "let",
      name,
      mut: false,
      ty: null,
      pat: newtype ? `${newtype}(${name})` : undefined,
      init: { kind: "raw", text: owned },
    });

    if (cty.kind === "vec") {
      // Array — a live positional walk. No body instrumentation, fully faithful.
      elemNonClone(cty.elem);
      const { name, newtype } = parseElemPat(pat);
      walkSeq(s.body); // rc-rewrite the body in place.
      s.body.unshift(binderLet(name, newtype, "__x077"));
      return {
        kind: "forInReborrow",
        shape: "array",
        owner: { kind: "ident", name: owner },
        field,
        body: s.body,
        binder: name,
        elemNewtype: newtype,
        label: s.label,
      };
    }

    if (cty.kind === "hashmap" || cty.kind === "set") {
      // Map/Set — a stable key-snapshot + `__added` append-buffer + `__seen`
      // once-guard drain. An **opaque** mutation of the cell can't be classified
      // (add vs delete) → fail-loud; a visible insert is instrumented, a visible
      // delete rides the live recheck.
      if (mut === "opaque") {
        throw new UnsupportedError({
          type:
            "mutate-during-iteration over an aliased Map/Set through an opaque cell " +
            "mutation (a call the emitter can't see through) — a mid-iteration add " +
            "can't be enqueued for a faithful visitation (series 077 fail-loud residual)",
        });
      }
      const keyTy = cty.kind === "hashmap" ? cty.key : cty.elem;
      elemNonClone(keyTy);
      if (cty.kind === "hashmap") elemNonClone(cty.value);
      walkSeq(s.body); // rc-rewrite the body in place.
      // Instrument each **visible** insert on the iterated cell — enqueue a
      // newly-added key into the `__added077` drain so a mid-iteration add is
      // visited in insertion order (the design's two-phase drain).
      instrumentMapInserts(s.body, cty.kind === "hashmap");
      if (cty.kind === "hashmap") {
        const { keyName, keyNewtype, valName } = parseMapPat(pat);
        // Bind value then key (both owned per-step clones) ahead of the body.
        s.body.unshift(
          binderLet(keyName, keyNewtype, "__k077"),
          binderLet(valName, undefined, "__v077"),
        );
        return {
          kind: "forInReborrow",
          shape: "map",
          owner: { kind: "ident", name: owner },
          field,
          body: s.body,
          binder: valName,
          keyBinder: keyName,
          keyNewtype,
          keyType: keyTy,
          label: s.label,
        };
      }
      const { name, newtype } = parseElemPat(pat);
      s.body.unshift(binderLet(name, newtype, "__k077"));
      return {
        kind: "forInReborrow",
        shape: "set",
        owner: { kind: "ident", name: owner },
        field,
        body: s.body,
        binder: name,
        elemNewtype: newtype,
        keyType: keyTy,
        label: s.label,
      };
    }

    return null; // any other container shape — leave it cargo-loud.
  };

  /** Walk each statement in a body, replacing a slot when `walkStmt` rewrites it. */
  const walkSeq = (stmts: HirStmt[]): void => {
    for (let i = 0; i < stmts.length; i++) {
      const replaced = walkStmt(stmts[i] as HirStmt);
      if (replaced) stmts[i] = replaced;
    }
  };

  const walkStmt = (s: HirStmt): HirStmt | null => {
    switch (s.kind) {
      case "let": {
        // Rewrite reads in the initializer *before* this binding is in scope.
        s.init = rewrite(s.init);
        const classTy =
          s.ty?.kind === "struct" && classes.has(s.ty.name) ? s.ty : null;
        if (classTy) bindingClass.set(s.name, classTy.name);
        else {
          const cls = classOfType(s.ty, classes);
          if (cls) bindingClass.set(s.name, cls);
        }
        const alias = s.init.kind === "ident" && rc.has(s.init.name);
        // Promote when a `"use rc"` directive covers *any* class binding (028b), or when
        // the alias-escape analysis selected this binding (062/069 class; 086 a
        // shared/aliased captured **container** — `const s = new Set()` / `const t = s`).
        const promote = (directive && classTy) || promotedLocals.has(s.name);
        if (promote) {
          s.init = alias
            ? { kind: "rcClone", expr: s.init }
            : { kind: "rcNew", inner: s.init };
          // Wrap the declared type in `Rc<RefCell<T>>` for a class (069) or a container
          // (086); a bare untyped container binding (`const acc = []`, `s.ty === null`)
          // has no annotation to wrap — the `Rc::new(RefCell::new(..))` init + turbofish
          // carries the type. `wrapRc` is idempotent and container-generic.
          if (classTy) s.ty = { kind: "rc", inner: classTy };
          else if (s.ty) s.ty = wrapRc(s.ty, classes);
          s.mut = false; // RefCell gives interior mutability — the handle is not `mut`.
          rc.add(s.name);
        }
        return null;
      }
      case "expr":
        s.expr = rewrite(s.expr);
        return null;
      case "return":
        if (s.value) s.value = rewrite(s.value);
        return null;
      case "throw":
        s.value = rewrite(s.value);
        return null;
      case "breakTry":
        s.value = rewrite(s.value);
        return null;
      case "if":
        s.cond = rewrite(s.cond);
        walkSeq(s.conseq);
        if (s.alt) walkSeq(s.alt);
        return null;
      case "while":
        s.cond = rewrite(s.cond);
        walkSeq(s.body);
        return null;
      case "block":
        walkSeq(s.body);
        return null;
      case "forIn": {
        // Series 077: the 062 mutate-during-iteration panic pattern rewrites to the
        // index-based `forInReborrow` (which rc-rewrites the body itself). Otherwise
        // fall through to the clean lowering.
        const reborrow = tryReborrow(s);
        if (reborrow) return reborrow;
        s.iter = rewrite(s.iter);
        walkSeq(s.body);
        return null;
      }
      case "forInReborrow":
        // Only produced by `tryReborrow` above, whose body was already rc-rewritten;
        // never re-entered, but recurse defensively if it ever nests.
        walkSeq(s.body);
        return null;
      case "forRange":
        s.start = rewrite(s.start);
        s.end = rewrite(s.end);
        walkSeq(s.body);
        return null;
      case "match":
        s.disc = rewrite(s.disc);
        for (const arm of s.arms) {
          if (arm.guard) arm.guard = rewrite(arm.guard);
          walkSeq(arm.body);
        }
        return null;
      case "tryCatch":
        walkSeq(s.tryBody);
        walkSeq(s.catchBody);
        if (s.finallyBody) walkSeq(s.finallyBody);
        return null;
      case "tryBlock":
        walkSeq(s.tryBody);
        if (s.catchBody) walkSeq(s.catchBody);
        if (s.finallyBody) walkSeq(s.finallyBody);
        return null;
      // break / continue: no operands.
    }
    return null;
  };

  walkSeq(body);
}

const EMPTY: ReadonlySet<string> = new Set();

// ── Series 077 traversal + pattern helpers ─────────────────────────────────────

/** Direct sub-expressions of an expression (shallow), for the mutate-scan walk. */
function subExprsRc(e: HirExpr): HirExpr[] {
  switch (e.kind) {
    case "assign":
      return [e.target, e.value];
    case "binary":
      return [e.left, e.right];
    case "unary":
      return [e.operand];
    case "call":
      return e.args.map((a) => a.expr);
    case "println":
      return e.args;
    case "method":
      return [e.receiver, ...e.args];
    case "index":
      return [e.object, e.index];
    case "field":
    case "len":
      return [e.object];
    case "array":
      return e.elements;
    case "structLit":
      return e.fields.map((f) => f.value);
    case "ok":
      return e.value ? [e.value] : [];
    case "try":
    case "await":
    case "tryBreak":
      return [e.expr];
    case "ref":
      return [e.expr];
    case "rcNew":
      return [e.inner];
    case "rcClone":
      return [e.expr];
    case "collectVec":
      return [e.iter];
    default:
      return [];
  }
}

/** The expressions directly held by a statement (not its nested bodies). */
function stmtExprsRc(s: HirStmt): HirExpr[] {
  switch (s.kind) {
    case "let":
      return [s.init];
    case "expr":
      return [s.expr];
    case "return":
      return s.value ? [s.value] : [];
    case "throw":
    case "breakTry":
      return [s.value];
    case "if":
    case "while":
      return [s.cond];
    case "forIn":
      return [s.iter];
    case "forRange":
      return [s.start, s.end];
    case "match":
      return [s.disc, ...s.arms.flatMap((a) => (a.guard ? [a.guard] : []))];
    default:
      return [];
  }
}

/** The nested statement bodies of a statement (for the recursive mutate-scan). */
function childBodiesRc(s: HirStmt): HirStmt[][] {
  switch (s.kind) {
    case "if":
      return s.alt ? [s.conseq, s.alt] : [s.conseq];
    case "while":
    case "block":
    case "forIn":
    case "forInReborrow":
    case "forRange":
      return [s.body];
    case "match":
      return s.arms.map((a) => a.body);
    case "tryCatch":
      return [
        s.tryBody,
        s.catchBody,
        ...(s.finallyBody ? [s.finallyBody] : []),
      ];
    case "tryBlock":
      return [
        s.tryBody,
        ...(s.catchBody ? [s.catchBody] : []),
        ...(s.finallyBody ? [s.finallyBody] : []),
      ];
    default:
      return [];
  }
}

/**
 * Parse a single-element `for-of` pattern string (`lowerForOf` output) — a bare
 * name `x` or a struct-key newtype `PointKey(x)` (series 074) — into its inner
 * binder + optional newtype wrapper.
 */
function parseElemPat(pat: string): { name: string; newtype?: string } {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\(([A-Za-z_][A-Za-z0-9_]*)\)$/.exec(pat);
  if (m) return { name: m[2] as string, newtype: m[1] as string };
  return { name: pat };
}

/**
 * Parse a map `for-of` pattern `(kPat, vName)` — where `kPat` is a bare key name or
 * a struct-key newtype `PointKey(k)` — into the key binder (+ newtype) and value
 * binder.
 */
function parseMapPat(pat: string): {
  keyName: string;
  keyNewtype?: string;
  valName: string;
} {
  const inner = pat.replace(/^\(|\)$/g, "");
  // Split on the top-level comma (a newtype key may itself contain `(k)`).
  let depth = 0;
  let split = -1;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      split = i;
      break;
    }
  }
  const kPart = (split >= 0 ? inner.slice(0, split) : inner).trim();
  const vPart = (split >= 0 ? inner.slice(split + 1) : "").trim();
  const k = parseElemPat(kPart);
  return { keyName: k.name, keyNewtype: k.newtype, valName: vPart };
}
