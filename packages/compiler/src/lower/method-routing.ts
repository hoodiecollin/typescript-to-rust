/**
 * Primitive / array / string / number method dispatch + the 029 method catalog
 * (series 083 / 029). Routes a receiver-typed method or a `Math`/`Number` static
 * to its native-Rust or `tslib`-fidelity lowering, or returns null to fall
 * through to the generic (fail-loud) path. Split out of `lower/index.ts`
 * (series 109).
 */

import type { ModuleAnalysis } from "../analysis";
import type {
  CallExpression,
  Expression,
  Identifier,
  Literal,
  MemberExpression,
} from "../ast";
import { UnsupportedError } from "../errors";
import type { HirArg, HirExpr, HirStmt, RustType } from "../hir";
import { lowerExpr } from "./expressions";
import { receiverTypeOf, STRING_METHOD_DEFERRED } from "./typing";

/**
 * Route a *quirk-heavy* library method to the `tslib` fidelity crate (series
 * 027), or return null to leave it as a native `method` call. The emitter's
 * hybrid rule: emit native idiomatic Rust where a JS method maps cleanly, and
 * confine JS-quirk semantics (negative `at`, `padStart`/`padEnd`) to `tslib`.
 * Numeric args are passed as owned `f64` — `tslib` floors them, so the runtime
 * coercion lives in the audited crate, not a codegen `as usize` cast.
 */
export function tryTslibMethod(
  methodName: string,
  m: MemberExpression,
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const recvRef = (): HirArg => ({
    borrow: "ref",
    expr: lowerExpr(m.object, analysis),
  });
  const args = call.arguments;
  // `xs.at(i)` → `tslib::array::at(&xs, i)` (JS negative-from-end indexing).
  if (methodName === "at" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::array::at",
      args: [
        recvRef(),
        { borrow: "owned", expr: lowerExpr(args[0], analysis) },
      ],
    };
  }
  // `xs.slice(start[, end])` → `tslib::array::slice{,_from}(&xs, …)` (040): JS's
  // clamped, negative-aware, end-exclusive shallow copy. Numeric args are owned
  // `f64` (floored in `tslib`, the `at` precedent).
  if (methodName === "slice" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::array::slice_from",
      args: [
        recvRef(),
        { borrow: "owned", expr: lowerExpr(args[0], analysis) },
      ],
    };
  }
  if (methodName === "slice" && args.length === 2 && args[0] && args[1]) {
    return {
      kind: "call",
      callee: "tslib::array::slice",
      args: [
        recvRef(),
        { borrow: "owned", expr: lowerExpr(args[0], analysis) },
        { borrow: "owned", expr: lowerExpr(args[1], analysis) },
      ],
    };
  }
  // `s.padStart(n, pad)` / `s.padEnd(n, pad)` → `tslib::string::pad_{start,end}`.
  if (
    (methodName === "padStart" || methodName === "padEnd") &&
    args.length === 2 &&
    args[0] &&
    args[1]
  ) {
    const fn = methodName === "padStart" ? "pad_start" : "pad_end";
    return {
      kind: "call",
      callee: `tslib::string::${fn}`,
      args: [
        recvRef(),
        { borrow: "owned", expr: lowerExpr(args[0], analysis) },
        { borrow: "ref", expr: lowerExpr(args[1], analysis) },
      ],
    };
  }
  return null;
}

// ── Primitive-method dispatch (series 083) ────────────────────────────────────

/**
 * A `string`/`number` receiver method (series 083), routed through the unified
 * `receiverTypeOf` gate and the 029 catalog. Sibling to `tryMapSetMethod`/
 * `tryTslibMethod`, called from `lowerCall` **before** the generic fallthrough.
 * Returns null for a receiver we don't model as a primitive (→ fall through →
 * today's fail-loud), never a wrong emit.
 */
export function tryPrimitiveMethod(
  methodName: string,
  m: MemberExpression,
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const recv = receiverTypeOf(m.object, analysis);
  if (recv?.kind === "String")
    return stringMethod(methodName, m, call, analysis);
  if (recv?.kind === "f64") return numberMethod(methodName, m, call, analysis);
  if (recv?.kind === "vec")
    return arrayTailMethod(methodName, m, call, recv.elem, analysis);
  return null;
}

