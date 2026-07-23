/**
 * Arrow normalization (series 028/079) — a pre-lowering AST→AST pass. A `const f
 * = (…) => …` bound to a name is rewritten to a `function` declaration
 * (`arrowToFunctionDecl`), nested arrows are lifted to top level, and a captured
 * container is threaded through as a leading parameter (`threadStoredCapture` /
 * `classifyStoredCapture`) so the later lowering never sees a closure that
 * captures mutable state. Pure over the AST — no `ModuleAnalysis`, no HIR; its
 * only cross-module dependency is the shared `CB_GLOBALS` name-set. Extracted
 * from the lowering monolith (series 109); `astWalk`/`collectBoundNames` are
 * generic AST walkers exported for reuse.
 */

import type {
  ArrowFunctionExpression,
  BlockStatement,
  Expression,
  ForOfStatement,
  ForStatement,
  FunctionDeclaration,
  Identifier,
  IfStatement,
  Program,
  ReturnStatement,
  Statement,
  TryStatement,
  TSType,
  TSTypeAnnotation,
  VariableDeclaration,
  VariableDeclarator,
  WhileStatement,
} from "../ast";
import { UnsupportedError } from "../errors";
import { CB_GLOBALS } from "./constants";

// ── Arrow normalization ──────────────────────────────────────────────────────

/**
 * A captured container's owned TS type annotation, synthesized (series 079) from a
 * declarator so a lifted `__arrow_*` fn can take it as a leading param. Reuses the
 * declaration's own `Array<T>` / `Set<T>` / `Map<K,V>` annotation when present, else
 * synthesizes one from the initializer (`new Set<T>()` / `new Map<K,V>()` / an array
 * literal / a string literal). Returns null when it can't be resolved to a container
 * — the capture then is not a threadable container (→ scalar fail-loud).
 */
function containerAnnotationOf(decl: {
  annotation?: unknown;
  init?: unknown;
}): TSTypeAnnotation | null {
  // A declared annotation for a container type carries straight through as the
  // param annotation (the borrow is inferred from body use, like any param).
  const ann = decl.annotation as { typeAnnotation?: unknown } | undefined;
  const inner = ann?.typeAnnotation as { type?: string; typeName?: { name?: string } } | undefined;
  if (inner?.type === "TSTypeReference") {
    const n = inner.typeName?.name;
    if (n === "Array" || n === "Set" || n === "Map" || n === "ReadonlyArray") {
      return ann as TSTypeAnnotation;
    }
  }
  if (inner?.type === "TSStringKeyword") return ann as TSTypeAnnotation;
  // No usable annotation → synthesize a `TSTypeReference` from the initializer.
  const init = decl.init as
    | { type?: string; callee?: { name?: string }; typeArguments?: unknown; elements?: unknown[]; value?: unknown }
    | undefined;
  if (!init) return null;
  const mkRef = (name: string, typeArguments: unknown): TSTypeAnnotation =>
    ({
      type: "TSTypeAnnotation",
      typeAnnotation: {
        type: "TSTypeReference",
        typeName: { type: "Identifier", name },
        typeArguments,
      },
    }) as unknown as TSTypeAnnotation;
  if (init.type === "NewExpression" && init.callee?.name) {
    const name = init.callee.name;
    if ((name === "Set" || name === "Map") && init.typeArguments) {
      return mkRef(name, init.typeArguments);
    }
    return null; // an un-parameterized `new Set()` can't be typed → fail-loud
  }
  if (init.type === "ArrayExpression") {
    const first = (init.elements ?? [])[0] as { type?: string; value?: unknown } | undefined;
    // Only a numeric array literal can be typed at this pre-analysis stage; a
    // heterogeneous / empty un-annotated array stays fail-loud (no element type).
    if (first?.type === "Literal" && typeof first.value === "number") {
      return mkRef("Array", {
        type: "TSTypeParameterInstantiation",
        params: [{ type: "TSNumberKeyword" }],
      });
    }
    return null;
  }
  if (init.type === "Literal" && typeof init.value === "string") {
    return { type: "TSTypeAnnotation", typeAnnotation: { type: "TSStringKeyword" } } as unknown as TSTypeAnnotation;
  }
  return null;
}

