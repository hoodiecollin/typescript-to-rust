/**
 * Alias-escape analysis — auto-`Rc<RefCell<T>>` for escaping shared-mutable
 * aliasing. Series 062 shipped the **intraprocedural** core; series 069 (issue
 * #38) lifts it to a **module-level** analysis so promotion threads across the two
 * boundaries 062 left cargo-loud (never a silent miscompile):
 *
 *   - **Interprocedural** — an aliased class binding passed into a callee that
 *     **retains** it (stores it in a field, or forwards it into a construction)
 *     propagates promotion across the call boundary. The callee's param takes
 *     `Rc<RefCell<T>>` and the call site passes `Rc::clone(&x)`.
 *   - **Field-store** — `container.f = a` (or `this.f = a` in a ctor, or a struct
 *     literal `X { f: a }`) joins the container's field `X#f` to `a`'s alias
 *     closure, so a mutation through either handle promotes both — and the field's
 *     declared type follows to `Rc<RefCell<T>>`.
 *
 * A JS object *is* a shared mutable reference: `const b = a; a.inc(); use(b)`
 * expects `b` to observe the mutation. Option A lowers `const b = a` as a move (or
 * an independent `.clone()`), so a later mutation of one alias is invisible to the
 * other. This pass promotes the whole alias closure — bindings, params, **and**
 * fields — to `Rc<RefCell<T>>` (via the existing `refineRc` machinery), the
 * faithful model of JS reference semantics.
 *
 * ## Model
 *
 * A single **union-find** over three namespaces threads aliasing across scopes:
 *
 *   - a local binding / param  → `"<scope>::<name>"` (scope = free-fn name /
 *     `SCRIPT_SCOPE` / a ctor's `"<Class>::new"` / a method's `"<Class>.<method>"`).
 *   - a class field            → `"<Class>#<field>"`.
 *
 * Edges (unions): a bare-ident alias `const b = a`; a field-store `x.f = a` /
 * `this.f = a` / a struct literal `X { f: a }` (binding ↔ `X#f`); and an
 * **arg↔param** edge at every call `f(x)` passing a class binding into param `i`
 * (binding ↔ `<f>::<param_i>`). Unioning first, then propagating the **mutation**
 * flag through the merged components, is the interprocedural fixpoint: a component
 * that contains any mutated member is promoted whole, so a mutation in one scope
 * reaches a param/field aliased from another.
 *
 * ## Fail-loud residual
 *
 * The out-of-reach boundary (indirect/dynamic dispatch, or an alias the analysis
 * cannot resolve to a promotable component) stays cargo-loud — cargo is the
 * ultimate backstop, never a silent divergence. The mutate-during-iteration guard
 * stays the 062 `DialectError` (issue #41 owns its robust lowering).
 *
 * The promoted-set representation (`AutoRcResult`) is the shared foundation the
 * downstream ownership items (#35 owned-self, #45 field-collection, #41
 * mutate-during-iteration) graft onto.
 */

import { SCRIPT_SCOPE } from "./analysis";
import { buildStructTable, isTypeCloneable } from "./derives";
import { DialectError } from "./errors";
import type {
  HirClass,
  HirExpr,
  HirFn,
  HirModule,
  HirStmt,
  RustType,
} from "./hir";
import { computeLiveOut } from "./ownership";

/**
 * The module-level auto-`Rc` promotion result (series 069). The three coordinated
 * maps are the **single promoted-set representation** feeding `refineRc`; #35/#45/#41
 * extend this shape, they do not replace it.
 */
