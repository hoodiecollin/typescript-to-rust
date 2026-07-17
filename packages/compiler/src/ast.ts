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
  /** Present iff this is a regex literal `/pat/flags` (series 101); `value` is `{}`. */
  regex?: { pattern: string; flags: string };
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

export interface ThisExpression extends Span {
  type: "ThisExpression";
}

export interface NewExpression extends Span {
  type: "NewExpression";
  callee: Expression;
  arguments: Expression[];
}

/** `await <expr>` — suspends until the awaited future settles, yielding its value. */
export interface AwaitExpression extends Span {
  type: "AwaitExpression";
  argument: Expression;
}

/**
 * `(params) => body` — an arrow function. `params` share a `FunctionDeclaration`'s
 * shape (typed `Identifier`s); `body` is a `BlockStatement` (`=> { … }`) or an
 * `Expression` (`=> expr`, with `expression: true`). A top-level `const`-bound
 * non-`async` arrow normalizes to a free `fn` (see lower.ts).
 */
export interface ArrowFunctionExpression extends Span {
  type: "ArrowFunctionExpression";
  async: boolean;
  params: Identifier[];
  returnType?: TSTypeAnnotation | null;
  body: BlockStatement | Expression;
  expression: boolean;
}

/** One `key: value` pair of an object literal. `kind` is `"init"` in the dialect. */
export interface Property extends Span {
  type: "Property";
  key: Expression;
  value: Expression;
  computed: boolean;
  shorthand: boolean;
  kind: string;
}

export interface ObjectExpression extends Span {
  type: "ObjectExpression";
  properties: Property[];
}

/** A `{ x, y }` destructuring pattern — a destructuring *param* (series 058). */
export interface ObjectPattern extends Span {
  type: "ObjectPattern";
  properties: Property[];
  typeAnnotation?: TSTypeAnnotation | null;
}

export type Expression =
  | Identifier
  | Literal
  | BinaryExpression
  | AssignmentExpression
  | CallExpression
  | MemberExpression
  | ArrayExpression
  | ObjectExpression
  | ThisExpression
  | NewExpression
  | AwaitExpression
  | ArrowFunctionExpression
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

export interface IfStatement extends Span {
  type: "IfStatement";
  test: Expression;
  consequent: Statement;
  /** `else` branch: a block, another `IfStatement` (`else if`), or null. */
  alternate: Statement | null;
}

export interface WhileStatement extends Span {
  type: "WhileStatement";
  test: Expression;
  body: Statement;
}

export interface ForStatement extends Span {
  type: "ForStatement";
  /** `let i = 0` (a declaration), an expression, or absent. */
  init: VariableDeclaration | Expression | null;
  test: Expression | null;
  update: Expression | null;
  body: Statement;
}

export interface ForOfStatement extends Span {
  type: "ForOfStatement";
  /** `const val` / `let val` — a single-identifier binding in the dialect. */
  left: VariableDeclaration;
  right: Expression;
  body: Statement;
}

export interface SwitchCase extends Span {
  type: "SwitchCase";
  /** The `case` value, or `null` for `default`. */
  test: Expression | null;
  consequent: Statement[];
}

export interface SwitchStatement extends Span {
  type: "SwitchStatement";
  discriminant: Expression;
  cases: SwitchCase[];
}

/** One `name: T` member of an interface body. */
export interface TSPropertySignature extends Span {
  type: "TSPropertySignature";
  key: Identifier;
  typeAnnotation: TSTypeAnnotation | null;
  optional: boolean;
  computed: boolean;
  /** `readonly x: T` — assignment to this field is rejected (series 059). */
  readonly?: boolean;
}

export interface TSInterfaceBody extends Span {
  type: "TSInterfaceBody";
  body: TSPropertySignature[];
}

export interface TSInterfaceDeclaration extends Span {
  type: "TSInterfaceDeclaration";
  id: Identifier;
  body: TSInterfaceBody;
  /** Base interfaces (`extends A, B`) — non-empty means inheritance. */
  extends: unknown[];
}