/** Plain-object AST walk (no `isAstNode`, which is defined later) — series 079. */
export function astWalk(node: unknown, visit: (n: { type: string; [k: string]: unknown }) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const c of node) astWalk(c, visit);
    return;
  }
  const n = node as { type?: string; [k: string]: unknown };
  if (typeof n.type === "string") visit(n as { type: string; [k: string]: unknown });
  for (const k in n) {
    if (k === "type") continue;
    astWalk(n[k], visit);
  }
}

/**
 * Collect every identifier name bound by a binding pattern (series 079): a plain
 * `Identifier`, an object pattern `{ x, y }` (incl. renames / defaults / rest), an
 * array pattern `[a, b]`, a default `x = …`, or a rest `...xs`. Used to exclude a
 * closure's own params (destructured or not) and its body locals from the free set.
 */
export function collectBoundNames(pat: unknown, out: Set<string>): void {
  if (!pat || typeof pat !== "object") return;
  const n = pat as { type?: string; [k: string]: unknown };
  switch (n.type) {
    case "Identifier":
      out.add(n.name as string);
      return;
    case "ObjectPattern":
      for (const prop of (n.properties as unknown[]) ?? []) {
        const p = prop as { type?: string; value?: unknown; argument?: unknown };
        if (p.type === "RestElement") collectBoundNames(p.argument, out);
        else collectBoundNames(p.value, out);
      }
      return;
    case "ArrayPattern":
      for (const el of (n.elements as unknown[]) ?? []) collectBoundNames(el, out);
      return;
    case "AssignmentPattern":
      collectBoundNames(n.left, out);
      return;
    case "RestElement":
      collectBoundNames(n.argument, out);
      return;
    default:
      return;
  }
}

/**
 * Classify a stored arrow's captures (series 079, issue #46). Walks the arrow body
 * for free identifiers not bound by its own params; each free var that a
 * `containerAnnotationOf` resolves to a container is a **threadable capture**; a
 * scalar capture (an `=`/`++`/`--` on a free var, a wholesale rebind of a captured
 * container `s = …`, or a free var that is not a resolvable container) is fail-loud.
 * Returns the captured container names in first-occurrence order (a stable param
 * order for the sig and every rewritten call site), or `null` for a non-capturing
 * arrow (the existing lift is unchanged).
 *
 * @throws {UnsupportedError} on a scalar mutable capture, a wholesale-reassigned
 *   captured container, or a captured free var that is not a threadable container.
 */