export interface AutoRcResult {
  /**
   * Scope key (free-fn name / `SCRIPT_SCOPE` / `"<Class>::new"` / `"<Class>.<m>"`)
   * → the local bindings **and params** in that scope promoted to `Rc<RefCell<T>>`.
   */
  promoted: Map<string, Set<string>>;
  /**
   * Callee key (a free-fn name or `"<Class>::new"`) → the param names promoted to
   * `Rc<RefCell<T>>`. Drives the call-site `Rc::clone(&x)` and the param-type
   * rewrite in `refineRc`.
   */
  promotedParams: Map<string, Set<string>>;
  /**
   * Class name → the field names promoted to `Rc<RefCell<T>>`. Drives the struct
   * field-type rewrite, the struct-literal `Rc::clone`/`Rc::new`, and the
   * `.borrow()` on a read through the field.
   */
  promotedFields: Map<string, Set<string>>;
  /**
   * Callee key (a free fn / `"<Class>::new"`) → its positional param names. Lets a
   * call site map an arg index to the param name (and so decide whether to
   * `Rc::clone` the handle). Every promotable callee has an entry.
   */
  paramOrder: Map<string, string[]>;
  /**
   * **Consuming methods** (series 068, issue #35) — the method names finalized to
   * an owned receiver (`fn m(self)`, dropping the 038 field clone). A consuming
   * candidate (`m(): T { return this.field }`, `analysis.consumingCandidates`)
   * lands here iff its moved-out field is **non-`Copy`** *and* no call site reuses
   * the receiver. A candidate whose receiver **is** reused after the call is
   * excluded (demoted): that receiver promotes to `Rc<RefCell<T>>` (via `promoted`,
   * the same union-find), so the method must fall back to `&self` + clone — and if
   * the moved-out field is non-`Clone`, `computeAutoRc` already threw a
   * `DialectError` (the documented reconciliation boundary). The downstream
   * owned-`self` pass reads this set to set `recv: "owned"`.
   */
  consumingMethods: Set<string>;
  /**
   * **Alias-closure membership** (series 077 / issue #41) — a union-find key
   * (`"<scope>::<name>"` local/param, or `"<Class>#<field>"` field) → its component
   * root id, restricted to the **promoted** keys. Two promoted handles share a root
   * iff they alias the *same* `Rc<RefCell<T>>` cell. The mutate-during-iteration
   * lowering reads this to decide whether a loop body mutates the **same** cell it
   * iterates (the 062 panic trigger) — reusing 062's transitive closure, not a new
   * analysis. Only promoted keys appear; a non-promoted binding has no entry.
   */
  aliasRootOf: Map<string, string>;
}

/**
 * The **lowered** HIR method names a `Map`/`Set` field-collection mutation lowers
 * to (series 078 / issue #45): `set`/`add` → `insert`, `delete` → `shift_remove`
 * (see `lower.ts` `tryMapSetMethod`). A call to one of these on a `owner.field`
 * receiver marks the owner mutated in the alias union-find. Kept in lockstep with
 * the lowering — the pre-lowering source names live in `analysis.ts`
 * (`MUTATING_METHODS`); these are their post-lowering forms.
 */
const COLLECTION_MUT_METHODS = new Set<string>(["insert", "shift_remove"]);

/**
 * The **lowered** HIR mutator names for a **captured container** promotion seed
 * (series 086 / issue #46). A bare-ident collection mutator inside a lifted
 * `__arrow_n` fn (`s.insert(x)` / `xs.push(x)` — the lowered `Set.add` / `Array.push`)
 * marks that container binding mutated in the alias union-find, so a shared/aliased
 * captured container (`const t = s`) promotes to `Rc<RefCell<T>>`. Covers the `Map`/`Set`
 * lowered forms (`insert`/`shift_remove`) plus the array in-place mutators (`push`/`pop`
 * and the lowered `remove`/`insert` shapes). Kept in lockstep with `lower.ts`
 * (`CAPTURE_MUTATORS`, the pre-lowering source names).
 */