/**
 * Array-access tail methods (series 083 slice 8) — `join`, `concat`, `splice`.
 * `reverse` already lowers natively (`Vec::reverse`, in place) so it is not
 * routed here. Gated on a `vec` receiver via `receiverTypeOf`. `null` → fall
 * through.
 */
export function arrayTailMethod(
  methodName: string,
  m: MemberExpression,
  call: CallExpression,
  _elem: RustType,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const args = call.arguments;
  const recvRef: HirArg = { borrow: "ref", expr: lowerExpr(m.object, analysis) };
  // `xs.join(sep)` → tslib: JS coerces each element to its string form then joins
  // (so a number array joins as `"1-2-3"`), which `[T]::join` cannot do (no
  // `Display`-join in std). Confined to tslib for the string-coercion fidelity.
  if (methodName === "join" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::array::join",
      args: [recvRef, { borrow: "owned", expr: strPatternArg(args[0], analysis) }],
    };
  }
  if (methodName === "join" && args.length === 0) {
    // Default separator is "," in JS.
    return {
      kind: "call",
      callee: "tslib::array::join",
      args: [recvRef, { borrow: "owned", expr: { kind: "raw", text: '","' } }],
    };
  }
  // `xs.concat(ys)` → a new `Vec` (JS returns a fresh array; the receiver is
  // unchanged). `tslib::array::concat` clones both into one.
  if (methodName === "concat" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::array::concat",
      args: [
        recvRef,
        { borrow: "ref", expr: lowerExpr(args[0], analysis) },
      ],
    };
  }
  // `xss.flat()` (depth 1) / `xss.flat(k)` / `xss.flat(Infinity)` (series 085 +
  // 092). JS flattens `min(k, N)` levels, where `N` is the receiver's static
  // nesting depth (the homogeneous dialect makes it compile-time-known) — an
  // over-deep or `Infinity` request flattens all `N` levels to the scalar leaf,
  // and flattening an already-flat array is a **no-op** copy (`min`→0), never an
  // error. A runtime-**variable** depth isn't a compile-time constant → declined
  // (fall through → cargo-loud). Emits `effective` chained depth-1 flattens.
  if (methodName === "flat" && (args.length === 0 || args.length === 1)) {
    const depth = flatDepthArg(args[0]);
    if (depth === null) return null; // runtime-variable depth → fall through (cargo-loud)
    // The static nesting depth `N`: count the `vec` levels of the element type.
    let nesting = 0;
    for (let cur: RustType = _elem; cur.kind === "vec"; cur = cur.elem) nesting++;
    const effective = Math.min(depth, nesting);
    if (effective === 0) {
      // `min(depth, N) === 0` — already-flat / no-op flatten: JS returns a shallow
      // copy of the array, so clone the receiver `Vec`.
      return { kind: "method", receiver: lowerExpr(m.object, analysis), name: "clone", args: [] };
    }
    // Emit `effective` chained depth-1 flattens: flat(flat(...flat(&recv)...)).
    let call: HirExpr = { kind: "call", callee: "tslib::array::flat", args: [recvRef] };
    for (let level = 1; level < effective; level++) {
      call = {
        kind: "call",
        callee: "tslib::array::flat",
        args: [{ borrow: "ref", expr: call }],
      };
    }
    return call;
  }
  // `a.push(x)` / `a.unshift(x)` **used as a value** (series 116) — JS returns the
  // new length, so lower to the length-yielding block (`arrayMutLen`). Statement
  // position is intercepted earlier (`tryArrayMutStatement`) to a bare mutation, so
  // reaching here means the return value is consumed. `pushMethod` holds the JS name
  // (`push`/`unshift`); `refineDeque` retargets it (`push`→`push_back`,
  // `unshift`→`push_front`) for a front-mutated `VecDeque` binding.
  if (
    (methodName === "push" || methodName === "unshift") &&
    args.length === 1 &&
    args[0]
  ) {
    return {
      kind: "arrayMutLen",
      receiver: lowerExpr(m.object, analysis),
      arg: lowerExpr(args[0], analysis),
      pushMethod: methodName,
    };
  }
  // `a.splice(start, deleteCount, ...items)` (series 116) → a tslib helper that
  // removes + inserts and **returns the removed `Vec<T>`** (JS's return value). The
  // receiver is borrowed `&mut`; the variadic inserts collect into a `Vec<T>` (empty
  // for a pure remove). `a.splice(start)` (delete-to-end) passes `f64::INFINITY`,
  // which the helper clamps to `len - start`. A front-mutated (`VecDeque`) receiver
  // is retargeted to `deque_splice` by `refineDeque`.
  if (methodName === "splice" && args.length >= 1 && args[0]) {
    const start: HirArg = { borrow: "owned", expr: lowerExpr(args[0], analysis) };
    const deleteCount: HirArg =
      args.length >= 2 && args[1]
        ? { borrow: "owned", expr: lowerExpr(args[1], analysis) }
        : { borrow: "owned", expr: { kind: "raw", text: "f64::INFINITY" } };
    const items: HirExpr[] = args
      .slice(2)
      .map((a) => lowerExpr(a as Expression, analysis));
    return {
      kind: "call",
      callee: "tslib::array::splice",
      args: [
        { borrow: "refMut", expr: lowerExpr(m.object, analysis) },
        start,
        deleteCount,
        { borrow: "owned", expr: { kind: "array", elements: items } },
      ],
    };
  }
  return null;
}