function classifyStoredCapture(
  arrow: ArrowFunctionExpression,
  declInfoOf: (name: string) => { annotation?: unknown; init?: unknown } | undefined,
  topLevelFns: ReadonlySet<string>,
): string[] | null {
  // Names bound by the arrow itself (its params, incl. destructured `{x, y}` /
  // `[a, b]` patterns) plus any binding declared *inside* the body (`const h = …`,
  // `let n = …`, a for-of/catch binding) — none of these is a free capture.
  const bound = new Set<string>();
  for (const p of arrow.params) collectBoundNames(p, bound);
  astWalk(arrow.body, (n) => {
    if (n.type === "VariableDeclarator") collectBoundNames(n.id, bound);
    if (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression") {
      // A nested closure's own params are bound in its scope, not the outer one —
      // but the outer walk still visits them; a two-level capture is a residual, so
      // treating a nested param as bound here is safe (it can't be an outer capture).
      for (const p of ((n as { params?: unknown[] }).params ?? [])) collectBoundNames(p, bound);
    }
  });
  const captured: string[] = [];
  const seen = new Set<string>();
  // A free identifier is a candidate capture unless it is bound (param / local), a
  // top-level fn, or a known callback global (`console`, `Math`, …).
  const isFree = (name: string): boolean =>
    !bound.has(name) && !topLevelFns.has(name) && !CB_GLOBALS.has(name);

  let scalarCapture = false;
  astWalk(arrow.body, (n) => {
    // A wholesale rebind of a free var (`s = …`, `n++`) is a scalar-style capture —
    // fail-loud (unchanged 048 for a scalar; a captured container reassigned
    // wholesale is out of scope, per the 079 residuals).
    if (n.type === "AssignmentExpression") {
      const left = n.left as { type?: string; name?: string };
      if (left?.type === "Identifier" && left.name && isFree(left.name)) scalarCapture = true;
    }
    if (n.type === "UpdateExpression") {
      const arg = n.argument as { type?: string; name?: string };
      if (arg?.type === "Identifier" && arg.name && isFree(arg.name)) scalarCapture = true;
    }
  });
  if (scalarCapture) {
    throw new UnsupportedError({
      type: "mutable capture in a closure (a captured scalar reassignment / a container rebound wholesale — lift to a named fn taking the state as an explicit param)",
    });
  }

  // A free identifier read (`arr[0]`, `s.add(...)`, a bare `x`) contributes a capture.
  // A resolvable container captures cleanly; any other free read (a scalar, an
  // un-typeable binding) is the 048 scalar-capture residual → fail-loud.
  const collect = (name: string): void => {
    if (!isFree(name) || seen.has(name)) return;
    seen.add(name);
    const info = declInfoOf(name);
    if (info && containerAnnotationOf(info)) {
      captured.push(name);
    } else {
      throw new UnsupportedError({
        type: `capture of '${name}' in a closure is not a threadable container (only Set/Map/Array/String captures thread; a captured scalar stays fail-loud)`,
      });
    }
  };
  // A context-aware walk: a non-computed member **property** name (`s.add` → `add`) is
  // a field, not a free var, so it is not descended into as an identifier read. A
  // nested arrow is not descended into (capture-through-two-levels is a fail-loud
  // residual — a nested capturing arrow is rejected on its own turn).
  const walkExpr = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) walkExpr(c);
      return;
    }
    const n = node as { type?: string; [k: string]: unknown };
    if (n.type === "Identifier") {
      collect(n.name as string);
      return;
    }
    if (n.type === "MemberExpression") {
      walkExpr(n.object);
      if (n.computed) walkExpr(n.property); // `arr[i]` — `i` is a read
      return; // a static `.prop` is a field name, not a free var
    }
    if (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression") {
      return; // don't descend into a nested closure (two-level capture → fail-loud)
    }
    for (const k in n) {
      if (k === "type") continue;
      walkExpr(n[k]);
    }
  };
  walkExpr(arrow.body);
  return captured.length > 0 ? captured : null;
}

/**
 * Escape check (series 079): a captured-container stored closure `add` is
 * non-escaping iff **every** use of `add` in the program is a direct call
 * (`add(...)`). A use as an argument, a return value, a field/array store, or a
 * reassignment means the bound environment would outlive the call — env-threading
 * can't represent it, so fail-loud.
 *
 * @throws {UnsupportedError} when `add` escapes.
 */
function assertNonEscaping(name: string, body: Statement[]): void {
  // Every free read of `name` must be the callee of a direct call. A context-aware
  // walk (like the capture walk): a non-computed member **property** named `add`
  // (`s.add`) is a field, not a use of the binding; a `VariableDeclarator` id
  // (`const add = …`) is the declaration, not a use. Any other read of `name` — an
  // argument, a return value, a store, a rebind — is an escape.
  let escaped = false;
  const walk = (node: unknown, asDeclId: boolean): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) walk(c, false);
      return;
    }
    const n = node as { type?: string; [k: string]: unknown };
    if (n.type === "Identifier") {
      if (n.name === name && !asDeclId) escaped = true; // a bare read that isn't a callee
      return;
    }
    if (n.type === "CallExpression") {
      const callee = n.callee as { type?: string; name?: string } | undefined;
      // A direct call `add(...)` is the allowed use — don't flag its callee.
      if (!(callee?.type === "Identifier" && callee.name === name)) walk(n.callee, false);
      walk(n.arguments, false);
      return;
    }
    if (n.type === "MemberExpression") {
      walk(n.object, false);
      if (n.computed) walk(n.property, false); // a static `.prop` is a field name
      return;
    }
    if (n.type === "VariableDeclarator") {
      walk(n.id, true); // the binding id is the declaration, not a use
      walk(n.init, false);
      return;
    }
    for (const k in n) {
      if (k === "type") continue;
      walk(n[k], false);
    }
  };
  walk(body, false);
  if (escaped) {
    throw new UnsupportedError({
      type: `closure '${name}' captures a container and escapes (returned, stored, or passed as a value) — env-threading requires it be invoked directly only (fail-loud residual, series 079)`,
    });
  }
}

