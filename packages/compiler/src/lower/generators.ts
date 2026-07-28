/**
 * Lowering: `function*` generators (series 025d/035/052/075/076). The
 * straight-line finite-yield fast path (`vec![…].into_iter()`) plus the full
 * resumable **state-machine** transform — an intra-fn CFG split at every `yield`,
 * backward live-variable analysis to promote across-yield locals to struct
 * fields, and the `impl Iterator`/`Steppable` synthesis. Extracted from the
 * lowering monolith (series 109); the core lowerers come from the sibling hubs
 * (`./expressions` / `./statements` / `./types`), `lowerParam` from `./index`, and
 * the shared structural AST/HIR walks (`collectRefs`/`rewriteFieldRefs`/
 * `collectDeclaredLocals`) from `./utils`.
 */

import type { ModuleAnalysis } from "../analysis";
import type {
  BlockStatement,
  BreakStatement,
  CallExpression,
  ContinueStatement,
  Expression,
  ExpressionStatement,
  ForStatement,
  FunctionDeclaration,
  Identifier,
  IfStatement,
  Statement,
  TSType,
  VariableDeclaration,
  WhileStatement,
} from "../ast";
import { UnsupportedError } from "../errors";
import type {
  HirExpr,
  HirFn,
  HirGenerator,
  HirParam,
  HirStmt,
  RustType,
} from "../hir";
import { typeCbBody } from "./closures";
import { UNIT } from "./constants";
import { isGeneratorCall, lowerExpr } from "./expressions";
import { lowerParam } from "./index";
import { lowerStatement } from "./statements";
import { lowerType } from "./types";
import {
  blockBody,
  capitalizeAscii,
  collectDeclaredLocals,
  collectDeclaredLocalsInto,
  collectRefs,
  exprStmt,
  rewriteFieldRefs,
  setEq,
} from "./utils";

/**
 * Lower a sync generator (`function* g(): Generator<T> { yield a; yield b; … }`,
 * series 025d) to a `fn g(…) -> impl Iterator<Item = T>` that returns a fixed
 * sequence: `vec![a, b, …].into_iter()`. This first slice handles the
 * **straight-line finite-yield** shape — a body that is exactly a sequence of
 * `yield <expr>;` statements. Anything else (a `yield` inside a loop / `if` /
 * `switch`, a `yield*` delegation, a non-`yield` statement, an `async` generator,
 * or a missing/again-`Generator` return annotation) is a real state-machine
 * transform and stays fail-loud (`UnsupportedError`) until a later increment.
 *
 * The item type comes from the `Generator<T>` / `IterableIterator<T>` return
 * annotation; `for (const x of g())` consumes the result directly (see
 * `lowerForOf`).
 */