/** A class method's function value (`constructor`/method body). */
export interface FunctionExpression extends Span {
  type: "FunctionExpression";
  async: boolean;
  params: Identifier[];
  returnType?: TSTypeAnnotation | null;
  body: BlockStatement | null;
}

/** A class field: `name: T;` (with an optional initializer we don't yet use). */
export interface PropertyDefinition extends Span {
  type: "PropertyDefinition";
  key: Identifier;
  typeAnnotation?: TSTypeAnnotation | null;
  value: Expression | null;
  computed: boolean;
  static: boolean;
  /** `field?: T` — an optional class field (`Option<T>`, series 042b/070). */
  optional?: boolean;
}

/**
 * A parameter property: `constructor(public x: T)`. TS shorthand that both
 * declares a field and assigns it from the argument. `parameter` is the wrapped
 * binding (a typed `Identifier`); `accessibility`/`readonly` don't affect the
 * Rust target (fields are plain). Desugars in lowering to a field + `this.x = x`.
 */
export interface TSParameterProperty extends Span {
  type: "TSParameterProperty";
  accessibility: "public" | "private" | "protected" | null;
  readonly: boolean;
  parameter: Identifier;
}

/** A constructor/method param: an ordinary binding or a parameter property. */
export type Param = Identifier | TSParameterProperty;

export interface MethodDefinition extends Span {
  type: "MethodDefinition";
  key: Identifier;
  value: FunctionExpression;
  kind: "constructor" | "method" | "get" | "set";
  computed: boolean;
  static: boolean;
}

export interface ClassBody extends Span {
  type: "ClassBody";
  body: (PropertyDefinition | MethodDefinition)[];
}

export interface ClassDeclaration extends Span {
  type: "ClassDeclaration";
  id: Identifier | null;
  superClass: Expression | null;
  implements: unknown[];
  body: ClassBody;
}

/** `throw <argument>;` — in the dialect, `argument` is `new Error(<message>)`. */
export interface ThrowStatement extends Span {
  type: "ThrowStatement";
  argument: Expression;
}

/** `catch (param) { body }` — `param` is `null` for a binding-less `catch { … }`. */
export interface CatchClause extends Span {
  type: "CatchClause";
  param: Identifier | null;
  body: BlockStatement;
}

/**
 * `try { block } [catch (…) { … }] [finally { … }]`. In the dialect a `catch`
 * handler is required (a `try`/`finally`-only form is rejected in lowering).
 */
export interface TryStatement extends Span {
  type: "TryStatement";
  block: BlockStatement;
  handler: CatchClause | null;
  finalizer: BlockStatement | null;
}

export interface BreakStatement extends Span {
  type: "BreakStatement";
  label: Identifier | null;
}

export interface ContinueStatement extends Span {
  type: "ContinueStatement";
  label: Identifier | null;
}

/** `label: <loop>` — a labeled loop statement (series 064). */
export interface LabeledStatement extends Span {
  type: "LabeledStatement";
  label: Identifier;
  body: Statement;
}

/** One `Name` or `Name = <init>` member of an `enum` body. */
export interface TSEnumMember extends Span {
  type: "TSEnumMember";
  id: Identifier;
  initializer: Expression | null;
  computed: boolean;
}

export interface TSEnumBody extends Span {
  type: "TSEnumBody";
  members: TSEnumMember[];
}

/** `enum E { A, B = 1 }` — a C-like enum (`const`/`declare` rejected in lowering). */
export interface TSEnumDeclaration extends Span {
  type: "TSEnumDeclaration";
  id: Identifier;
  body: TSEnumBody;
  const: boolean;
  declare: boolean;
}

export type Statement =
  | VariableDeclaration
  | FunctionDeclaration
  | BlockStatement
  | ReturnStatement
  | ExpressionStatement
  | IfStatement
  | WhileStatement
  | ForStatement
  | ForOfStatement
  | SwitchStatement
  | BreakStatement
  | ContinueStatement
  | LabeledStatement
  | ThrowStatement
  | TryStatement
  | TSInterfaceDeclaration
  | TSEnumDeclaration
  | ClassDeclaration
  | ({ type: string } & Span);