/**
 * Statement-position `a.push(x)` / `a.unshift(x)` (series 116) → a **bare** mutation
 * (the JS return length is discarded), so it does not lower to the length-yielding
 * `arrayMutLen` block. Mirrors `tryForEach`: called from the `ExpressionStatement`
 * handler before generic expression lowering. The emitted method keeps its JS name
 * (`push`/`unshift`); `refineDeque` retargets it (`push`→`push_back`,
 * `unshift`→`push_front`) for a front-mutated `VecDeque` binding. `null` when `e` is
 * not a built-in push/unshift on an array receiver.
 */
export function tryArrayMutStatement(
  e: Expression,
  analysis: ModuleAnalysis,
): HirStmt[] | null {
  if (e.type !== "CallExpression") return null;
  const call = e as CallExpression;
  if (call.callee.type !== "MemberExpression") return null;
  const m = call.callee as MemberExpression;
  if (m.computed || m.property.type !== "Identifier") return null;
  const name = (m.property as Identifier).name;
  if (name !== "push" && name !== "unshift") return null;
  if (analysis.methodNames.has(name)) return null; // a user-declared method
  if (receiverTypeOf(m.object, analysis)?.kind !== "vec") return null;
  if (call.arguments.length !== 1 || !call.arguments[0]) return null;
  return [
    {
      kind: "expr",
      expr: {
        kind: "method",
        receiver: lowerExpr(m.object, analysis),
        name,
        args: [lowerExpr(call.arguments[0] as Expression, analysis)],
      },
    },
  ];
}

/**
 * The requested depth of a `flat(k)` argument (series 085 + 092). No arg → depth
 * 1. A numeric literal → `max(0, floor(k))` (JS clamps a negative/fractional
 * depth). The `Infinity` global → `Infinity` (flatten all levels). A runtime
 * **variable** (or any other non-constant) → `null` so the caller declines and
 * falls through (never a wrong flatten). The caller clamps to the static nesting.
 */
export function flatDepthArg(arg: Expression | undefined): number | null {
  if (arg === undefined) return 1;
  if (arg.type === "Identifier" && (arg as Identifier).name === "Infinity") {
    return Infinity;
  }
  if (arg.type !== "Literal") return null;
  const v = (arg as Literal).value;
  if (typeof v !== "number") return null;
  return Math.max(0, Math.floor(v));
}

/** A `&self` shared-borrow arg of the primitive receiver (for a tslib fn). */
export function primRecvRef(m: MemberExpression, analysis: ModuleAnalysis): HirArg {
  return { borrow: "ref", expr: lowerExpr(m.object, analysis) };
}

