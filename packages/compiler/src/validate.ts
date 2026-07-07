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
  "ThrowStatement",
  "TryStatement",
  "CatchClause",
  "TSInterfaceDeclaration",
  "TSInterfaceBody",
  "TSPropertySignature",
  "ClassDeclaration",
  "ClassBody",
  "PropertyDefinition",
  "MethodDefinition",
  "FunctionExpression",
  "TSParameterProperty",
  "TSEnumDeclaration",
  "TSEnumBody",
  "TSEnumMember",
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
  // Types
  "TSTypeAnnotation",
  "TSTypeReference",
  "TSTypeParameterInstantiation",
  "TSNumberKeyword",
  "TSStringKeyword",
  "TSBooleanKeyword",
  "TSVoidKeyword",
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
  });
}
