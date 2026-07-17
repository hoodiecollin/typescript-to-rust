/**
 * Dialect validation (pipeline step 2): the single gate on the accepted **node
 * vocabulary**, run over the whole tree before lowering. Two rules:
 *
 *  1. Forbidden constructs → `DialectError` ("fix your input"). Forbidden types
 *     (`any`/`unknown`) and forbidden *flags* carried on otherwise-modeled nodes
 *     (generators, `for await`, `using`, decorators, `abstract`, `declare`).
 *     These last are the reason this gate is whole-tree and default-deny: the
 *     node *type* is modeled, so lowering matches it and silently drops the flag
 *     — emitting plausible-but-wrong Rust. Rejecting them here restores the
 *     fail-loud contract (see docs/work/024).
 *
 *  2. Default-deny on node type → `UnsupportedError` ("not implemented yet").
 *     Any node whose `type` is not in `MODELED` fails loud. Unmodeled types
 *     (enum, namespace, parameter property, export, …) are generally
 *     implementable and several are backlogged, so they get the "not yet" kind,
 *     not "forbidden" — and this can never flip an existing `UnsupportedError`
 *     into a `DialectError`. Adding a construct to the dialect now *requires*
 *     adding its node type here, mirroring the emitter's exhaustiveness guard.
 *
 * Distinct from lowering's own `UnsupportedError` sites, which reject *modeled*
 * node types in shapes not yet handled (labeled break, static field, …).
 */

import type { Program } from "./ast";
import { DialectError, UnsupportedError } from "./errors";
import { STD_SHIM_EXPORTS, STD_SHIM_SPECIFIER } from "./std-shim";

export { DialectError };

/** Forbidden type keywords → the message naming them. */
const FORBIDDEN_TYPES: Record<string, string> = {
  TSAnyKeyword: "`any` type",
  TSUnknownKeyword: "`unknown` type",
};

/**
 * The accepted node-type vocabulary: every type `ast.ts` models plus every type
 * observed across the green fixtures. Anything else fails loud as "not
 * implemented yet". Grow this in lockstep with the dialect.
 */
