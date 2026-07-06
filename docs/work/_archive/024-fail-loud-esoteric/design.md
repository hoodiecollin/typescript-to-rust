# 024 — Fail loud on esoteric constructs (default-deny validator)

## Problem

The dialect's core contract is **fail loud**: any input outside the accepted
subset must be *rejected*, never silently mistranslated. Today that contract has
a hole. `validate.ts` only rejects `any`/`unknown`, and lowering only fails loud
on node *types* it switches on. Several constructs carry their distinguishing
semantics in a **flag on an otherwise-modeled node**, so lowering matches the
node type, ignores the flag, and emits a plausible-but-wrong translation. Probed
(2026-07-06):

| Input | oxc shape | Emitted today | Correct? |
|---|---|---|---|
| `function* g() {…}` | `FunctionDeclaration` `generator:true` | plain `fn g()` — `*`/`yield` dropped | ❌ silent |
| `async function* g()` | `FunctionDeclaration` `generator:true async:true` | plain `async fn` | ❌ silent |
| `for await (const x of xs)` | `ForOfStatement` `await:true` | ordinary `for x in …` | ❌ silent |
| `using r = f()` | `VariableDeclaration` `kind:"using"` | plain `let r = …` — dispose dropped | ❌ silent |
| `await using r = f()` | `VariableDeclaration` `kind:"await using"` | plain `let r = …` | ❌ silent |
| `@dec class C {}` | `ClassDeclaration` `decorators:[…]` | bare struct — decorator dropped | ❌ silent |
| `class C { @dec m() {} }` | `MethodDefinition` `decorators:[…]` | bare method | ❌ silent |
| `abstract class C {}` | `ClassDeclaration` `abstract:true` | normal struct/impl | ❌ silent |
| `declare const x` | `…Declaration` `declare:true` | (varies) | ❌ silent-ish |

These are the highest-priority correctness item: a translator that *silently*
produces wrong Rust is worse than one that refuses.

Separately, a handful of **unmodeled node types** (`TSParameterProperty` from
`constructor(public x)`, `TSEnumDeclaration`, `TSModuleDeclaration`/`namespace`,
`ExportNamedDeclaration`, …) do already reach lowering's `UnsupportedError`
fallthroughs — but only because lowering happens to visit them. That is a
structural coincidence, not a guarantee: a future node type introduced in a
position lowering doesn't switch on would slip through the same way the flags do.

## Approach — a whole-tree default-deny pass in `validate.ts`

`validate` becomes the single gate on the **node-type vocabulary + forbidden
flags**, run before lowering over the entire tree (it already walks every node
for `any`/`unknown`). Two rules, checked per node:

1. **Forbidden flags → `DialectError`.** A curated set of flags-on-modeled-nodes
   that we are choosing to keep out of the dialect, each with a tailored message:
   - `FunctionDeclaration`/`FunctionExpression` with `generator === true`
   - `ForOfStatement` with `await === true`
   - `VariableDeclaration` with `kind === "using" | "await using"`
   - any node with a non-empty `decorators` array
   - `ClassDeclaration` with `abstract === true`
   - any node with `declare === true`
   Plus the existing `TSAnyKeyword`/`TSUnknownKeyword` rejections.

2. **Default-deny on node type → `UnsupportedError`.** Any node whose `type` is
   not in the `MODELED` allowlist fails loud as "not implemented yet". This is
   the structural guarantee: the vocabulary is closed, and adding a construct to
   the dialect now *requires* adding its node type to `MODELED` (a forcing
   function mirroring the emitter's exhaustiveness guard).

### Why two error kinds

The project's taxonomy (see `validate.ts` header) is deliberate:
`DialectError` = "fix your input" (forbidden), `UnsupportedError` = "not
implemented yet". A **forbidden flag** is a construct we are actively excluding —
`DialectError` is right. An **unmodeled node type** (enum, namespace, parameter
property, export) is generally *implementable* and several are already on the
backlog — calling them "forbidden … see dialect.md" would mislabel them, so the
catch-all uses `UnsupportedError`. This split also means the change cannot flip
any existing `UnsupportedError`-expecting test into `DialectError`: unmodeled
types keep their class, only the *throw site* moves earlier (into `validate`).

### `MODELED` allowlist

The union of every node type declared in `ast.ts` and every type observed across
the green fixtures (probed). Notable inclusions beyond the obvious:
`TSTypeParameterInstantiation` (the `<…>` type-args wrapper), `Super`,
`CatchClause`, `SwitchCase`, `Property`, `VariableDeclarator`, `ClassBody`,
`TSInterfaceBody`, `TSPropertySignature`, `FunctionExpression`,
`PropertyDefinition`, `MethodDefinition`, and the `TS*Keyword` primitives.
Deliberately **excluded** (so they fail loud): `ExportNamedDeclaration`
(09_modules is backlogged), `TSEnumDeclaration`, `TSModuleDeclaration`,
`TSParameterProperty`, `TemplateLiteral`, `UnaryExpression`, `LogicalExpression`,
`UpdateExpression`, `ConditionalExpression`, and every other type lowering does
not yet model.

### Supporting refactor — `src/errors.ts`

`DialectError` lives in `validate.ts`; `UnsupportedError` lives in `lower.ts`,
which imports `validate`. For `validate` to throw `UnsupportedError` we would
create a cycle. Extract both classes into a dependency-free `src/errors.ts`;
`validate.ts` and `lower.ts` import from it. `lower.ts` re-exports both so every
existing import path (`from "./lower"`, `from "../src/lower"`, and emitter's
re-export) keeps working unchanged. Pure move — no behavior change.

## Non-goals

- **Supporting** any of these constructs. That is series 025 (esoteric-feature
  support: `using`→`Drop`, generators→`Iterator`, …). This slice only makes them
  fail loud.
- Reclassifying existing lowering `UnsupportedError` sites. They stay where they
  are; `validate` is an additional, earlier gate, not a replacement.

## Risks

- **Over-denial regressing a green fixture.** Mitigated by building `MODELED`
  from the probed fixture set and running the full suite before archiving.
- **Flag false-positives.** `decorators: []` appears on many nodes; the check is
  `.length > 0`. `generator`/`await`/`abstract`/`declare` are `false` on normal
  nodes. Verified against fixtures (no flags present).
