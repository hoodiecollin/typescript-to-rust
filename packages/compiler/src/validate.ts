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
  // The `@t2r/std` std-shim import (series 084). ONLY an
  // `import { … } from "@t2r/std"` is modeled — a `checkStdShimImport` guard
  // below rejects any other specifier (general module imports are 050, unshipped)
  // and any unknown imported name. The import lowers to nothing (recognition only).
  "ImportDeclaration",
  "ImportSpecifier",
  // Expressions
  "Identifier",
  "Literal",
  "BinaryExpression",
  "LogicalExpression",
  "UnaryExpression",
  "AssignmentExpression",
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
  // Object pattern — only a named-struct destructuring *param* `({x, y}: Point)`
  // (series 058); a plain `const { x } = obj` binding stays fail-loud in lowering.
  "ObjectPattern",
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
    // 3. Default-deny: an unmodeled node type is not implemented yet.
    if (!MODELED.has(n.type)) throw new UnsupportedError(n);
    // 4. The only modeled import is `@t2r/std` (series 084). Any other specifier,
    //    or an unknown `@t2r/std` name, is fail-loud — general module imports
    //    (050) are unshipped.
    if (n.type === "ImportDeclaration") checkStdShimImport(n);
  });
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