const MODELED: ReadonlySet<string> = new Set<string>([
  "Program",
  // Statements
  "VariableDeclaration",
  "VariableDeclarator",
  "FunctionDeclaration",
  "BlockStatement",
  "ReturnStatement",
  "ExpressionStatement",
  "IfStatement",
  "WhileStatement",
  "ForStatement",
  "ForOfStatement",
  "SwitchStatement",
  "SwitchCase",
  "BreakStatement",
  "ContinueStatement",
  // A labeled loop `outer: for (…)` (series 064) — `lowerLabeled` attaches the
  // label to the loop HIR node; `break`/`continue label` render `break 'label`.
  "LabeledStatement",
  "ThrowStatement",
  "TryStatement",
  "CatchClause",
  "TSInterfaceDeclaration",
  "TSInterfaceBody",
  "TSPropertySignature",
  // Behavioral interface method signatures + `class C implements I` (series 071).
  "TSMethodSignature",
  "TSClassImplements",
  "ClassDeclaration",
  "ClassBody",
  "PropertyDefinition",
  "MethodDefinition",
  "FunctionExpression",
  "TSParameterProperty",
  "TSEnumDeclaration",
  "TSEnumBody",
  "TSEnumMember",
  // A `type X = …` alias (series 093) — modeled for union RHSs (→ a union `enum`)
  // and trivial synonyms; a non-union non-trivial RHS (tuple, mapped, …) is
  // fail-loud in the `collectUnions` pre-pass, not here.
  "TSTypeAliasDeclaration",
  // The `@t2r/std` std-shim import (series 084). ONLY an
  // `import { … } from "@t2r/std"` is modeled — a `checkStdShimImport` guard
  // below rejects any other specifier (general module imports are 050, unshipped)
  // and any unknown imported name. The import lowers to nothing (recognition only).
  "ImportDeclaration",
  "ImportSpecifier",
  // Expressions
  "Identifier",
  "Literal",
  // A template literal `` `hi ${x}` `` (series 095) — lowered to a `strConcat`
  // (`format!`) with JS-faithful interpolation. `TaggedTemplateExpression` is NOT
  // listed, so a tagged template stays fail-loud.
  "TemplateLiteral",
  "TemplateElement",
  "BinaryExpression",
  "LogicalExpression",
  "UnaryExpression",
  // A ternary `cond ? a : b`. Modeled at validate; lowering implements only the
  // `flatMap` ternary-callback shape (series 092) and fails loud elsewhere.
  "ConditionalExpression",
  "AssignmentExpression",
  // `++`/`--` (series 096) — statement position → `x += 1`; value position →
  // a block-temp (postfix old / prefix new). Value position on a non-identifier
  // target is fail-loud in lowering.
  "UpdateExpression",
  "CallExpression",
  "MemberExpression",
  "ArrayExpression",
  "ObjectExpression",
  "Property",
  "ThisExpression",
  "Super",
  "NewExpression",
  "ParenthesizedExpression",
  "AwaitExpression",
  "ArrowFunctionExpression",
  "YieldExpression",
  // Non-null assertion `x!` (series 066, design D) — lowered to `.unwrap()`.
  "TSNonNullExpression",
  // Default param `(x: T = d)` (series 066) — lowered to an `Option<T>` param plus
  // an `unwrap_or(d)` body prelude.
  "AssignmentPattern",
  // Optional chaining `a?.b` (series 042d) — lowered by `lowerChain`.
  "ChainExpression",
  // Array pattern — only `for (const [k, v] of Object.entries(m))` (series 043);
  // a plain `const [a, b] = …` destructuring binding stays fail-loud in lowering.
  "ArrayPattern",
  // Object pattern — a named-struct destructuring *param* `({x, y}: Point)`
  // (series 058) and binding destructuring (series 067/097).
  "ObjectPattern",
  // Rest element in a binding destructure — array `[a, ...tail]` / object
  // `{ x, ...rest }` (series 097); the rest binding is lowered in `lowerVarDecl`.
  "RestElement",
  // Interface inheritance `interface B extends A` (series 059) — the heritage
  // clause; `lowerInterface` flattens the base's fields and synthesizes a trait.
  "TSInterfaceHeritage",
  // Spread — only object spread `{ ...a }` (series 044) is lowered; array/call
  // spread stays fail-loud in lowering.
  "SpreadElement",
  // Types
  "TSTypeAnnotation",
  "TSTypeReference",
  "TSTypeParameterInstantiation",
  // Class/method/fn type-parameter *declarations* `<T>` / `<T extends I>` (series
  // 081). The declaration + each `TSTypeParameter` are modeled; `lowerClass` /
  // the fn lowering collect the in-scope param names and resolve a bare `T` to a
  // `{kind:"param"}` `RustType`. A class/multi bound is rejected *in lowering* with
  // a precise message (so a `TSIntersectionType` constraint reaches it), not here.
  "TSTypeParameterDeclaration",
  "TSTypeParameter",
  "TSIntersectionType",
  // `T[]` / `number[]` array-type shorthand (series 081) → `Vec<T>` in `lowerType`
  // (equivalent to the `Array<T>` reference form).
  "TSArrayType",
  "TSNumberKeyword",
  "TSStringKeyword",
  "TSBooleanKeyword",
  "TSVoidKeyword",
  // A function-type annotation `(a: A, b: B) => R` → a `fn`-pointer (series 048).
  "TSFunctionType",
  // Nullability (series 042): `T | undefined` / `T | null` → `Option<T>`. The
  // union/keyword shapes are modeled; `lowerType` maps the nullable ones and
  // fails loud on a union of two real types.
  "TSUnionType",
  // A literal type `"north"` / `0` — a union member (series 093). Its inner
  // `Literal` node is already modeled.
  "TSLiteralType",
  // An inline object type `{kind:"circle",r:number}` — a discriminated-union member
  // (series 093, 1b). Modeled at the gate; `lowerType` only handles it inside a
  // union (else fail-loud). Its `TSPropertySignature` members are already modeled.
  "TSTypeLiteral",
  "TSUndefinedKeyword",
  "TSNullKeyword",
  // `any`/`unknown` are modeled-but-forbidden — see FORBIDDEN_TYPES.
  "TSAnyKeyword",
  "TSUnknownKeyword",
]);

interface AnyNode {
  type: string;
  [key: string]: unknown;
}

function isNode(x: unknown): x is AnyNode {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as AnyNode).type === "string"
  );
}

/**
 * Reject forbidden *flags* carried on otherwise-modeled nodes. These would
 * otherwise be silently dropped by lowering (the fail-loud hole this gate
 * closes). `@throws {DialectError}`.
 */