/**
 * Rewrite each `add(args)` call site of a threaded stored closure to
 * `__arrow_n(cap1, …, args)` (series 079): the captured containers become leading
 * args (bare identifiers; the call-site borrow `&`/`&mut` is folded in later by
 * `lowerCall` from the lifted fn's inferred param ownership). Mutates the AST in
 * place over the whole program body.
 */
function rewriteThreadedCalls(
  body: unknown,
  binding: string,
  fnName: string,
  captures: readonly string[],
): void {
  astWalk(body, (n) => {
    if (n.type !== "CallExpression") return;
    const callee = (n as { callee?: { type?: string; name?: string } }).callee;
    if (callee?.type === "Identifier" && callee.name === binding) {
      callee.name = fnName;
      const capArgs = captures.map((c) => ({ type: "Identifier", name: c }));
      const node = n as unknown as { arguments: unknown[] };
      node.arguments = [...capArgs, ...(node.arguments ?? [])];
    }
  });
}

/**
 * Rewrite each top-level `const f = (…) => …` (a single-declarator `const` bound
 * to an arrow, `async` or not) into a synthetic `FunctionDeclaration`, leaving
 * every other statement untouched. Run before analysis so a normalized arrow's
 * parameter ownership and call-site borrows are inferred, and calls to it adapt
 * their arguments, exactly as for a `function`. An `async` arrow normalizes to an
 * `async` fn (series 054b). A non-normalized arrow (`let`/`var`-bound,
 * value-position, nested) stays an expression and is rejected downstream in
 * `lowerExpr` — the documented deferral boundary.
 */
export function normalizeArrows(program: Program): Program {
  // Top-level fn signatures — used to synthesize the `fn`-pointer annotation of a
  // fn-*value* binding (`const op = add`, series 058 Fork 1 case B).
  const fnSigs = new Map<string, FunctionDeclaration>();
  for (const stmt of program.body) {
    if (stmt.type === "FunctionDeclaration" && (stmt as FunctionDeclaration).id) {
      const f = stmt as FunctionDeclaration;
      if (f.id) fnSigs.set(f.id.name, f);
    }
  }
  // Container-capture threading (series 079/086, issue #46): a stored arrow that
  // captures a container needs, per captured var, its declaration (for the threaded
  // param's owned type annotation). Aliasing is **not** decided here — the shared/aliased
  // `Rc<RefCell>` promotion (series 086) is made by the post-lowering `computeAutoRc`
  // union-find, so the lift just threads the container either way. Program-wide, collected
  // once here.
  const declInfo = collectDeclInfo(program.body);
  const topLevelFns = new Set<string>(fnSigs.keys());
  const ctx: LiftCtx = {
    hoisted: [],
    counter: { n: 0 },
    fnSigs,
    reassigned: collectReassignedNames(program.body),
    declInfo,
    topLevelFns,
    threadedRewrites: [],
    programBody: program.body,
    scopeVars: declaredNamesOf(program.body),
  };
  const body = liftStmts(program.body, ctx, true);
  // Apply the call-site rewrites (`add(a)` → `__arrow_n(env, a)`) across the whole
  // resulting body, including the hoisted `__arrow_*` fns (a call site can sit inside
  // another lifted arrow).
  const full = [...body, ...ctx.hoisted];
  for (const rw of ctx.threadedRewrites) {
    rewriteThreadedCalls(full, rw.binding, rw.fnName, rw.captures);
  }
  return { ...program, body: full };
}