const CONTAINER_MUT_METHODS = new Set<string>([
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

/**
 * Is a lowered type a **capture container** (series 086): a `Vec`, `Set` (`IndexSet`),
 * `Map` (`IndexMap`), or `String` — the shapes a stored closure threads and, when
 * aliased, promotes to `Rc<RefCell<T>>`. Mirrors `isCaptureContainerType` in `lower.ts`.
 * A `ref`/`rc` wrapper resolves to its inner (a threaded `&mut Set` param is still a
 * container binding for the alias union-find).
 */
function containerTypeOf(ty: RustType | null | undefined): RustType | null {
  if (!ty) return null;
  if (
    ty.kind === "vec" ||
    ty.kind === "set" ||
    ty.kind === "hashmap" ||
    ty.kind === "String"
  ) {
    return ty;
  }
  if (ty.kind === "ref") return containerTypeOf(ty.inner);
  if (ty.kind === "rc") return containerTypeOf(ty.inner);
  return null;
}

/** The scope key for a class ctor (its associated `new`). */
function ctorScope(cls: string): string {
  return `${cls}::new`;
}
/** The scope key for a class method. */
function methodScope(cls: string, m: string): string {
  return `${cls}.${m}`;
}
/** The union-find key for a scope-local binding / param. */
function localKey(scope: string, name: string): string {
  return `${scope}::${name}`;
}
/** The union-find key for a class field. */
function fieldKey(cls: string, field: string): string {
  return `${cls}#${field}`;
}

/** Unwrap a `try` (fallible-ctor `?`) around a construction init. */
function unwrapTry(e: HirExpr): HirExpr {
  return e.kind === "try" ? e.expr : e;
}

/** The class name a `let` initializer constructs (`new C()` / a struct literal), or null. */
function constructedClass(
  init: HirExpr,
  classes: ReadonlySet<string>,
): string | null {
  const e = unwrapTry(init);
  if (e.kind === "structLit" && classes.has(e.name)) return e.name;
  if (e.kind === "call") {
    const seg = e.callee.split("::");
    if (seg.length === 2 && seg[1] === "new" && classes.has(seg[0] as string)) {
      return seg[0] as string;
    }
  }
  return null;
}

/**
 * Does a `let` initializer construct a container (series 086): a `Set`/`Map`
 * construction (`setNew`/`mapNew`), an array literal, a `hashmap` literal, or a string?
 * Used to track a container binding whose declared type isn't a resolved container yet
 * (e.g. an un-annotated `const acc = []`). A `ref`/`try`-wrapped init unwraps first.
 */
function isContainerInit(init: HirExpr): boolean {
  const e = unwrapTry(init);
  return (
    e.kind === "setNew" ||
    e.kind === "mapNew" ||
    e.kind === "array" ||
    e.kind === "hashmap" ||
    e.kind === "string"
  );
}

/** The root identifier of a projection chain (`a.b[c].d` → `a`), or null. */
function rootIdent(e: HirExpr): string | null {
  let cur = e;
  while (cur.kind === "field" || cur.kind === "index") cur = cur.object;
  return cur.kind === "ident" ? cur.name : null;
}

/** The class name a lowered type resolves to (`struct C` / `&C` / `Rc<RefCell<C>>`), or null. */
function classOfType(ty: RustType | null | undefined, classes: ReadonlySet<string>): string | null {
  if (!ty) return null;
  if (ty.kind === "struct" && classes.has(ty.name)) return ty.name;
  if (ty.kind === "ref") return classOfType(ty.inner, classes);
  if (ty.kind === "rc") return classOfType(ty.inner, classes);
  return null;
}

/**
 * Is a moved-out field type **non-`Copy`** (series 068)? Copy scalars (`f64`,
 * `usize`, `i64`, `bool`, an `enum`-backed integer) are returned by value for free —
 * no owned-`self` benefit. Everything else (`String`, `Vec`/`HashMap`/`Set`,
 * `Option`, a struct/class, a fn-pointer field, …) is non-`Copy`, so a `return
 * this.field` move-out is what owned-`self` exists to make clone-free.
 */
function isNonCopyMovable(ty: RustType, _classes: ReadonlySet<string>): boolean {
  switch (ty.kind) {
    case "f64":
    case "usize":
    case "i64":
    case "i128":
    case "bool":
    case "unit":
      return false;
    default:
      return true;
  }
}

/**
 * A call to a free fn or a class ctor, resolved to its `(scope, class?)`. `null`
 * for a method / dynamic / non-user callee (an unresolvable boundary — the arg
 * edge is simply not threaded, and cargo stays the backstop).
 */
function calleeInfo(
  callee: string,
  classes: ReadonlySet<string>,
  freeFns: ReadonlySet<string>,
): { scope: string; cls: string | null } | null {
  const seg = callee.split("::");
  if (seg.length === 2 && seg[1] === "new" && classes.has(seg[0] as string)) {
    return { scope: ctorScope(seg[0] as string), cls: seg[0] as string };
  }
  if (seg.length === 1 && freeFns.has(callee)) return { scope: callee, cls: null };
  return null;
}

/**
 * The module-level alias-escape analysis (series 069). One union-find over
 * bindings, params, and fields; a mutation-flag propagation to a fixpoint; then a
 * projection back into the three-part `AutoRcResult`.
 */
export function computeAutoRc(
  module: HirModule,
  classes: ReadonlySet<string>,
  mutatingMethods: ReadonlySet<string>,
  consumingCandidates: ReadonlyMap<string, string> = new Map(),
): AutoRcResult {
  const parent = new Map<string, string>();
  const mutated = new Set<string>(); // union-find keys directly mutated.
  // Container union-find keys that are **truly shared** in an outer scope (series 086):
  // a container binding that received a bare-ident **container alias** edge `const t = s`.
  // A captured container promotes to `Rc<RefCell<T>>` **only** when its component is
  // both mutated *and* contains a `containerShared` member — the arg→param thread into a
  // lifted `__arrow_n` alone (which every captured container has) is **not** sharing, so
  // it can't trigger promotion. This is the owned-`&mut` (079) vs shared-`Rc` (086) split.
  const containerShared = new Set<string>();
  // Union-find keys that belong to the **container** namespace (a `Vec`/`Set`/`Map`/
  // `String` binding or param), so the promotion gate can apply the container-specific
  // `containerShared` rule to them and the class-specific ≥2-member rule to classes.
  const containerKey = new Set<string>();
  // Union-find keys **force-promoted** by the series-068 consuming edge: a receiver
  // that is live *after* a consuming (`fn m(self)`) call must become `Rc<RefCell<T>>`
  // rather than move (a consumed-then-reused object is shared-mutable). Unlike
  // `mutated`, this bypasses the ≥2-member size gate — a lone reused receiver still
  // promotes (there is no separate alias, the sharing is with the consumed handle).
  const forcePromote = new Set<string>();
  // The moved-out field type per candidate method (for the non-`Copy` / non-`Clone`
  // gates), and the class each candidate belongs to.
  const structs = buildStructTable(module.items);
  const candidateField = new Map<string, { cls: string; field: RustType }>();
  for (const item of module.items) {
    if (item.kind !== "class") continue;
    for (const m of item.methods) {
      const fieldName = consumingCandidates.get(m.name);
      if (fieldName === undefined) continue;
      const fty = item.fields.find((f) => f.name === fieldName)?.ty;
      if (fty) candidateField.set(m.name, { cls: item.name, field: fty });
    }
  }
  // A candidate emits consuming only for a **non-`Copy`** moved-out field (a Copy
  // field needs no move-avoidance and re-emitting it owned churns call sites).
  const nonCopyCandidates = new Set<string>();
  for (const [name, { field }] of candidateField) {
    if (isNonCopyMovable(field, classes)) nonCopyCandidates.add(name);
  }
  // Candidates demoted because some call site **reuses** the receiver — they revert
  // to `&self` + clone (and their reused receiver promotes to `Rc<RefCell<T>>`).
  const demoted = new Set<string>();

  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) {
      r = parent.get(r) as string;
    }
    return r;
  };
  const ensure = (x: string): void => {
    if (parent.get(x) === undefined) parent.set(x, x);
  };
  const unite = (a: string, b: string): void => {
    ensure(a);
    ensure(b);
    parent.set(find(a), find(b));
  };

  const freeFns = new Set<string>();
  for (const item of module.items) if (item.kind === "fn") freeFns.add(item.name);

  // Param name lists per callee key (free fn + ctor) — args are matched positionally.
  const paramNames = new Map<string, string[]>();
  const paramClass = new Map<string, (string | null)[]>();
  // Positional "is a container param" flags (series 086) — a threaded `__arrow_n`
  // container param (`&mut Set` / `Set` / …) so a container arg unions into it.
  const paramContainer = new Map<string, boolean[]>();
  const recordFnParams = (key: string, fn: HirFn): void => {
    paramNames.set(key, fn.params.map((p) => p.name));
    paramClass.set(key, fn.params.map((p) => classOfType(p.ty, classes)));
    paramContainer.set(key, fn.params.map((p) => containerTypeOf(p.ty) !== null));
  };
  for (const item of module.items) {
    if (item.kind === "fn") recordFnParams(item.name, item);
    if (item.kind === "class" && item.ctor) recordFnParams(ctorScope(item.name), item.ctor);
  }

  /** Note a store of `<value>` (an ident) into `<containerClass>#<field>`. */
  const noteFieldStore = (containerClass: string, field: string, value: HirExpr): void => {
    if (value.kind === "ident") {
      unite(fieldKey(containerClass, field), localKey(currentScope, value.name));
    }
  };

  let currentScope = SCRIPT_SCOPE;
  let currentBindingClass = new Map<string, string>();
  // Container bindings/params in the current scope (series 086) — a `Vec`/`Set`/`Map`/
  // `String` local or a threaded `__arrow_n` container param. Tracked alongside class
  // bindings so a shared/aliased captured container (`const t = s`) threads its alias +
  // arg edges into the **same** union-find and promotes to `Rc<RefCell<T>>` when
  // mutated. A binding is "tracked" for the alias/arg edges iff it is a class **or** a
  // container binding.
  let currentContainerBinding = new Set<string>();
  const isTracked = (name: string): boolean =>
    currentBindingClass.has(name) || currentContainerBinding.has(name);

  /** Record mutations + alias/field/arg edges in one expression. */
  const noteExpr = (e: HirExpr): void => {
    // Field/index write `x.f = …` / `x[i] = …` → the root binding is mutated;
    // a field-store `container.f = a` also unions the field into a's closure.
    if (e.kind === "assign") {
      if (e.target.kind === "field" || e.target.kind === "index") {
        const root = rootIdent(e.target);
        if (root) mutated.add(localKey(currentScope, root));
      }
      // `container.f = a` (both class bindings): field-store alias edge.
      if (e.target.kind === "field" && e.value.kind === "ident") {
        const containerCls =
          e.target.object.kind === "ident"
            ? currentBindingClass.get(e.target.object.name)
            : undefined;
        if (containerCls) noteFieldStore(containerCls, e.target.name, e.value);
      }
    }
    // A `&mut self` method call mutates its receiver's root binding.
    if (e.kind === "method" && mutatingMethods.has(e.name)) {
      const root = rootIdent(e.receiver);
      if (root) mutated.add(localKey(currentScope, root));
    }
    // A field-held collection mutation `owner.field.<mut>()` (series 078 / issue
    // #45) mutates the **owner** through its field — one more alias shape feeding
    // the same union-find. The lowered receiver is a `field` (`owner.entries`) and
    // the method is a collection mutator (`insert` / `shift_remove`, the lowered
    // `Map`/`Set` `set`/`add`/`delete`). Marking the owner mutated is the promotion
    // trigger: an aliased / field-stored owner (a ≥2-member component) then promotes
    // to `Rc<RefCell<T>>`, and the mutation lowers to `owner.borrow_mut().field.<mut>()`
    // in `refineRc`. A plainly-owned owner (a lone component) stays a clean `&mut`
    // (the ≥2-member gate keeps it unwrapped, matching 072's clean path).
    if (
      e.kind === "method" &&
      COLLECTION_MUT_METHODS.has(e.name) &&
      e.receiver.kind === "field"
    ) {
      const root = rootIdent(e.receiver);
      if (root) mutated.add(localKey(currentScope, root));
    }
    // A **bare-ident** collection mutator on a tracked container binding (series 086 /
    // issue #46) — `s.insert(x)` / `xs.push(x)` inside a lifted `__arrow_n` on a threaded
    // container **param** (or on a local container). This is the captured-container
    // promotion seed: it marks the container mutated so an aliased owner (a ≥2-member
    // component via the `const t = s` alias edge + the arg→param thread) promotes to
    // `Rc<RefCell<T>>`. A **lone** owned container (1-member component) is left on 079's
    // `&mut` path by the ≥2-member gate. A field receiver is the 078 case above.
    if (
      e.kind === "method" &&
      CONTAINER_MUT_METHODS.has(e.name) &&
      e.receiver.kind === "ident" &&
      currentContainerBinding.has(e.receiver.name)
    ) {
      mutated.add(localKey(currentScope, e.receiver.name));
    }
    // A struct literal `X { f: a }` stores each ident field into `X#f`.
    if (e.kind === "structLit" && classes.has(e.name)) {
      for (const f of e.fields) noteFieldStore(e.name, f.name, f.value);
    }
    // A call `f(x)` / `C::new(x)` / `__arrow_n(s, a)` threads each class-**or-container**
    // binding arg into the callee's param (series 069 class; series 086 container). The
    // arg→param edge is what unions a shared captured container's outer binding with the
    // `__arrow_n` container param, so the mutation seed inside the lifted fn reaches the
    // outer alias closure.
    if (e.kind === "call") {
      const info = calleeInfo(e.callee, classes, freeFns);
      if (info) {
        const names = paramNames.get(info.scope) ?? [];
        const pcls = paramClass.get(info.scope) ?? [];
        const pcon = paramContainer.get(info.scope) ?? [];
        e.args.forEach((arg, i) => {
          const pname = names[i];
          if (!pname) return;
          if (
            arg.expr.kind === "ident" &&
            (pcls[i] || pcon[i] || isTracked(arg.expr.name))
          ) {
            unite(localKey(currentScope, arg.expr.name), localKey(info.scope, pname));
          }
        });
      }
    }
    for (const child of subExprs(e)) noteExpr(child);
  };

  const walk = (s: HirStmt): void => {
    if (s.kind === "let" && !s.names) {
      const cls = constructedClass(s.init, classes);
      if (cls) {
        currentBindingClass.set(s.name, cls);
        ensure(localKey(currentScope, s.name));
      } else if (s.init.kind === "ident" && isTracked(s.init.name)) {
        // A bare-ident alias `const b = a` — a class alias (069) or a **container**
        // alias `const t = s` (086). The alias edge unions the two into one component;
        // if either is mutated the whole component promotes to `Rc<RefCell<T>>`.
        if (currentBindingClass.has(s.init.name)) {
          currentBindingClass.set(s.name, currentBindingClass.get(s.init.name) as string);
        }
        if (currentContainerBinding.has(s.init.name)) {
          // A **container** alias `const t = s` — this is the genuine sharing that turns
          // the captured container into an `Rc<RefCell<T>>` (086). Mark both handles
          // shared (the arg→param thread alone never sets this).
          currentContainerBinding.add(s.name);
          containerKey.add(localKey(currentScope, s.name));
          containerShared.add(localKey(currentScope, s.name));
          containerShared.add(localKey(currentScope, s.init.name));
        }
        unite(localKey(currentScope, s.name), localKey(currentScope, s.init.name));
      } else if (containerTypeOf(s.ty) !== null || isContainerInit(s.init)) {
        // A container binding `const s: Set<number> = new Set()` (or an array/String/Map
        // literal init) — tracked so its aliases + arg-threads feed the union-find (086).
        currentContainerBinding.add(s.name);
        containerKey.add(localKey(currentScope, s.name));
        ensure(localKey(currentScope, s.name));
      } else {
        // A binding whose class we can still learn from its declared type (e.g. the
        // result of a retaining call, `const h: Box = store(b)`).
        const cls2 = classOfType(s.ty, classes);
        if (cls2) currentBindingClass.set(s.name, cls2);
      }
      noteExpr(s.init);
    } else {
      for (const e of stmtExprs(s)) noteExpr(e);
    }
    for (const b of childBodies(s)) for (const c of b) walk(c);
  };

  /** Analyze one scope body under a fresh binding→class env seeded with params. */
  const analyzeBody = (scope: string, params: HirFn["params"], body: HirStmt[]): void => {
    currentScope = scope;
    currentBindingClass = new Map<string, string>();
    currentContainerBinding = new Set<string>();
    for (const p of params) {
      const cls = classOfType(p.ty, classes);
      if (cls) {
        currentBindingClass.set(p.name, cls);
        ensure(localKey(scope, p.name));
      } else if (containerTypeOf(p.ty) !== null) {
        // A threaded `__arrow_n` container param (series 086) — tracked so the bare-ident
        // collection mutator in its body seeds the union-find and the arg→param edge
        // reaches it. It is a container key but **not** `containerShared` — being a lifted
        // param is not outer-scope sharing (only a `const t = s` alias is).
        currentContainerBinding.add(p.name);
        containerKey.add(localKey(scope, p.name));
        ensure(localKey(scope, p.name));
      }
    }
    for (const s of body) walk(s);
    noteConsumingCalls(scope, body);
  };

  /**
   * The series-068 consuming edge. For every `obj.m()` in this scope calling a
   * consuming-candidate method, consult CFG liveness on `obj`'s root binding: if it
   * is **live after** the call's statement, the receiver is reused — force-promote
   * it to `Rc<RefCell<T>>` and demote the method (it falls back to `&self` + clone;
   * a non-`Clone` moved-out field under reuse is the documented `DialectError`
   * boundary). A dead-after receiver is a clean move (the fast path, no promotion).
   * Liveness reuses `ownership.ts`'s engine over the class bindings we track.
   */
  const noteConsumingCalls = (scope: string, body: HirStmt[]): void => {
    if (candidateField.size === 0) return;
    // Track the scope's class bindings for the reuse (live-after) test; a scope with
    // none still runs, to demote `this.m()` / `self.base.m()` receiver shapes.
    const tracked = new Set<string>();
    for (const k of parent.keys()) {
      if (k.startsWith(`${scope}::`)) tracked.add(k.slice(scope.length + 2));
    }
    const liveOut = computeLiveOut(body, tracked);
    const visitStmt = (s: HirStmt): void => {
      for (const e of stmtExprs(s)) findConsuming(e, s, liveOut, scope);
      for (const b of childBodies(s)) for (const c of b) visitStmt(c);
    };
    for (const s of body) visitStmt(s);
  };

  /**
   * Recurse an expression for consuming-candidate calls, classifying each call site.
   * A consuming (`fn m(self)`) call is only a **clean move** when its receiver is a
   * plain, movable **local binding** that is dead after the call. Any other shape
   * demotes the method to `&self` + clone:
   *   - a `this`/`self` receiver (`this.m()` inside another method — can't move out
   *     of the borrowed `self`), or a **field/index** receiver (`self.base.m()`, the
   *     inheritance-composition path — can't move out of a place);
   *   - a **live-after** local binding (the receiver is reused), which additionally
   *     force-promotes that binding to `Rc<RefCell<T>>`.
   * A non-`Clone` moved-out field under either demotion is the documented
   * `DialectError` (a shared/borrowed receiver can't clone the field out).
   */
  const findConsuming = (
    e: HirExpr,
    stmt: HirStmt,
    liveOut: Map<HirStmt, Set<string>>,
    scope: string,
  ): void => {
    if (
      e.kind === "method" &&
      candidateField.has(e.name) &&
      nonCopyCandidates.has(e.name)
    ) {
      const recv = e.receiver;
      const isBareLocal = recv.kind === "ident" && recv.name !== "self";
      const liveAfter = isBareLocal && (liveOut.get(stmt)?.has(recv.name) ?? false);
      if (!isBareLocal || liveAfter) {
        // Not a clean owned-local move → the method must stay `&self` + clone.
        demoted.add(e.name);
        if (liveAfter) forcePromote.add(localKey(scope, recv.name));
        const info = candidateField.get(e.name);
        if (info && !isTypeCloneable(info.field, structs)) {
          throw new DialectError(
            `consuming method '${e.name}' on a ${liveAfter ? "reused" : "borrowed/field"} ` +
              `receiver whose moved-out field is not \`Clone\` (cannot move out of a ` +
              `shared/borrowed receiver)`,
          );
        }
      }
    }
    for (const child of subExprs(e)) findConsuming(child, stmt, liveOut, scope);
  };

  analyzeBody(SCRIPT_SCOPE, [], module.main);
  for (const item of module.items) {
    if (item.kind === "fn") analyzeBody(item.name, item.params, item.body);
    if (item.kind === "class") analyzeClass(item, analyzeBody);
  }

  // Promote every alias closure (≥2 members — actually *shared*) that contains a
  // mutated member. The size gate preserves the 062 calculus: a lone binding that
  // is mutated but never aliased (a plain owned value with a `&mut self` call) stays
  // unwrapped. An interprocedural component is already ≥2 (arg + param, or
  // binding + field), so the gate does not block cross-boundary promotion.
  const componentSize = new Map<string, number>();
  // Per component root: does it contain a **container** key, and a **shared** container
  // (a `const t = s` alias)? A container component promotes only when it is *shared*
  // (086) — the ≥2-member gate can't distinguish it from the always-present arg→param
  // thread to a lifted `__arrow_n`. A class component keeps the 062/069 ≥2-member gate.
  const componentHasContainer = new Set<string>();
  const componentHasShared = new Set<string>();
  for (const key of parent.keys()) {
    const root = find(key);
    componentSize.set(root, (componentSize.get(root) ?? 0) + 1);
    if (containerKey.has(key)) componentHasContainer.add(root);
    if (containerShared.has(key)) componentHasShared.add(root);
  }
  const promotedRoot = new Set<string>();
  for (const key of mutated) {
    const root = find(key);
    if (componentHasContainer.has(root)) {
      // A captured **container** component (086) — promote iff it is genuinely shared
      // in an outer scope (`const t = s`). A lone owned container stays 079's `&mut`.
      if (componentHasShared.has(root)) promotedRoot.add(root);
    } else if ((componentSize.get(root) ?? 0) >= 2) {
      // A class component (062/069) — the shared ≥2-member gate is unchanged.
      promotedRoot.add(root);
    }
  }
  // A series-068 consuming reuse force-promotes its receiver's whole component,
  // bypassing the ≥2-member gate (the sharing is with the consumed handle, not a
  // sibling alias, so the component can be a lone binding).
  for (const key of forcePromote) promotedRoot.add(find(key));
  const isPromoted = (key: string): boolean =>
    parent.get(key) !== undefined && promotedRoot.has(find(key));

  // Project back into the three-part representation.
  const promoted = new Map<string, Set<string>>();
  const promotedParams = new Map<string, Set<string>>();
  const promotedFields = new Map<string, Set<string>>();
  // Alias-closure membership over the promoted keys (series 077): each promoted
  // union-find key → its component root, so the mutate-during-iteration lowering can
  // ask "does this loop body mutate the same cell it iterates?".
  const aliasRootOf = new Map<string, string>();
  const add = (m: Map<string, Set<string>>, k: string, v: string): void => {
    const set = m.get(k) ?? new Set<string>();
    set.add(v);
    m.set(k, set);
  };

  for (const key of parent.keys()) {
    if (!isPromoted(key)) continue;
    aliasRootOf.set(key, find(key));
    const hashIdx = key.indexOf("#");
    if (hashIdx >= 0) {
      add(promotedFields, key.slice(0, hashIdx), key.slice(hashIdx + 1));
      continue;
    }
    const sep = key.lastIndexOf("::");
    if (sep >= 0) {
      const scope = key.slice(0, sep);
      const name = key.slice(sep + 2);
      add(promoted, scope, name);
      // A param of a promotable callee also drives the call-site clone + param type.
      const names = paramNames.get(scope);
      if (names?.includes(name)) add(promotedParams, scope, name);
    }
  }

  // A candidate emits consuming (`fn m(self)`) iff its moved-out field is non-`Copy`
  // and no call site reused the receiver (which would have demoted it here).
  const consumingMethods = new Set<string>();
  for (const name of nonCopyCandidates) {
    if (!demoted.has(name)) consumingMethods.add(name);
  }

  return {
    promoted,
    promotedParams,
    promotedFields,
    paramOrder: paramNames,
    consumingMethods,
    aliasRootOf,
  };
}

/** Analyze a class's ctor + methods as their own scopes. */
function analyzeClass(
  cls: HirClass,
  analyzeBody: (scope: string, params: HirFn["params"], body: HirStmt[]) => void,
): void {
  if (cls.ctor) analyzeBody(ctorScope(cls.name), cls.ctor.params, cls.ctor.body);
  for (const m of cls.methods) {
    analyzeBody(methodScope(cls.name, m.name), m.params, m.body);
  }
}

/** Direct sub-expressions of an expression (shallow, for the recursive walk). */
function subExprs(e: HirExpr): HirExpr[] {
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
    case "collectVec":
      return [e.iter];
    default:
      return [];
  }
}

/** The expressions directly held by a statement (not its nested bodies). */
function stmtExprs(s: HirStmt): HirExpr[] {
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

/** The nested statement bodies of a statement (for the recursive walk). */
function childBodies(s: HirStmt): HirStmt[][] {
  switch (s.kind) {
    case "if":
      return s.alt ? [s.conseq, s.alt] : [s.conseq];
    case "while":
    case "block":
    case "forIn":
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