function checkForbiddenFlags(n: AnyNode): void {
  if (
    (n.type === "FunctionDeclaration" || n.type === "FunctionExpression") &&
    n.generator === true
  ) {
    // Async generators need `Stream` (out of std) → forbidden. A generator
    // *method*/expression isn't modeled. A top-level sync `function*` declaration
    // is supported for the finite-yield subset (series 025d) — its shape is
    // enforced in lowering (`UnsupportedError` for the un-handled shapes), so it
    // passes this flag gate.
    if (n.async === true) {
      throw new DialectError("async generator functions (`async function*`)");
    }
    if (n.type === "FunctionExpression") {
      throw new DialectError("generator methods / expressions (`function*`)");
    }
  }
  if (n.type === "ForOfStatement" && n.await === true) {
    throw new DialectError("`for await` async iteration");
  }
  // `await using` needs async disposal, which stable Rust's `Drop` can't express;
  // it stays forbidden. Sync `using` → `Drop` is supported (series 025).
  if (n.type === "VariableDeclaration" && n.kind === "await using") {
    throw new DialectError("`await using` (async resource disposal)");
  }
  if (Array.isArray(n.decorators) && n.decorators.length > 0) {
    throw new DialectError("decorators (`@decorator`)");
  }
  if (n.type === "ClassDeclaration" && n.abstract === true) {
    throw new DialectError("`abstract` classes");
  }
  if (n.declare === true) {
    throw new DialectError("`declare` (ambient) declarations");
  }
}

/** Depth-first walk over the whole AST, visiting every node. */
function walk(node: unknown, visit: (n: AnyNode) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const key in node) {
    if (key === "type") continue;
    walk(node[key], visit);
  }
}

/**
 * Validate that `program` is within the accepted dialect.
 * @throws {DialectError} on forbidden input (forbidden type or flag).
 * @throws {UnsupportedError} on an unmodeled node type (not implemented yet).
 */
export function validate(program: Program): void {
  walk(program, (n) => {
    // 1. Forbidden types (`any`/`unknown`) — reject wherever they appear.
    const reason = FORBIDDEN_TYPES[n.type];
    if (reason) throw new DialectError(reason);
    // 2. Forbidden flags on modeled nodes (generators, `using`, decorators, …).
    checkForbiddenFlags(n);
    // 2b. Dynamic `import()` (series 050) — an `ImportExpression` has no static
    //     Rust analog (runtime module loading); reject with a dedicated message
    //     rather than the generic default-deny below.
    if (n.type === "ImportExpression") {
      throw new UnsupportedError({
        type: "dynamic `import()` (only static `import`/`export` are modeled)",
      });
    }
    // 3. Default-deny: an unmodeled node type is not implemented yet.
    if (!MODELED.has(n.type)) throw new UnsupportedError(n);
    // 4. The only modeled import is `@t2r/std` (series 084). Any other specifier,
    //    or an unknown `@t2r/std` name, is fail-loud — general module imports
    //    (050) are unshipped.
    if (n.type === "ImportDeclaration") checkStdShimImport(n);
    // 5. Bare I/O footguns (series 100) → redirect to the `@t2r/std` surface.
    //    Runs before lowering, so `process.exit(0)` (which would otherwise lower
    //    silently) and `process.argv`/`env`/`stdin` / `fetch(...)` all fail loud
    //    with an actionable message pointing at the blessed intrinsic.
    checkIoFootgunRedirect(n);
    // 6. Stateful-RegExp footguns (series 101): `re.lastIndex` and the
    //    `while ((m = re.exec(s)))` loop are the two stateful idioms the stateless
    //    v1 model can't express — fail loud with the `matchAll` redirect. Both
    //    `.lastIndex` and `.exec` are RegExp-exclusive names, so this is sound.
    checkRegexFootgun(n);
  });
}

/**
 * Fail loud on the two stateful-RegExp idioms (series 101, sub-decision RE-STATE)
 * the stateless v1 model does not express: a `re.lastIndex` read/write, and the
 * `while ((m = re.exec(s)) !== null)` loop (detected as an `exec` call feeding an
 * assignment). Both name RegExp-exclusive members, so no other surface is caught.
 * A single, non-looped `re.exec(s)` (a declarator init / direct test) is fine.
 * `@throws {UnsupportedError}`.
 */