/** A declarator's annotation + init, keyed by binding name (series 079). */
function collectDeclInfo(
  stmts: Statement[],
): Map<string, { annotation?: unknown; init?: unknown }> {
  const out = new Map<string, { annotation?: unknown; init?: unknown }>();
  astWalk(stmts, (n) => {
    if (n.type !== "VariableDeclarator") return;
    const id = n.id as { type?: string; name?: string; typeAnnotation?: unknown };
    if (id?.type === "Identifier" && id.name) {
      out.set(id.name, { annotation: id.typeAnnotation, init: n.init });
    }
  });
  return out;
}

/** State threaded through the arrow-lift transform (series 058). */
interface LiftCtx {
  /** `__arrow_n` fns extracted from inline arrows, appended at module scope. */
  hoisted: FunctionDeclaration[];
  counter: { n: number };
  /** Top-level fn declarations, for typing a fn-value binding as a `fn`-pointer. */
  fnSigs: Map<string, FunctionDeclaration>;
  /** Every identifier reassigned somewhere (`x = …`) — a reassigned arrow binding
   * can't be a direct `fn`, so it takes the `fn`-pointer path. */
  reassigned: Set<string>;
  /** Binding name → its declaration (annotation + init), for a captured container's
   * threaded param type (series 079). */
  declInfo: Map<string, { annotation?: unknown; init?: unknown }>;
  /** Top-level fn names (excluded from a closure's free-var set). */
  topLevelFns: Set<string>;
  /** Deferred call-site rewrites for threaded stored closures (series 079), applied
   * once over the whole body after lifting. */
  threadedRewrites: { binding: string; fnName: string; captures: string[] }[];
  /** The original (pre-lift) program body — for the whole-program escape check. */
  programBody: Statement[];
  /**
   * Names in scope at the current lift point (series 086): the top-level declarations
   * plus, when lifting inside a `function`/arrow body, that scope's params + local
   * declarations. A container-capturing stored closure whose captured container is
   * **not** in this set is a **two-level** (or otherwise out-of-scope) capture — the
   * env-threaded call site can't reach the container → fail-loud. Reset per scope in
   * `liftStmts` (see `withScope`).
   */
  scopeVars: Set<string>;
}

/**
 * Arrow-binding lift (series 058). Rewrite each `const`/`let`/`var` declarator
 * whose init is a non-capturing arrow, at any scope:
 *   - A **top-level, non-reassigned** arrow binding promotes to a direct free `fn`
 *     (the shipped 015 behavior, now also for `let`/`var` and `async`).
 *   - Any **other** arrow binding (nested scope, or reassigned) hoists the arrow to
 *     a top-level `fn __arrow_n` and keeps a `fn`-pointer binding (`let f:
 *     fn(..)->.. = __arrow_n`), synthesizing the pointer annotation from the arrow.
 *   - A **fn-value** binding (`const op = add`) gets the same synthesized pointer
 *     annotation so it needs no user annotation.
 * Multiple declarators split into per-binding statements. `async` in the
 * `fn`-pointer path fails loud (no `fn`-pointer form for a future-returning fn).
 */
function liftStmts(
  stmts: Statement[],
  ctx: LiftCtx,
  topLevel: boolean,
): Statement[] {
  const out: Statement[] = [];
  for (const stmt of stmts) {
    const recursed = liftNested(stmt, ctx);
    if (recursed.type === "VariableDeclaration") {
      out.push(...liftVarDecl(recursed as VariableDeclaration, ctx, topLevel));
    } else {
      out.push(recursed);
    }
  }
  return out;
}

/**
 * The names declared directly in a statement list (series 086): each `const`/`let`/`var`
 * binding id (a plain `Identifier`) and each nested `function`/`class` name. Used to seed
 * the `scopeVars` in-scope set so a container-capturing closure can verify its captured
 * container is reachable at the lift point (else it is a two-level capture → fail-loud).
 * Shallow (does not descend nested bodies — those are separate scopes).
 */