export interface Program extends Span {
  type: "Program";
  body: Statement[];
}

/**
 * `import { a, b as c } from "src"`. Series 084 recognized only `@t2r/std`; the
 * module system (series 050) adds `./`-relative imports across files. `specifiers`
 * may carry a default (`import d from …`) or namespace (`import * as ns …`) form.
 * Both are **supported** (series 050d): a namespace import maps to a Rust module
 * alias (`use crate::n as ns;`, `ns.x` → `n::x`), and a default import binds the
 * target module's reserved `__default_export` symbol via `as`.
 */
export interface ImportDeclaration extends Span {
  type: "ImportDeclaration";
  source: { type: "Literal"; value: string };
  specifiers: (
    | ImportSpecifier
    | ImportDefaultSpecifier
    | ImportNamespaceSpecifier
  )[];
}

/** One `{ imported as local }` clause of an `ImportDeclaration`. */
export interface ImportSpecifier extends Span {
  type: "ImportSpecifier";
  imported: Identifier;
  local: Identifier;
}

/** `import def from "./d"` — a default import; binds the module's reserved
 * `__default_export` symbol (`use crate::d::__default_export as def;`, series 050d). */
export interface ImportDefaultSpecifier extends Span {
  type: "ImportDefaultSpecifier";
  local: Identifier;
}

/** `import * as ns from "./n"` — a namespace import; a Rust module alias
 * (`use crate::n as ns;`, member access `ns.x` → `n::x`, series 050d). */
export interface ImportNamespaceSpecifier extends Span {
  type: "ImportNamespaceSpecifier";
  local: Identifier;
}

/**
 * `export <decl>` / `export { a, b as c }` / `export { x as y } from "./z"`
 * (series 050). `declaration` is set for `export function`/`class`/`interface`/
 * `enum`; else `specifiers` lists the exported names. A non-null `source` marks a
 * **re-export** (accepted only inside a pure barrel). `exportKind` is `"type"` for
 * a type-only export.
 */
export interface ExportNamedDeclaration extends Span {
  type: "ExportNamedDeclaration";
  declaration: Statement | null;
  specifiers: ExportSpecifier[];
  source: { type: "Literal"; value: string } | null;
  exportKind: "value" | "type";
}

/** One `{ local as exported }` clause of an `ExportNamedDeclaration`. */
export interface ExportSpecifier extends Span {
  type: "ExportSpecifier";
  local: Identifier;
  exported: Identifier;
  exportKind: "value" | "type";
}

/** `export default <expr|decl>` — fail-loud (no named Rust analog). */
export interface ExportDefaultDeclaration extends Span {
  type: "ExportDefaultDeclaration";
  declaration: Expression | Statement;
  exportKind: "value" | "type";
}

/** `export * from "./barrel"` — a glob re-export (facade-only; else fail-loud). */
export interface ExportAllDeclaration extends Span {
  type: "ExportAllDeclaration";
  exported: Identifier | null;
  source: { type: "Literal"; value: string };
  exportKind: "value" | "type";
}

/** A `TSModuleBlock` — the `{ … }` body of a `namespace`/`module` declaration. */
export interface TSModuleBlock extends Span {
  type: "TSModuleBlock";
  body: Statement[];
}

/**
 * `namespace Foo { … }` / `module Foo { … }` (series 050, Axis 4) → a nested Rust
 * `mod`. `kind` is `"namespace"` (or `"module"`/`"global"`); `declare`/`global`
 * ambient forms are fail-loud. A missing `body` (ambient `declare module`) is null.
 */
export interface TSModuleDeclaration extends Span {
  type: "TSModuleDeclaration";
  id: Identifier;
  body: TSModuleBlock | null;
  kind: "namespace" | "module" | "global";
  declare: boolean;
  global: boolean;
}