/** An owned `f64` arg (floored in tslib, the `at`/`slice` precedent). */
export function ownedArg(e: Expression, analysis: ModuleAnalysis): HirArg {
  return { borrow: "owned", expr: lowerExpr(e, analysis) };
}

/** A `&`-borrowed arg (a `&str` for a tslib string fn). */
export function refArg(e: Expression, analysis: ModuleAnalysis): HirArg {
  return { borrow: "ref", expr: lowerExpr(e, analysis) };
}

/**
 * A `&str`-pattern arg (series 083). `str::contains`/`starts_with`/`ends_with`
 * take an `impl Pattern` (a `&str`, **not** a `&String`), so a `String`/`&String`/
 * `&str` operand is uniformly coerced via `AsRef::<str>::as_ref(&(expr))`. Wrapped
 * `raw` so the emitter renders the coercion verbatim around the inner expr.
 */
export function strPatternArg(e: Expression, analysis: ModuleAnalysis): HirExpr {
  // Fast path (#88, "2b" literal interning): a bare string *literal* is already a
  // `&'static str` — the exact pattern type every `strPatternArg` call site wants
  // (`str::contains`/`split`/`index_of`/`replace`, all `&str`/`impl Pattern`). Emit
  // it verbatim and skip the `AsRef::<str>::as_ref(&"…".to_string())` wrapper, which
  // allocated a throwaway `String` per call just to borrow it back down to `&str`.
  if (e.type === "Literal" && typeof (e as Literal).value === "string") {
    return { kind: "raw", text: JSON.stringify((e as Literal).value) };
  }
  return {
    kind: "call",
    callee: "AsRef::<str>::as_ref",
    args: [{ borrow: "ref", expr: lowerExpr(e, analysis) }],
  };
}

/**
 * String receiver methods (029 String rows). Native where Rust matches JS;
 * `tslib::string::*` only for a JS quirk (`replace`-first, empty-sep split, the
 * UTF-16 slice family). `null` → not modeled → fall through.
 */