function declaredNamesOf(stmts: Statement[]): Set<string> {
  const names = new Set<string>();
  for (const s of stmts) {
    if (s.type === "VariableDeclaration") {
      for (const d of (s as VariableDeclaration).declarations) {
        const id = d.id as { type?: string; name?: string };
        if (id?.type === "Identifier" && id.name) names.add(id.name);
      }
    }
    const named = s as { type?: string; id?: { name?: string } };
    if (
      (named.type === "FunctionDeclaration" || named.type === "ClassDeclaration") &&
      named.id?.name
    ) {
      names.add(named.id.name);
    }
  }
  return names;
}

/**
 * Run `fn` with `scopeVars` **replaced** by an inner function scope's own params + local
 * declarations (series 086). `scopeVars` tracks only the **immediately-enclosing function
 * scope**, not the transitive outer chain: a container-capturing closure can thread its
 * captured container only when the container is a param/local of the same function scope
 * the closure sits in — a container from a further-out scope (`inner` inside `outer`
 * capturing a top-level `s`) is a two-level capture env-threading can't reach → fail-loud.
 */
function withScope(
  ctx: LiftCtx,
  params: readonly unknown[],
  body: Statement[],
  fn: () => void,
): void {
  const prev = ctx.scopeVars;
  const inner = new Set<string>();
  for (const p of params) collectBoundNames(p, inner);
  for (const n of declaredNamesOf(body)) inner.add(n);
  ctx.scopeVars = inner;
  try {
    fn();
  } finally {
    ctx.scopeVars = prev;
  }
}

/** Recurse the transform into a statement's nested scopes (fn bodies, blocks, …). */
function liftNested(stmt: Statement, ctx: LiftCtx): Statement {
  switch (stmt.type) {
    case "FunctionDeclaration": {
      const f = stmt as FunctionDeclaration;
      if (f.body) {
        withScope(ctx, f.params ?? [], f.body.body, () => {
          f.body = { ...(f.body as BlockStatement), body: liftStmts((f.body as BlockStatement).body, ctx, false) };
        });
      }
      return f;
    }
    case "BlockStatement": {
      const b = stmt as BlockStatement;
      return { ...b, body: liftStmts(b.body, ctx, false) };
    }
    case "IfStatement": {
      const s = stmt as IfStatement;
      return {
        ...s,
        consequent: liftNested(s.consequent, ctx),
        alternate: s.alternate ? liftNested(s.alternate, ctx) : null,
      };
    }
    case "WhileStatement":
    case "ForStatement":
    case "ForOfStatement": {
      const s = stmt as WhileStatement | ForStatement | ForOfStatement;
      return { ...s, body: liftNested(s.body, ctx) };
    }
    case "TryStatement": {
      const s = stmt as TryStatement;
      return {
        ...s,
        block: liftNested(s.block, ctx) as BlockStatement,
        handler: s.handler
          ? { ...s.handler, body: liftNested(s.handler.body, ctx) as BlockStatement }
          : s.handler,
        finalizer: s.finalizer
          ? (liftNested(s.finalizer, ctx) as BlockStatement)
          : null,
      };
    }
    default:
      return stmt;
  }
}