export function lowerGenerator(
  func: FunctionDeclaration,
  analysis: ModuleAnalysis,
): HirFn | HirGenerator {
  if (!func.id) throw new UnsupportedError(func);
  const name = func.id.name;
  const info = analysis.fns.get(name);
  const params = func.params.map((p, i) =>
    lowerParam(p, info?.params[i], analysis.structs),
  );

  // The element type is the first type argument of the `Generator<T>` /
  // `IterableIterator<T>` return annotation. A bare/absent annotation is fail-loud
  // — an item type can't be inferred soundly for `impl Iterator`.
  const ann = func.returnType?.typeAnnotation;
  const ref =
    ann?.type === "TSTypeReference"
      ? (ann as Extract<TSType, { type: "TSTypeReference" }>)
      : null;
  const genNames = new Set(["Generator", "IterableIterator", "Iterable"]);
  if (!ref || !genNames.has(ref.typeName.name)) {
    throw new UnsupportedError({
      type: "generator without a `Generator<T>` / `IterableIterator<T>` return annotation",
    });
  }
  const itemAnn = ref.typeArguments?.params?.[0];
  if (!itemAnn)
    throw new UnsupportedError({ type: "generator without an item type" });
  const item = lowerType(itemAnn, analysis.structs);

  // The completion type `R` (series 075) — the 2nd `Generator<Y, R>` type arg. When
  // absent it is inferred at the state-machine build (from a `return <value>`);
  // bare `return` / fall-off is unit. An explicit `R` here overrides inference.
  const retAnn = ref.typeArguments?.params?.[1];
  const declaredRetTy = retAnn ? lowerType(retAnn, analysis.structs) : null;

  if (!func.body)
    throw new UnsupportedError({ type: "generator without a body" });

  // Shape dispatch (series 052). A **straight-line all-`yield`** body keeps the
  // 035 `vec![…].into_iter()` lowering (no state machine); anything with loops,
  // branches, or non-`yield` statements interleaved with yields becomes a
  // resumable state machine (`buildGeneratorStateMachine`). A `yield*` / bare
  // `yield` makes the body non-straight-line, so it falls to the state-machine
  // path, which keeps them fail-loud residuals.
  const straightLineBody = func.body.body.every((s) => {
    if (s.type !== "ExpressionStatement") return false;
    const e = (s as ExpressionStatement).expression as unknown as {
      type: string;
      delegate?: boolean;
      argument?: Expression;
    };
    return e.type === "YieldExpression" && !e.delegate && !!e.argument;
  });
  // A generator consumed by a manual `step()` surface (manual `.next()`,
  // destructure, or a read `yield*` completion value — series 075) must lower to
  // the state-machine struct, which carries `step()` / `Steppable`. The
  // straight-line `vec![…].into_iter()` fast path has no struct, so force the
  // machine for those consumers even when the body is straight-line.
  const isStraightLine =
    straightLineBody && !analysis.steppedGenerators.has(name);

  if (isStraightLine) {
    // `vec![e1, …].into_iter()` is an idiomatic `impl Iterator<Item = T>` — no
    // state machine needed for the finite case.
    const elements: HirExpr[] = func.body.body.map((s) => {
      const y = (s as ExpressionStatement).expression as unknown as {
        argument: Expression;
      };
      return lowerExpr(y.argument, analysis);
    });
    const body: HirStmt[] = [
      {
        kind: "return",
        value: {
          kind: "method",
          receiver: { kind: "array", elements },
          name: "into_iter",
          args: [],
        },
      },
    ];
    return {
      kind: "fn",
      name,
      isAsync: false,
      params,
      ret: { kind: "implIterator", item },
      body,
    };
  }

  return buildGeneratorStateMachine(
    func,
    name,
    params,
    item,
    declaredRetTy,
    analysis,
  );
}

// ── Generator state machines (series 052) ────────────────────────────────────
//
// A `function*` with loops / branches / non-`yield` statements lowers to a
// resumable state machine (`HirGenerator`): a `struct` (`state: u32` + carried
// params + across-yield locals) with `impl Iterator { fn next() { loop { match
// self.state { … } } } }`. The transform is two passes over a small intra-fn
// CFG: (1) build basic blocks split at every `yield` and control-flow join;
// (2) backward live-variable analysis to find locals **live across a yield** —
// those become struct fields (params always are). The suspend primitive is a
// nameable `yieldReturn` HIR node and the CFG/liveness are agnostic to `next`
// vs a future `poll_next`, so an async-generator (`Stream`) series can reuse
// this wholesale (see the 051↔052 overlap spike).

/** A basic-block terminator in the generator CFG (AST-level conditions/values). */
type GenTerm =
  | { kind: "goto"; target: number }
  | { kind: "branch"; cond: Expression; then: number; else: number }
  // `resultTarget` is the binding of a **read** yield result (`const x = yield e`,
  // series 076) — the resumed arm binds `x` to the sent value; `null` is a pure
  // `yield e;` statement (052, no result read).
  | { kind: "yield"; value: Expression; resume: number; resultTarget: string | null }
  // `yield*` delegation; `resultTarget` is the binding of a read completion value
  // (`const r = yield* inner()`, series 075), else `null` (065's unread form).
  | { kind: "yieldStar"; iter: Expression; resume: number; resultTarget: string | null }
  // `done` with an optional `return <value>` payload (series 075): the completion
  // value carried to `GenStep::Return`. `null` is a bare `return` / fall-off (`R = ()`).
  | { kind: "done"; value?: Expression | null };

/** A basic block: straight-line leaf statements then a terminator. */
interface GenBlock {
  id: number;
  stmts: Statement[];
  term: GenTerm;
}