export function stringMethod(
  methodName: string,
  m: MemberExpression,
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const recv = (): HirExpr => lowerExpr(m.object, analysis);
  const args = call.arguments;
  const method = (name: string, methodArgs: HirExpr[] = []): HirExpr => ({
    kind: "method",
    receiver: recv(),
    name,
    args: methodArgs,
  });

  // `.toString()` — identity on `String`. Native.
  if (methodName === "toString" && args.length === 0) return method("clone");
  // Case + trim — native, Rust Unicode casing ≈ JS (documented divergence).
  if (methodName === "toUpperCase" && args.length === 0)
    return method("to_uppercase");
  if (methodName === "toLowerCase" && args.length === 0)
    return method("to_lowercase");
  if (methodName === "trim" && args.length === 0) return method("trim");
  if (methodName === "trimStart" && args.length === 0)
    return method("trim_start");
  if (methodName === "trimEnd" && args.length === 0) return method("trim_end");
  // Predicates — native (arg is `&str`; `.contains`/`.starts_with`/`.ends_with`
  // take `&str`, and a `String` derefs so a bare arg works via `&`).
  if (
    (methodName === "includes" ||
      methodName === "startsWith" ||
      methodName === "endsWith") &&
    args.length === 1 &&
    args[0]
  ) {
    const rustName =
      methodName === "includes"
        ? "contains"
        : methodName === "startsWith"
          ? "starts_with"
          : "ends_with";
    return {
      kind: "method",
      receiver: recv(),
      name: rustName,
      args: [strPatternArg(args[0], analysis)],
    };
  }
  // `.repeat(n)` — native; `n` is `f64` → `as usize`.
  if (methodName === "repeat" && args.length === 1 && args[0]) {
    return {
      kind: "method",
      receiver: recv(),
      name: "repeat",
      args: [{ kind: "cast", expr: lowerExpr(args[0], analysis), ty: { kind: "usize" } }],
    };
  }
  // `.replace(a, b)` — first match only (JS quirk) → tslib. Args are `&str`.
  if (methodName === "replace" && args.length === 2 && args[0] && args[1]) {
    return {
      kind: "call",
      callee: "tslib::string::replace_first",
      args: [
        primRecvRef(m, analysis),
        { borrow: "owned", expr: strPatternArg(args[0], analysis) },
        { borrow: "owned", expr: strPatternArg(args[1], analysis) },
      ],
    };
  }
  // `.replaceAll(a, b)` — all matches → native `.replace` (`&str` pattern + repl).
  if (methodName === "replaceAll" && args.length === 2 && args[0] && args[1]) {
    return {
      kind: "method",
      receiver: recv(),
      name: "replace",
      args: [strPatternArg(args[0], analysis), strPatternArg(args[1], analysis)],
    };
  }
  // `.split(sep)` — native for a non-empty literal sep; empty sep → tslib
  // (JS splits into code units, quirk). A non-literal sep routes to tslib too so
  // the empty-string case is handled at runtime.
  if (methodName === "split" && args.length === 1 && args[0]) {
    const sep = args[0];
    if (sep.type === "Literal" && (sep as Literal).value === "") {
      return {
        kind: "call",
        callee: "tslib::string::split_chars",
        args: [primRecvRef(m, analysis)],
      };
    }
    return {
      kind: "call",
      callee: "tslib::string::split",
      args: [
        primRecvRef(m, analysis),
        { borrow: "owned", expr: strPatternArg(sep, analysis) },
      ],
    };
  }
  // `.slice`/`.substring`/`.charAt` — UTF-16 vs char/byte quirk → tslib.
  if (methodName === "slice" && (args.length === 1 || args.length === 2)) {
    const a1 = args[0];
    if (!a1) return null;
    const callArgs: HirArg[] = [primRecvRef(m, analysis), ownedArg(a1, analysis)];
    if (args.length === 2 && args[1])
      callArgs.push(ownedArg(args[1], analysis));
    return {
      kind: "call",
      callee:
        args.length === 2 ? "tslib::string::str_slice" : "tslib::string::str_slice_from",
      args: callArgs,
    };
  }
  if (methodName === "substring" && args.length === 2 && args[0] && args[1]) {
    return {
      kind: "call",
      callee: "tslib::string::substring",
      args: [
        primRecvRef(m, analysis),
        ownedArg(args[0], analysis),
        ownedArg(args[1], analysis),
      ],
    };
  }
  if (methodName === "charAt" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::string::char_at",
      args: [primRecvRef(m, analysis), ownedArg(args[0], analysis)],
    };
  }
  // `.at(i)` → `tslib::string::str_at` → `Option<String>` (series 098): negative
  // from the end, out-of-range → `None` → JS `undefined` (the 066 model; distinct
  // from `charAt`'s `""`). Fixes the prior mis-route to `tslib::array::at`.
  if (methodName === "at" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::string::str_at",
      args: [primRecvRef(m, analysis), ownedArg(args[0], analysis)],
    };
  }
  // `.indexOf(needle[, from])` → `tslib::string::index_of` → `f64` (`-1` sentinel,
  // char-indexed). Omitted `from` defaults to 0 (series 098).
  if (
    methodName === "indexOf" &&
    (args.length === 1 || args.length === 2) &&
    args[0]
  ) {
    const from: HirArg =
      args.length === 2 && args[1]
        ? ownedArg(args[1], analysis)
        : { borrow: "owned", expr: { kind: "number", value: 0 } };
    return {
      kind: "call",
      callee: "tslib::string::index_of",
      args: [
        primRecvRef(m, analysis),
        { borrow: "owned", expr: strPatternArg(args[0], analysis) },
        from,
      ],
    };
  }
  // `.lastIndexOf(needle)` → `tslib::string::last_index_of` → `f64` (series 098).
  // The 2-arg `fromIndex` form stays a residual (falls through).
  if (methodName === "lastIndexOf" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::string::last_index_of",
      args: [
        primRecvRef(m, analysis),
        { borrow: "owned", expr: strPatternArg(args[0], analysis) },
      ],
    };
  }
  // `.padStart(n)` / `.padEnd(n)` — the 1-arg default-space form (series 098);
  // the 2-arg form falls through to `tryTslibMethod` (already shipped in 083).
  if (
    (methodName === "padStart" || methodName === "padEnd") &&
    args.length === 1 &&
    args[0]
  ) {
    const fn = methodName === "padStart" ? "pad_start" : "pad_end";
    return {
      kind: "call",
      callee: `tslib::string::${fn}`,
      args: [
        primRecvRef(m, analysis),
        ownedArg(args[0], analysis),
        { borrow: "ref", expr: { kind: "string", value: " " } },
      ],
    };
  }
  // `a.concat(b, c, …)` ≡ `a + b + c` → the 080 `strConcat` node (`format!`);
  // series 098. A spread arg isn't modeled (falls through).
  if (
    methodName === "concat" &&
    args.length >= 1 &&
    args.every((a) => a.type !== "SpreadElement")
  ) {
    return {
      kind: "strConcat",
      parts: [recv(), ...args.map((a) => lowerExpr(a as Expression, analysis))],
    };
  }
  // `.split(sep, limit)` — truncate to at most `limit` pieces (series 098). An
  // empty-string separator keeps the `split_chars` char-unit quirk.
  if (methodName === "split" && args.length === 2 && args[0] && args[1]) {
    const sep = args[0];
    if (sep.type === "Literal" && (sep as Literal).value === "") {
      return {
        kind: "call",
        callee: "tslib::string::split_chars_limit",
        args: [primRecvRef(m, analysis), ownedArg(args[1], analysis)],
      };
    }
    return {
      kind: "call",
      callee: "tslib::string::split_limit",
      args: [
        primRecvRef(m, analysis),
        { borrow: "owned", expr: strPatternArg(sep, analysis) },
        ownedArg(args[1], analysis),
      ],
    };
  }
  // `.substr(start[, length])` — deprecated but common (series 098); char-indexed,
  // negative `start` from the end.
  if (methodName === "substr" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::string::substr_from",
      args: [primRecvRef(m, analysis), ownedArg(args[0], analysis)],
    };
  }
  if (methodName === "substr" && args.length === 2 && args[0] && args[1]) {
    return {
      kind: "call",
      callee: "tslib::string::substr",
      args: [
        primRecvRef(m, analysis),
        ownedArg(args[0], analysis),
        ownedArg(args[1], analysis),
      ],
    };
  }
  // Deferred surface (series 098): a `String` receiver calling a known-unsupported
  // method fails loud with the reason, not a downstream cargo error.
  const deferred = STRING_METHOD_DEFERRED[methodName];
  if (deferred) throw new UnsupportedError({ type: deferred });
  return null;
}