/** Transform one `const`/`let`/`var` declaration into per-declarator statements. */
function liftVarDecl(
  decl: VariableDeclaration,
  ctx: LiftCtx,
  topLevel: boolean,
): Statement[] {
  const out: Statement[] = [];
  for (const d of decl.declarations) {
    const init = d.init;
    if (init?.type === "ArrowFunctionExpression") {
      const arrow = init as ArrowFunctionExpression;
      const name = (d.id as Identifier).name;
      // Container-capture threading (series 079, issue #46). A stored arrow that
      // captures a container (read or method-mutated) can't be a plain free `fn` (it
      // would reference an out-of-scope binding). Thread the captured containers as
      // leading params of a hoisted `__arrow_n` and rewrite every call site to pass
      // them; `analyzeFunction` infers each param's `&`/`&mut` from body use and
      // `lowerCall` folds the borrow in at the (rewritten) call sites. A scalar
      // capture, a wholesale rebind, an aliased owner (→ Rc row), or an escaping
      // binding all fail loud inside `classifyStoredCapture` / the checks below.
      const captures = classifyStoredCapture(
        arrow,
        (n) => ctx.declInfo.get(n),
        ctx.topLevelFns,
      );
      if (captures) {
        threadStoredCapture(d, arrow, decl, captures, ctx, out);
        continue;
      }
      if (topLevel && !ctx.reassigned.has(name)) {
        // Direct promotion → a free `fn` (async carries over); recurse to lift any
        // arrows nested in its body.
        out.push(liftNested(arrowToFunctionDecl(d.id as Identifier, arrow), ctx));
      } else {
        // `fn`-pointer path: hoist the arrow, keep a typed pointer binding.
        if (arrow.async) {
          throw new UnsupportedError({
            type: "a nested or reassigned `async` arrow binding (no fn-pointer form)",
          });
        }
        const fnName = `__arrow_${ctx.counter.n++}`;
        const id: Identifier = { ...(d.id as Identifier), name: fnName };
        ctx.hoisted.push(
          liftNested(arrowToFunctionDecl(id, arrow), ctx) as FunctionDeclaration,
        );
        out.push(
          singleDecl(decl.kind, {
            ...d,
            id: annotateAsFn(d.id as Identifier, arrow.params, arrow.returnType),
            init: { type: "Identifier", name: fnName, start: init.start, end: init.end },
          }),
        );
      }
    } else if (
      init?.type === "Identifier" &&
      !(d.id as Identifier).typeAnnotation &&
      ctx.fnSigs.has((init as Identifier).name)
    ) {
      // Fn-value binding (`const op = add`) → synthesize the fn-pointer annotation.
      const sig = ctx.fnSigs.get((init as Identifier).name) as FunctionDeclaration;
      out.push(
        singleDecl(decl.kind, {
          ...d,
          id: annotateAsFn(d.id as Identifier, sig.params, sig.returnType ?? null),
        }),
      );
    } else {
      out.push(singleDecl(decl.kind, d));
    }
  }
  return out;
}

/**
 * Thread a stored closure's captured containers as leading params of a hoisted
 * `__arrow_n` fn and record the call-site rewrite (series 079). The binding itself is
 * dropped — a container-capturing closure carries a bound environment, so it is no
 * longer a plain fn-pointer value; every use must be a direct call (checked by
 * `assertNonEscaping`). Fails loud on an aliased owner (deferred `Rc` row), an
 * escaping use, or an `async` closure (no env-threaded async form).
 */
function threadStoredCapture(
  d: VariableDeclarator,
  arrow: ArrowFunctionExpression,
  _decl: VariableDeclaration,
  captures: string[],
  ctx: LiftCtx,
  _out: Statement[],
): void {
  const binding = (d.id as Identifier).name;
  if (arrow.async) {
    throw new UnsupportedError({
      type: "an `async` closure capturing a container (no env-threaded async form, series 079)",
    });
  }
  // Two-level (out-of-scope) capture guard (series 086): env-threading can only thread a
  // captured container that is a param/local of the **same** function scope the closure
  // sits in. A container declared further out (`inner` inside `outer` capturing a
  // top-level `s`) has no threadable path — the intermediate scope would have to
  // re-thread it. Fail-loud (the 079 two-level residual).
  for (const cap of captures) {
    if (!ctx.scopeVars.has(cap)) {
      throw new UnsupportedError({
        type: `closure captures container '${cap}' from an enclosing scope more than one level out (two-level capture) — env-threading can't reach it (fail-loud residual, series 086)`,
      });
    }
  }
  // A captured container is threaded as a leading param **regardless** of whether its
  // owner is aliased (series 086, issue #46). The owned-mutable case keeps 079's by-need
  // `&mut` borrow; the **shared/aliased** case (`const t = s`) instead promotes the
  // whole alias closure to `Rc<RefCell<T>>` — but that decision is made **later**, by the
  // post-lowering `computeAutoRc` union-find (it sees the alias edge, the bare-ident
  // collection mutator inside `__arrow_n`, and the arg→param thread), not here. So the
  // pre-analysis lift produces the ordinary `__arrow_n(s, a)` shape either way and lets
  // `refineRc` splice the `Rc::clone` / `.borrow_mut()` in for the promoted case. The
  // ≥2-member alias gate keeps a lone owned container on the `&mut` path (no regression).
  // Escape check: every use of the binding must be a direct call. Run over the whole
  // program (a call site can precede or follow the declaration in source order).
  assertNonEscaping(binding, ctx.programBody);

  // The threaded leading params: each captured container by its owned type annotation
  // (borrow inferred from body use), then the arrow's own params unchanged.
  const capParams: Identifier[] = captures.map((cap) => {
    const info = ctx.declInfo.get(cap);
    const ann = info ? containerAnnotationOf(info) : null;
    if (!ann) {
      // Unreachable: `classifyStoredCapture` only admitted captures `containerAnnotationOf`
      // resolves. Kept as a fail-loud guard rather than a silent untyped param.
      throw new UnsupportedError({
        type: `cannot synthesize a threaded param type for captured container '${cap}' (series 079)`,
      });
    }
    return {
      type: "Identifier",
      name: cap,
      typeAnnotation: ann,
    } as unknown as Identifier;
  });

  const fnName = `__arrow_${ctx.counter.n++}`;
  const id: Identifier = { ...(d.id as Identifier), name: fnName };
  const fn = arrowToFunctionDecl(id, arrow);
  fn.params = [...capParams, ...(arrow.params as Identifier[])];
  ctx.hoisted.push(liftNested(fn, ctx) as FunctionDeclaration);
  ctx.threadedRewrites.push({ binding, fnName, captures });
  // No binding statement is emitted — the closure is now a bound-env fn, not a value.
}