function buildGeneratorStateMachine(
  func: FunctionDeclaration,
  name: string,
  params: HirParam[],
  item: RustType,
  declaredRetTy: RustType | null,
  analysis: ModuleAnalysis,
): HirGenerator {
  // A borrowed param can't be captured owned in the struct (it would need a
  // lifetime-bearing generator struct) — the owned Option-A model can't express
  // it. In scope all generator params are `Copy` scalars; this stays fail-loud.
  for (const p of params) {
    if (p.ty.kind === "ref") {
      throw new UnsupportedError({
        type: "state-machine generator with a borrowed (non-owned) parameter",
      });
    }
  }
  const body = func.body!;

  // ── Pass 1: build the CFG ──────────────────────────────────────────────────
  const blocks: GenBlock[] = [];
  const newBlock = (): number => {
    const id = blocks.length;
    blocks.push({ id, stmts: [], term: { kind: "done" } });
    return id;
  };
  /** Every index here comes from `newBlock()`, so the block always exists. */
  const bat = (i: number): GenBlock => blocks[i] as GenBlock;
  const loopStack: { brk: number; cont: number }[] = [];

  const buildStmt = (s: Statement, cur: number): number | null => {
    switch (s.type) {
      case "ExpressionStatement": {
        const e = (s as ExpressionStatement).expression as unknown as {
          type: string;
          delegate?: boolean;
          argument?: Expression;
        };
        if (e.type === "YieldExpression") {
          if (!e.argument) {
            throw new UnsupportedError({ type: "bare `yield` (no value)" });
          }
          const resume = newBlock();
          // `yield* <iter>` (series 065) → a delegating state; a plain `yield v` →
          // a suspend state (052).
          bat(cur).term = e.delegate
            ? { kind: "yieldStar", iter: e.argument, resume, resultTarget: null }
            : { kind: "yield", value: e.argument, resume, resultTarget: null };
          return resume;
        }
        bat(cur).stmts.push(s);
        return cur;
      }
      case "VariableDeclaration": {
        // `const r = yield* inner()` (series 075) — a read `yield*` completion
        // value: a delegating state that binds the delegate's `GenStep::Return`
        // payload to `r`. A single declarator only (the common shape).
        const decls = (s as VariableDeclaration).declarations;
        const d0 = decls[0] as
          | { id?: { type?: string; name?: string }; init?: unknown }
          | undefined;
        const init0 = d0?.init as
          | { type?: string; delegate?: boolean; argument?: Expression }
          | undefined;
        if (
          decls.length === 1 &&
          d0?.id?.type === "Identifier" &&
          d0.id.name &&
          init0?.type === "YieldExpression" &&
          init0.delegate &&
          init0.argument
        ) {
          const resume = newBlock();
          bat(cur).term = {
            kind: "yieldStar",
            iter: init0.argument,
            resume,
            resultTarget: d0.id.name,
          };
          return resume;
        }
        // `const x = yield e` (series 076) — a **read** yield result: a suspend
        // state whose resumed arm binds `x` to the sent value. This makes the
        // generator bidirectional (a `resume(&mut self, sent)` method). A single
        // identifier declarator only (the common shape).
        if (
          decls.length === 1 &&
          d0?.id?.type === "Identifier" &&
          d0.id.name &&
          init0?.type === "YieldExpression" &&
          !init0.delegate &&
          init0.argument
        ) {
          const resume = newBlock();
          bat(cur).term = {
            kind: "yield",
            value: init0.argument,
            resume,
            resultTarget: d0.id.name,
          };
          return resume;
        }
        bat(cur).stmts.push(s);
        return cur;
      }
      case "IfStatement": {
        const iff = s as IfStatement;
        // A yield-free `if` is an ordinary leaf statement — keep it whole so the
        // CFG cost is paid only for branches that actually suspend.
        if (!containsYield(iff)) {
          bat(cur).stmts.push(s);
          return cur;
        }
        const thenEntry = newBlock();
        const hasElse = !!iff.alternate;
        const elseEntry = hasElse ? newBlock() : null;
        const cont = newBlock();
        bat(cur).term = {
          kind: "branch",
          cond: iff.test,
          // biome-ignore lint/suspicious/noThenProperty: `then`/`else` are CFG branch-target block indices, not a thenable
          then: thenEntry,
          else: hasElse ? (elseEntry as number) : cont,
        };
        const thenExit = buildSeq(blockBody(iff.consequent), thenEntry);
        if (thenExit !== null)
          bat(thenExit).term = { kind: "goto", target: cont };
        if (hasElse) {
          const elseExit = buildSeq(
            blockBody(iff.alternate as Statement),
            elseEntry as number,
          );
          if (elseExit !== null)
            bat(elseExit).term = { kind: "goto", target: cont };
        }
        return cont;
      }
      case "ForStatement": {
        const f = s as ForStatement;
        if (!containsYield(f)) {
          bat(cur).stmts.push(s);
          return cur;
        }
        if (f.init) {
          bat(cur).stmts.push(
            f.init.type === "VariableDeclaration"
              ? (f.init as unknown as Statement)
              : exprStmt(f.init as Expression),
          );
        }
        const test = newBlock();
        const bodyB = newBlock();
        const update = newBlock();
        const cont = newBlock();
        bat(cur).term = { kind: "goto", target: test };
        bat(test).term = f.test
          ? // biome-ignore lint/suspicious/noThenProperty: `then`/`else` are CFG branch-target block indices, not a thenable
            { kind: "branch", cond: f.test, then: bodyB, else: cont }
          : { kind: "goto", target: bodyB };
        loopStack.push({ brk: cont, cont: update });
        const bodyExit = buildSeq(blockBody(f.body), bodyB);
        loopStack.pop();
        if (bodyExit !== null)
          bat(bodyExit).term = { kind: "goto", target: update };
        if (f.update) bat(update).stmts.push(exprStmt(f.update));
        bat(update).term = { kind: "goto", target: test };
        return cont;
      }
      case "WhileStatement": {
        const w = s as WhileStatement;
        if (!containsYield(w)) {
          bat(cur).stmts.push(s);
          return cur;
        }
        const test = newBlock();
        const bodyB = newBlock();
        const cont = newBlock();
        bat(cur).term = { kind: "goto", target: test };
        bat(test).term = {
          kind: "branch",
          cond: w.test,
          // biome-ignore lint/suspicious/noThenProperty: `then`/`else` are CFG branch-target block indices, not a thenable
          then: bodyB,
          else: cont,
        };
        loopStack.push({ brk: cont, cont: test });
        const bodyExit = buildSeq(blockBody(w.body), bodyB);
        loopStack.pop();
        if (bodyExit !== null)
          bat(bodyExit).term = { kind: "goto", target: test };
        return cont;
      }
      case "BlockStatement":
        return buildSeq((s as BlockStatement).body, cur);
      case "BreakStatement": {
        if ((s as BreakStatement).label) {
          throw new UnsupportedError({ type: "labeled break" });
        }
        const top = loopStack[loopStack.length - 1];
        if (!top) {
          throw new UnsupportedError({
            type: "`break` outside a loop in a generator",
          });
        }
        bat(cur).term = { kind: "goto", target: top.brk };
        return null;
      }
      case "ContinueStatement": {
        if ((s as ContinueStatement).label) {
          throw new UnsupportedError({ type: "labeled continue" });
        }
        const top = loopStack[loopStack.length - 1];
        if (!top) {
          throw new UnsupportedError({
            type: "`continue` outside a loop in a generator",
          });
        }
        bat(cur).term = { kind: "goto", target: top.cont };
        return null;
      }
      case "ReturnStatement": {
        // `return <value>` (series 075) carries the completion value to the
        // terminal as the `GenStep::Return` payload; a bare `return` is `R = ()`.
        const arg = (s as { argument?: Expression | null }).argument ?? null;
        bat(cur).term = { kind: "done", value: arg };
        return null;
      }
      default:
        throw new UnsupportedError({
          type: `unsupported statement in a state-machine generator: ${s.type}`,
        });
    }
  };

  function buildSeq(stmts: Statement[], startBlock: number): number | null {
    let cur: number | null = startBlock;
    for (const s of stmts) {
      if (cur === null) {
        throw new UnsupportedError({
          type: "unreachable statement after return/break/continue in a generator",
        });
      }
      cur = buildStmt(s, cur);
    }
    return cur;
  }

  const entry = newBlock(); // state 0
  const exit = buildSeq(body.body, entry);
  if (exit !== null) bat(exit).term = { kind: "done" };
  const terminal = blocks.length; // the reserved `_ => None` state

  // The completion type `R` (series 075): an explicit `Generator<Y, R>` arg wins;
  // otherwise inferred from the first `return <value>`; bare `return` / fall-off is
  // unit. `hasReturnValue` drives the `__ret: Option<R>` field + `step()` `take()`.
  const returnValueExprs = blocks
    .map((b) => (b.term.kind === "done" ? b.term.value ?? null : null))
    .filter((v): v is Expression => v !== null);
  const hasReturnValue = returnValueExprs.length > 0;
  let retTy: RustType = declaredRetTy ?? UNIT;
  if (!declaredRetTy && hasReturnValue) {
    // Infer `R` from the first `return <value>` — type its lowered form with the
    // param context (across-yield locals aren't in scope for a numeric return, the
    // common case). An unresolved type is fail-loud (annotate `Generator<Y, R>`).
    const ctx = new Map<string, RustType>();
    for (const p of params) ctx.set(p.name, p.ty);
    const inferred = typeCbBody(
      lowerExpr(returnValueExprs[0] as Expression, analysis),
      ctx,
    );
    if (!inferred || inferred.kind === "unit") {
      throw new UnsupportedError({
        type: "generator `return <value>` whose completion type can't be inferred — annotate `Generator<Y, R>`",
      });
    }
    retTy = inferred;
  }

  // ── Pass 2: liveness → which locals become struct fields ───────────────────
  const paramNames = new Set(params.map((p) => p.name));
  const declaredLocals = collectDeclaredLocals(body.body); // source order
  const universe = new Set<string>([...paramNames, ...declaredLocals]);

  // `use[b]` is the **upward-exposed** reads (read before being defined within
  // the block); `def[b]` is the locals declared in the block. Walking the block
  // in order and killing a name at its declaration keeps a define-then-yield
  // local (e.g. `const doubled = i*2; yield doubled;`) out of `use[b]`, so its
  // liveness doesn't spuriously flow around a loop back-edge and promote it.
  const useSet: Set<string>[] = [];
  const defSet: Set<string>[] = [];
  for (const b of blocks) {
    const uses = new Set<string>();
    const defs = new Set<string>();
    const killed = new Set<string>();
    const addUpwardReads = (node: unknown): void => {
      const reads = new Set<string>();
      collectRefs(node, universe, reads);
      for (const r of reads) if (!killed.has(r)) uses.add(r);
    };
    for (const s of b.stmts) {
      addUpwardReads(s); // reads (a declarator's init, an assignment's operands)
      const declared = new Set<string>();
      collectDeclaredLocalsInto(s, declared);
      for (const d of declared) {
        defs.add(d);
        killed.add(d);
      }
    }
    // The terminator's reads run after every statement in the block.
    if (b.term.kind === "branch") addUpwardReads(b.term.cond);
    if (b.term.kind === "yield") addUpwardReads(b.term.value);
    if (b.term.kind === "yieldStar") addUpwardReads(b.term.iter);
    if (b.term.kind === "done" && b.term.value) addUpwardReads(b.term.value);
    useSet.push(uses);
    defSet.push(defs);
  }
  const succ = (b: GenBlock): number[] => {
    switch (b.term.kind) {
      case "goto":
        return [b.term.target];
      case "branch":
        return [b.term.then, b.term.else];
      case "yield":
        return [b.term.resume];
      case "yieldStar":
        return [b.term.resume];
      case "done":
        return [];
    }
  };

  const liveIn = blocks.map(() => new Set<string>());
  const liveOut = blocks.map(() => new Set<string>());
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const out = new Set<string>();
      for (const sc of succ(bat(i)))
        for (const v of liveIn[sc] as Set<string>) out.add(v);
      const inn = new Set(useSet[i]);
      const defs = defSet[i] as Set<string>;
      for (const v of out) if (!defs.has(v)) inn.add(v);
      if (
        !setEq(out, liveOut[i] as Set<string>) ||
        !setEq(inn, liveIn[i] as Set<string>)
      ) {
        liveOut[i] = out;
        liveIn[i] = inn;
        changed = true;
      }
    }
  }

  // A local live-out of any *yielding* block must survive suspend → a field.
  // Params are always fields (captured at construction).
  const fieldNames = new Set<string>(paramNames);
  for (const b of blocks) {
    // A `yield*` state can also suspend mid-delegation, so its live-out locals
    // must survive too (series 065).
    if (b.term.kind === "yield" || b.term.kind === "yieldStar") {
      for (const v of liveOut[b.id] as Set<string>) {
        if (declaredLocals.includes(v)) fieldNames.add(v);
      }
    }
  }

  // A read `yield*` completion binding (`const r = yield* inner()`, series 075) is
  // written in the delegating arm and read afterward — always a carried field, typed
  // by the delegate generator's declared `R`.
  const fieldTypes = new Map<string, RustType>();
  for (const b of blocks) {
    if (b.term.kind === "yieldStar" && b.term.resultTarget !== null) {
      fieldNames.add(b.term.resultTarget);
      const delegateRet = isGeneratorCall(b.term.iter, analysis)
        ? (analysis.generatorRetTypes.get(
            ((b.term.iter as CallExpression).callee as Identifier).name,
          ) ?? UNIT)
        : UNIT;
      fieldTypes.set(b.term.resultTarget, delegateRet);
    }
  }

  // A **read** yield result (`const x = yield e`, series 076) makes the generator
  // bidirectional. Its `TNext` (the 3rd `Generator<Y, R, TNext>` type arg) types
  // the resumed binding and the `resume(sent: TNext)` param; unannotated → fail-loud
  // (can't type `sent`). Each such binding is written in its resumed arm and read
  // afterward → a carried field.
  const bidirectional = blocks.some(
    (b) => b.term.kind === "yield" && b.term.resultTarget !== null,
  );
  const nextTy = analysis.generatorNextTypes.get(name) ?? null;
  if (bidirectional && !nextTy) {
    throw new UnsupportedError({
      type: "generator reads a `yield` result (`const x = yield e`) but declares no resume-in type — annotate `Generator<Y, R, TNext>` (fail-loud residual, series 076)",
    });
  }
  for (const b of blocks) {
    if (b.term.kind === "yield" && b.term.resultTarget !== null) {
      fieldNames.add(b.term.resultTarget);
      fieldTypes.set(b.term.resultTarget, nextTy as RustType);
    }
  }

  // ── Lower each block's leaf statements (field-aware `let` → assign) ─────────
  for (const p of params) fieldTypes.set(p.name, p.ty);

  const loweredBlocks = blocks.map((b) => {
    const out: HirStmt[] = [];
    for (const s of b.stmts) {
      for (const st of lowerStatement(s, analysis, name)) {
        // A field local's `let` becomes an assignment to `self.<field>` (the
        // field-ref rewrite below turns the bare target into `self.x`); its
        // declared type seeds the struct field.
        if (st.kind === "let" && !st.names && fieldNames.has(st.name)) {
          if (st.ty) fieldTypes.set(st.name, st.ty);
          out.push({
            kind: "expr",
            expr: {
              kind: "assign",
              op: "=",
              target: { kind: "ident", name: st.name },
              value: st.init,
            },
          });
        } else {
          out.push(st);
        }
      }
    }
    return out;
  });

  // A resumed arm of a **read** yield (`const x = yield e`, series 076) binds the
  // sent value to `x` at its head: `self.<x> = self.__sent.take().unwrap();`. `resume`
  // stashes `__sent` before the loop; the initial state (state 0) has no pending
  // yield, so the first-resume value is discarded (matching JS).
  const resumeBindings = new Map<number, string>();
  for (const b of blocks) {
    if (b.term.kind === "yield" && b.term.resultTarget !== null) {
      resumeBindings.set(b.term.resume, b.term.resultTarget);
    }
  }

  // ── Assemble the `match` arms (append each block's terminator) ──────────────
  const delegateFields: {
    name: string;
    steppable: boolean;
    delegateRet: RustType;
  }[] = [];
  const states = blocks.map((b) => {
    const arm: HirStmt[] = [...(loweredBlocks[b.id] as HirStmt[])];
    const sentBind = resumeBindings.get(b.id);
    if (sentBind !== undefined) {
      // Bind the sent value at the head of the resumed arm (field-ref rewritten
      // below to `self.<sentBind>`). `genResumeBind` takes the stashed `__sent`.
      arm.unshift({ kind: "genResumeBind", target: sentBind });
    }
    switch (b.term.kind) {
      case "goto":
        arm.push({ kind: "gotoState", state: b.term.target });
        break;
      case "branch":
        arm.push({
          kind: "if",
          cond: lowerExpr(b.term.cond, analysis),
          conseq: [{ kind: "gotoState", state: b.term.then }],
          alt: [{ kind: "gotoState", state: b.term.else }],
        });
        break;
      case "yield":
        arm.push({
          kind: "yieldReturn",
          value: lowerExpr(b.term.value, analysis),
          resumeState: b.term.resume,
        });
        break;
      case "yieldStar": {
        // `yield* <iter>` (065/075): a delegating state with its own boxed iterator
        // field. Unread (065): `<iter>.into_iter()` boxed as `dyn Iterator`, pumped
        // to exhaustion. Read completion (075, `const r = yield*`): the delegate must
        // be a known generator (its struct impls `Steppable`) — box the call directly
        // as `dyn Steppable` and pump `.step()`, binding the `Return` payload.
        const field = `__delegate_${b.id}`;
        const readResult = b.term.resultTarget !== null;
        if (readResult && !isGeneratorCall(b.term.iter, analysis)) {
          throw new UnsupportedError({
            type: "read `yield*` completion value over a non-generator iterable (no completion value exists — only a generator delegate carries one)",
          });
        }
        const delegateRet = readResult
          ? (analysis.generatorRetTypes.get(
              ((b.term.iter as CallExpression).callee as Identifier).name,
            ) ?? UNIT)
          : UNIT;
        delegateFields.push({ name: field, steppable: readResult, delegateRet });
        arm.push({
          kind: "yieldStarStep",
          field,
          iter: readResult
            ? lowerExpr(b.term.iter, analysis)
            : {
                kind: "method",
                receiver: lowerExpr(b.term.iter, analysis),
                name: "into_iter",
                args: [],
              },
          resumeState: b.term.resume,
          readResult: readResult || undefined,
          resultTarget: b.term.resultTarget ?? undefined,
        });
        break;
      }
      case "done":
        arm.push({
          kind: "genDone",
          terminal,
          retValue: b.term.value
            ? lowerExpr(b.term.value, analysis)
            : undefined,
          hasRet: hasReturnValue,
        });
        break;
    }
    return { id: b.id, body: rewriteFieldRefs(arm, fieldNames) };
  });

  const localFields = declaredLocals
    .filter((n) => fieldNames.has(n))
    .map((n) => ({
      name: n,
      ty: fieldTypes.get(n) ?? ({ kind: "f64" } as RustType),
    }));

  // A `TNext` is **defaultable** (series 076) when it carries the 066 undefined
  // model — i.e. lowers to `Option<T>` (default `None`, faithful to JS's `undefined`
  // sent by `for-of`/spread). Then the generator keeps `impl Iterator` / `step()`
  // (routed through `resume(<default>)`); a non-defaultable `TNext` is `resume`-only
  // (for-of / collect over it → fail-loud at the consumption site).
  const nextDefaultable = bidirectional && (nextTy as RustType).kind === "option";

  return {
    kind: "generator",
    name,
    structName: `${capitalizeAscii(name)}Gen`,
    item,
    retTy,
    exposesStep: analysis.steppedGenerators.has(name),
    hasReturnValue,
    params,
    localFields,
    states,
    terminal,
    delegateFields,
    bidirectional,
    nextTy: bidirectional ? (nextTy as RustType) : UNIT,
    nextDefaultable,
  };
}

/** Does this subtree contain a `yield` (not descending into nested functions)? */
function containsYield(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as { type?: string };
  if (n.type === "YieldExpression") return true;
  if (
    n.type === "FunctionDeclaration" ||
    n.type === "FunctionExpression" ||
    n.type === "ArrowFunctionExpression"
  ) {
    return false; // an inner function's `yield` isn't ours
  }
  for (const key in node) {
    if (key === "type") continue;
    const v = (node as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      for (const el of v) if (containsYield(el)) return true;
    } else if (containsYield(v)) {
      return true;
    }
  }
  return false;
}