/**
 * Number receiver methods (029 Number/Math rows). `.toString()` routes through
 * `tslib::number::to_js_string` for JS number→string fidelity (`-0`, magnitudes);
 * `.toFixed`/`.toString(radix)` are tslib. `Math.*` statics are handled in the
 * static-call path, not here (their receiver is the `Math` object).
 */
export function numberMethod(
  methodName: string,
  m: MemberExpression,
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const args = call.arguments;
  // `n.toString()` (no radix) → tslib::number::to_js_string (JS fidelity).
  if (methodName === "toString" && args.length === 0) {
    return {
      kind: "call",
      callee: "tslib::number::to_js_string",
      args: [ownedArg(m.object as Expression, analysis)],
    };
  }
  // `n.toString(radix)` → tslib::number::to_radix.
  if (methodName === "toString" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::number::to_radix",
      args: [
        ownedArg(m.object as Expression, analysis),
        ownedArg(args[0], analysis),
      ],
    };
  }
  // `n.toFixed(d)` → tslib::number::to_fixed.
  if (methodName === "toFixed" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::number::to_fixed",
      args: [
        ownedArg(m.object as Expression, analysis),
        ownedArg(args[0], analysis),
      ],
    };
  }
  return null;
}

/**
 * `Math.*` / `Number.parseInt|parseFloat` global statics (series 083). Native
 * `f64` methods where the semantics match JS; `tslib` for the parse quirks; a
 * `min!`/`max!` macro (the sanctioned variadic Tm route) for `Math.min`/`max`.
 * Returns null for an unmodeled static (→ fall through → fail-loud).
 */