/** Wrap one declarator in its own single-declarator `VariableDeclaration`. */
function singleDecl(
  kind: VariableDeclaration["kind"],
  d: VariableDeclarator,
): VariableDeclaration {
  return {
    type: "VariableDeclaration",
    kind,
    declarations: [d],
    start: d.start,
    end: d.end,
  };
}

/** Attach a synthesized `(P…) => R` type annotation to a binding id (series 058). */
function annotateAsFn(
  id: Identifier,
  params: Identifier[],
  returnType: TSTypeAnnotation | null | undefined,
): Identifier {
  if (id.typeAnnotation) return id;
  const fnType = {
    type: "TSFunctionType",
    params,
    returnType: returnType ?? null,
    start: id.start,
    end: id.end,
  } as unknown as TSType;
  return {
    ...id,
    typeAnnotation: {
      type: "TSTypeAnnotation",
      typeAnnotation: fnType,
      start: id.start,
      end: id.end,
    },
  };
}

/** Collect every identifier name that is the target of an assignment (`x = …`). */
function collectReassignedNames(stmts: Statement[]): Set<string> {
  const names = new Set<string>();
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    const node = n as { type?: string; left?: { type?: string; name?: string } };
    if (node.type === "AssignmentExpression" && node.left?.type === "Identifier") {
      if (node.left.name) names.add(node.left.name);
    }
    for (const v of Object.values(n as Record<string, unknown>)) walk(v);
  };
  walk(stmts);
  return names;
}

/**
 * Build the synthetic `FunctionDeclaration` for a normalized arrow: the binding
 * name becomes the fn `id`; `params`/`returnType`/`async` carry over unchanged;
 * the body is the arrow's `BlockStatement` verbatim, or `{ return <expr>; }` for
 * an expression body (the `=> expr` desugar). Spans are inherited from the arrow
 * so any downstream diagnostic still points at the source.
 */
function arrowToFunctionDecl(
  name: Identifier,
  arrow: ArrowFunctionExpression,
): FunctionDeclaration {
  const body: BlockStatement =
    arrow.body.type === "BlockStatement"
      ? (arrow.body as BlockStatement)
      : {
          type: "BlockStatement",
          body: [
            {
              type: "ReturnStatement",
              argument: arrow.body as Expression,
              start: arrow.body.start,
              end: arrow.body.end,
            } satisfies ReturnStatement,
          ],
          start: arrow.body.start,
          end: arrow.body.end,
        };
  return {
    type: "FunctionDeclaration",
    id: name,
    async: arrow.async,
    params: arrow.params,
    returnType: arrow.returnType ?? null,
    body,
    start: arrow.start,
    end: arrow.end,
  };
}

