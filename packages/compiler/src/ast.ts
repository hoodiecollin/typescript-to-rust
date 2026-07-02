/**
 * A typed subset of the ESTree AST that `oxc-parser`'s JS API actually emits.
 *
 * IMPORTANT: `oxc-parser` bundles `@oxc-project/types`, but those describe the
 * Rust-native oxc AST (`NumericLiteral`, `StringLiteral`, …). The JavaScript
 * `parseSync` API instead returns an **ESTree** tree (`Literal`, ESTree
 * `MemberExpression`, `CallExpression.arguments`, …). Typing against the bundled
 * types would lie about the runtime shape, so we declare the nodes we consume
 * here, verified against real parser output. Extend this as the dialect grows.
 */

export interface Span {
  start: number;
  end: number;
}

// ── Type annotations ────────────────────────────────────────────────────────

export interface TSTypeAnnotation extends Span {
  type: "TSTypeAnnotation";
  typeAnnotation: TSType;
}

export interface TSTypeReference extends Span {
  type: "TSTypeReference";
  typeName: Identifier;
  typeArguments?: { params: TSType[] } | null;
}

export type TSType =
  | ({ type: "TSNumberKeyword" } & Span)
  | ({ type: "TSStringKeyword" } & Span)
  | ({ type: "TSBooleanKeyword" } & Span)
  | ({ type: "TSVoidKeyword" } & Span)
  | ({ type: "TSAnyKeyword" } & Span)
  | ({ type: "TSUnknownKeyword" } & Span)
  | TSTypeReference
  | ({ type: string } & Span);

// ── Expressions ─────────────────────────────────────────────────────────────

export interface Identifier extends Span {
  type: "Identifier";
  name: string;
  typeAnnotation?: TSTypeAnnotation | null;
}

export interface Literal extends Span {
  type: "Literal";
  value: string | number | boolean | null;
  raw: string;
}

export interface BinaryExpression extends Span {
  type: "BinaryExpression";
  operator: string;
  left: Expression;
  right: Expression;
}

export interface AssignmentExpression extends Span {
  type: "AssignmentExpression";
  operator: string;
  left: Expression;
  right: Expression;
}

export interface CallExpression extends Span {
  type: "CallExpression";
  callee: Expression;
  arguments: Expression[];
}

export interface MemberExpression extends Span {
  type: "MemberExpression";
  object: Expression;
  property: Expression;
  computed: boolean;
}

export interface ArrayExpression extends Span {
  type: "ArrayExpression";
  elements: Expression[];
}

export type Expression =
  | Identifier
  | Literal
  | BinaryExpression
  | AssignmentExpression
  | CallExpression
  | MemberExpression
  | ArrayExpression
  | ({ type: string } & Span);

// ── Statements ──────────────────────────────────────────────────────────────

export interface VariableDeclarator extends Span {
  type: "VariableDeclarator";
  id: Identifier;
  init: Expression | null;
}

export interface VariableDeclaration extends Span {
  type: "VariableDeclaration";
  kind: "const" | "let" | "var";
  declarations: VariableDeclarator[];
}

export interface FunctionDeclaration extends Span {
  type: "FunctionDeclaration";
  id: Identifier | null;
  async: boolean;
  params: Identifier[];
  returnType?: TSTypeAnnotation | null;
  body: BlockStatement | null;
}

export interface BlockStatement extends Span {
  type: "BlockStatement";
  body: Statement[];
}

export interface ReturnStatement extends Span {
  type: "ReturnStatement";
  argument: Expression | null;
}

export interface ExpressionStatement extends Span {
  type: "ExpressionStatement";
  expression: Expression;
}

export type Statement =
  | VariableDeclaration
  | FunctionDeclaration
  | BlockStatement
  | ReturnStatement
  | ExpressionStatement
  | ({ type: string } & Span);

export interface Program extends Span {
  type: "Program";
  body: Statement[];
}