function checkRegexFootgun(n: AnyNode): void {
  if (n.type === "MemberExpression") {
    const m = n as { property?: AnyNode; computed?: boolean };
    if (
      !m.computed &&
      m.property?.type === "Identifier" &&
      (m.property as { name?: string }).name === "lastIndex"
    ) {
      throw new UnsupportedError({
        type: "`RegExp.lastIndex` (stateful matching) is not modeled — the regex is a stateless value in v1; use `s.matchAll(re)` for iteration",
      });
    }
  }
  // `m = re.exec(s)` (assignment RHS) — the stateful `exec`-loop idiom. A supported
  // single `exec` is a *declarator init* (`const m = re.exec(s)`), never an
  // assignment expression, so this precisely targets the loop form.
  if (n.type === "AssignmentExpression") {
    const right = (n as { right?: AnyNode }).right;
    if (right?.type === "CallExpression") {
      const callee = (right as { callee?: AnyNode }).callee;
      if (
        callee?.type === "MemberExpression" &&
        !(callee as { computed?: boolean }).computed &&
        (callee as { property?: AnyNode }).property?.type === "Identifier" &&
        ((callee as { property?: { name?: string } }).property as { name?: string })
          .name === "exec"
      ) {
        throw new UnsupportedError({
          type: "the stateful `RegExp.exec` loop is not modeled — use `s.matchAll(re)` (a single non-looped `re.exec(s)` is supported)",
        });
      }
    }
  }
}

/**
 * Redirect the bare I/O footgun globals to the `@t2r/std` surface (series 100,
 * epic #52) — the `forbid + redirect` discipline of 084/089. `fetch(...)` → the
 * `http` namespace; `process.argv`/`env`/`exit`/`stdin` → `args`/`env`/`exit`/
 * `readStdin`. (Bare `node:fs` imports are already rejected by
 * `checkStdShimImport`.) `@throws {UnsupportedError}`.
 */
function checkIoFootgunRedirect(n: AnyNode): void {
  if (n.type === "CallExpression") {
    const callee = (n as { callee?: AnyNode }).callee;
    if (
      callee &&
      callee.type === "Identifier" &&
      (callee as { name?: string }).name === "fetch"
    ) {
      throw new UnsupportedError({
        type: '`fetch` is not accepted — import `http` from "@t2r/std" and call `http.get(url)` / `http.post(url, body)` in an async function',
      });
    }
  }
  if (n.type === "MemberExpression") {
    const m = n as { object?: AnyNode; property?: AnyNode };
    if (
      m.object?.type === "Identifier" &&
      (m.object as { name?: string }).name === "process"
    ) {
      const prop =
        m.property?.type === "Identifier"
          ? (m.property as { name?: string }).name
          : undefined;
      const REDIRECTS: Record<string, string> = {
        argv: '`process.argv` is not accepted — import `args` from "@t2r/std"',
        env: '`process.env` is not accepted — import `env` from "@t2r/std"',
        exit: '`process.exit` is not accepted — import `exit` from "@t2r/std"',
        stdin:
          'reading `process.stdin` is not accepted — import `readStdin`/`readLine` from "@t2r/std"',
        stdout:
          'writing `process.stdout` is not accepted — import `stdout` from "@t2r/std"',
        stderr:
          'writing `process.stderr` is not accepted — import `stderr` from "@t2r/std"',
      };
      throw new UnsupportedError({
        type:
          (prop && REDIRECTS[prop]) ??
          '`process` is not accepted — import `args`/`env`/`exit`/`readStdin` from "@t2r/std"',
      });
    }
  }
}

/**
 * Guard the sole modeled import: `import { … } from "@t2r/std"`. Rejects a
 * bare/other specifier and an unknown imported name. `@throws {UnsupportedError}`.
 */
function checkStdShimImport(n: AnyNode): void {
  const source = (n.source as { value?: unknown } | undefined)?.value;
  if (source !== STD_SHIM_SPECIFIER) {
    throw new UnsupportedError({
      type: `import from '${String(source)}' — only "${STD_SHIM_SPECIFIER}" is a recognized module (bare/relative module imports are not yet supported)`,
    });
  }
  const specifiers = (n.specifiers as AnyNode[] | undefined) ?? [];
  for (const spec of specifiers) {
    if (spec.type !== "ImportSpecifier") {
      throw new UnsupportedError({
        type: `unsupported import form from "${STD_SHIM_SPECIFIER}" (only named imports are recognized)`,
      });
    }
    const name = (spec.imported as { name?: unknown } | undefined)?.name;
    if (typeof name !== "string" || !STD_SHIM_EXPORTS.has(name)) {
      throw new UnsupportedError({
        type: `'${String(name)}' is not exported by "${STD_SHIM_SPECIFIER}" (Tier A exports: ${[...STD_SHIM_EXPORTS].join(", ")})`,
      });
    }
  }
}