export function lowerNumberStatic(
  global: string,
  methodName: string,
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const args = call.arguments as Expression[];
  // A method receiver that is a bare number literal (`3.7`) is an ambiguous
  // `{float}` in Rust (`3.7.floor()` fails E0689) — cast a literal receiver to
  // `f64` (`(3.7 as f64).floor()`). A non-literal `f64` receiver is unambiguous.
  // A receiver built ONLY from numeric literals (a single literal, or literal
  // arithmetic like `1.2 + 2.9`) has no typed leaf to anchor Rust's inference, so a
  // `.floor()`/`.sqrt()` on it is rejected as an ambiguous `{float}` (E0689, #73). A
  // receiver holding any identifier / call is already anchored. Arithmetic ops only:
  // a bitwise binary is already concrete (`i128`), so it needs no cast.
  const isPureNumericLiteral = (e: HirExpr): boolean =>
    e.kind === "number" ||
    (e.kind === "unary" && e.op === "-" && isPureNumericLiteral(e.operand)) ||
    (e.kind === "binary" &&
      !e.bitwise &&
      ["+", "-", "*", "/", "%"].includes(e.op) &&
      isPureNumericLiteral(e.left) &&
      isPureNumericLiteral(e.right));
  const f64Recv = (e: Expression): HirExpr => {
    const lowered = lowerExpr(e, analysis);
    return isPureNumericLiteral(lowered)
      ? { kind: "cast", expr: lowered, ty: { kind: "f64" } }
      : lowered;
  };
  if (global === "Math") {
    // `Math.random()` is fail-loud (series 089) — a hidden global PRNG cannot be
    // differential-stable against JS. Redirect to the explicit-seed `rng(seed)`
    // shim from "@ttr/std" (mirrors the bare-`JSON.parse` redirect precedent).
    if (methodName === "random") {
      throw new UnsupportedError({
        type: '`Math.random` is not accepted — import `rng` from "@ttr/std" and call `rng(seed)` (an explicit seed makes the stream differential-stable)',
      });
    }
    // `Math.floor/ceil/round/abs/trunc/sign/sqrt` — unary native `f64` methods.
    const unary: Record<string, string> = {
      floor: "floor",
      ceil: "ceil",
      round: "round",
      abs: "abs",
      trunc: "trunc",
      sqrt: "sqrt",
    };
    if (unary[methodName] && args.length === 1 && args[0]) {
      return {
        kind: "method",
        receiver: f64Recv(args[0]),
        name: unary[methodName] as string,
        args: [],
      };
    }
    // `Math.min`/`Math.max` — binary → native `f64::min`/`max`; variadic →
    // `min!`/`max!` macro (029 Tm). NaN-propagating like JS.
    if (
      (methodName === "min" || methodName === "max") &&
      args.length >= 1 &&
      args.every((a) => a)
    ) {
      if (args.length === 2 && args[0] && args[1]) {
        return {
          kind: "method",
          receiver: f64Recv(args[0]),
          name: methodName,
          args: [lowerExpr(args[1], analysis)],
        };
      }
      return {
        kind: "jsMinMax",
        op: methodName,
        args: args.map((a) => lowerExpr(a, analysis)),
      };
    }
    return null;
  }
  // `Number.parseInt(s[, radix])` / `Number.parseFloat(s)` → tslib (radix +
  // trailing-garbage tolerance quirks).
  if (methodName === "parseInt" && (args.length === 1 || args.length === 2)) {
    const a0 = args[0];
    if (!a0) return null;
    const callArgs: HirArg[] = [refArg(a0, analysis)];
    callArgs.push(
      args.length === 2 && args[1]
        ? ownedArg(args[1], analysis)
        : { borrow: "owned", expr: { kind: "number", value: 10 } },
    );
    return { kind: "call", callee: "tslib::number::parse_int", args: callArgs };
  }
  if (methodName === "parseFloat" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::number::parse_float",
      args: [refArg(args[0], analysis)],
    };
  }
  return null;
}
