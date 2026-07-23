/**
 * Type lowering (`lowerType`) and the type-adjacent lowerers that hang off it:
 * the Map/Set key-policy helpers (061/074 Hash+Eq + SameValueZero key newtypes),
 * `++`/`--` update lowering, template-literal lowering (095), the untyped-ternary
 * `lowerCond` (094), and the discriminated-switch scrutinee/field-read recognizers.
 *
 * Extracted from the `lower.ts` monolith (series 109, Phase 1) verbatim — no logic
 * change; the byte-identical corpus gate proves it. `lowerType` is the type hub
 * (imported by 8 siblings); shared expression lowerers it leans on (`lowerExpr`,
 * `optionExprType`, `receiverTypeOf`, `truthyCond`, `structKeyName`,
 * `retargetStructKey`) are sourced from `./index`, which re-exports them.
 */

import type { ModuleAnalysis } from "../analysis";
import type {
  Expression,
  Identifier,
  MemberExpression,
  TSType,
} from "../ast";
import { UnsupportedError } from "../errors";
import type {
  HirExpr,
  HirFn,
  HirItem,
  HirStructKey,
  HirUnionEnum,
  RustType,
} from "../hir";
import { EMPTY_TYPE_PARAMS, UNIT } from "./constants";
import {
  lowerExpr,
  retargetStructKey,
  structKeyName,
  truthyCond,
} from "./index";
import {
  coerceScalarToUnion,
  inferScalarInner,
  newtypeInnerMatches,
  synthPrimUnionForArms,
} from "./unions";
import {
  anonDiscUnionName,
  anonNamedUnionName,
  anonNonDiscUnionName,
  anonPrimUnionName,
  anonUnionName,
  classifyDiscriminatedUnion,
  classifyLiteralUnion,
  classifyNonDiscriminatedUnion,
  classifyPrimitiveUnion,
  namedRef,
} from "../unions";
import { addSeen } from "./utils";


/**
 * Lower a `Map` key / `Set` element type per the 061 key policy. `string` →
 * `String`; a scalar `number` → `OrderedFloat<f64>` (faithful to JS
 * SameValueZero); a named struct → its `struct` type (its `Hash+Eq` eligibility
 * — no `f64` field — is enforced later in `collectHashEqStructs`); `boolean` →
 * `bool`. Anything else is fail-loud (unhashable key).
 */
export function lowerMapKeyType(
  ty: TSType,
  structs: Set<string>,
  typeParams: Set<string> = EMPTY_TYPE_PARAMS,
): RustType {
  switch (ty.type) {
    case "TSStringKeyword":
      return { kind: "String" };
    case "TSNumberKeyword":
      return { kind: "orderedFloat" };
    case "TSBooleanKeyword":
      return { kind: "bool" };
    default: {
      const lowered = lowerType(ty, structs, typeParams);
      if (lowered.kind === "struct") return lowered;
      throw new UnsupportedError({
        type: "Map/Set key type that is not string, number, boolean, or a struct",
      });
    }
  }
}

/**
 * Is a field type a **direct scalar `f64`** on the key struct (series 074)? Only a
 * bare `f64` — the newtype's custom impls wrap it in a single `OrderedFloat(...)`
 * at hash/eq time. An `f64` inside a `Vec`/`Option`/`set`/sub-struct is NOT a plain
 * scalar leaf: it needs an element-wise wrap this first slice does not emit, so
 * `hasBuriedF64` catches it and the key struct stays **fail-loud** (follow-up).
 */
function isDirectF64Leaf(ty: RustType): boolean {
  return ty.kind === "f64";
}

/**
 * Does a field type hide an `f64` anywhere *except* as a direct scalar field
 * (series 074)? An `f64` inside a `Vec`/`Option`/`set` (needs an element-wise
 * OrderedFloat wrap) or buried in a *sub-struct* (the parent newtype can't reach it
 * through the sub-struct's own `===`-faithful `PartialEq`). A key struct with one
 * stays **fail-loud** in this first slice (recurse in a follow-up).
 */
function hasBuriedF64(
  ty: RustType,
  structFields: Map<string, { name: string; ty: RustType }[]>,
  seen: Set<string> = new Set(),
): boolean {
  switch (ty.kind) {
    case "f64":
      // An `f64` reached *through* a collection/sub-struct — not a direct scalar.
      return seen.size > 0;
    case "vec":
      return hasBuriedF64(ty.elem, structFields, addSeen(seen, "vec"));
    case "option":
      return hasBuriedF64(ty.inner, structFields, addSeen(seen, "option"));
    case "set":
      return hasBuriedF64(ty.elem, structFields, addSeen(seen, "set"));
    case "struct": {
      if (seen.has(ty.name)) return false;
      const fields = structFields.get(ty.name);
      if (!fields) return false;
      const next = new Set(seen).add(ty.name);
      return fields.some((f) => hasBuriedF64(f.ty, structFields, next));
    }
    default:
      return false;
  }
}

/**
 * Synthesize the SameValueZero key newtype item `<Struct>Key(<Struct>)` for an
 * f64-bearing key struct (series 074). Records each wrapped field's `f64`-leaf
 * flag so the emitter wraps `f64` leaves in `OrderedFloat` at hash/eq time and
 * compares/hashes the rest with plain `==`/`.hash()`.
 */
export function synthesizeStructKey(
  struct: string,
  structFields: Map<string, { name: string; ty: RustType }[]>,
): HirStructKey {
  const fields = (structFields.get(struct) ?? []).map((f) => ({
    name: f.name,
    f64: isDirectF64Leaf(f.ty),
  }));
  return { kind: "structKey", name: structKeyName(struct), struct, fields };
}

/**
 * Retarget every `Map`/`Set` key/element type carried on an item (series 074) —
 * struct/class field types and fn param/return types — to the `structKey`
 * newtype when the key struct is f64-bearing.
 */
export function retargetItemTypes(item: HirItem, structKeys: Set<string>): void {
  const fn = (f: HirFn): void => {
    for (const p of f.params) retargetStructKey(p.ty, structKeys);
    retargetStructKey(f.ret, structKeys);
  };
  switch (item.kind) {
    case "struct":
    case "class":
      for (const field of item.fields) retargetStructKey(field.ty, structKeys);
      if (item.kind === "class") {
        if (item.ctor) fn(item.ctor);
        for (const m of item.methods) fn(m);
        for (const s of item.statics ?? []) fn(s);
      }
      return;
    case "fn":
      fn(item);
      return;
    case "trait":
      for (const m of item.methods) fn(m);
      return;
    default:
      return;
  }
}

/**
 * Is a type `Hash + Eq` eligible (a valid `Map` key / `Set` element)? Scalars
 * except `f64` are; `OrderedFloat` is; a struct is iff every field is (recursed).
 * An `f64` (a raw number field) is **not** — a struct with one is fail-loud.
 */
function isTypeHashEq(
  ty: RustType,
  structFields: Map<string, { name: string; ty: RustType }[]>,
  seen: Set<string> = new Set(),
): boolean {
  switch (ty.kind) {
    case "String":
    case "str":
    case "bool":
    case "i64":
    case "usize":
    case "orderedFloat":
      return true;
    case "vec":
      return isTypeHashEq(ty.elem, structFields, seen);
    case "option":
      return isTypeHashEq(ty.inner, structFields, seen);
    case "struct": {
      if (seen.has(ty.name)) return true;
      const fields = structFields.get(ty.name);
      if (!fields) return false;
      const next = new Set(seen).add(ty.name);
      return fields.every((f) => isTypeHashEq(f.ty, structFields, next));
    }
    default:
      return false; // f64, fnPtr, … are not Hash+Eq
  }
}

/**
 * Scan the resolved `bindingTypes` for struct `Map` keys / `Set` elements and
 * classify each (series 061 + 074), populating `analysis.hashEqStructs` and
 * `analysis.structKeyStructs`:
 *
 *  - **no `f64` anywhere** (`isTypeHashEq`) → the 061 path: derive
 *    `Hash, PartialEq, Eq` on the struct, key type = the struct itself.
 *  - **a *direct scalar* `f64` field** (`isDirectF64Leaf`, no `f64` buried in a
 *    collection or sub-struct) → the 074 path: a synthesized SameValueZero key
 *    newtype `<name>Key(<name>)`, key type = the newtype.
 *  - **an `f64` inside a `Vec`/`Option`/`set` or a sub-struct field**
 *    (`hasBuriedF64`) → **fail-loud** (needs an element-wise / nested wrap this
 *    slice doesn't emit; a follow-up recurses).
 */
export function collectHashEqStructs(analysis: ModuleAnalysis): {
  hashEq: Set<string>;
  structKey: Set<string>;
} {
  const hashEq = new Set<string>();
  const structKey = new Set<string>();
  const consider = (ty: RustType): void => {
    if (ty.kind !== "struct") return;
    if (isTypeHashEq(ty, analysis.structFields)) {
      hashEq.add(ty.name);
      return;
    }
    const fields = analysis.structFields.get(ty.name) ?? [];
    // An `f64` buried in a `Vec`/`Option`/`set` or a sub-struct field is out of
    // this first slice's reach (needs an element-wise / nested wrap) — fail-loud.
    if (fields.some((f) => hasBuriedF64(f.ty, analysis.structFields))) {
      throw new UnsupportedError({
        type: `struct '${ty.name}' used as a Map key / Set element has an f64 nested inside a collection or sub-struct field — fail-loud (follow-up)`,
      });
    }
    // A direct scalar `f64` field → the 074 SameValueZero key newtype.
    if (fields.some((f) => isDirectF64Leaf(f.ty))) {
      structKey.add(ty.name);
      return;
    }
    // No `f64` reachable, yet not `Hash+Eq` eligible (an `fnPtr` field, …) — the
    // 061 non-hashable-key rejection stands.
    throw new UnsupportedError({
      type: `struct '${ty.name}' used as a Map key / Set element has a non-Hash+Eq field`,
    });
  };
  for (const ty of analysis.bindingTypes.values()) {
    if (ty.kind === "hashmap") consider(ty.key);
    if (ty.kind === "set") consider(ty.elem);
  }
  return { hashEq, structKey };
}

/**
 * Lower a ternary in an *untyped* value position (series 094). Homogeneous arms (or
 * arms the light typer can't resolve) become a bare `if`/`else` expression — rustc
 * enforces arm-type unity. **Heterogeneous** arms auto-synthesize an anonymous
 * primitive union (the chosen policy) and wrap each arm into its variant; a
 * non-primitive arm with no type context is fail-loud (annotate a declared union).
 */
export function lowerCond(
  c: { test: Expression; consequent: Expression; alternate: Expression },
  analysis: ModuleAnalysis,
): HirExpr {
  const test = truthyCond(c.test, analysis);
  const ta = inferScalarInner(c.consequent, analysis);
  const tb = inferScalarInner(c.alternate, analysis);
  if (ta && tb && !newtypeInnerMatches(ta, tb)) {
    const info = synthPrimUnionForArms(ta, tb, analysis);
    if (info) {
      const conseq = coerceScalarToUnion(c.consequent, info, analysis);
      const alt = coerceScalarToUnion(c.alternate, info, analysis);
      if (conseq && alt) return { kind: "cond", test, conseq, alt };
    }
    throw new UnsupportedError({
      type: "heterogeneous ternary in an untyped value position with a non-primitive arm — annotate the target with a declared union type (`const x: A | B = …`)",
    });
  }
  return {
    kind: "cond",
    test,
    conseq: lowerExpr(c.consequent, analysis),
    alt: lowerExpr(c.alternate, analysis),
  };
}

/**
 * A discriminated-union `switch (obj.kind)` scrutinee (series 093, 1b): returns the
 * object binding name + its union enum when the discriminant is `<id>.<discField>`
 * over a discriminated-union binding, else null.
 */
export function discriminatedScrutinee(
  disc: Expression,
  analysis: ModuleAnalysis,
): { objName: string; info: HirUnionEnum } | null {
  if (disc.type !== "MemberExpression") return null;
  const m = disc as MemberExpression;
  if (m.computed || m.object.type !== "Identifier" || m.property.type !== "Identifier") {
    return null;
  }
  const objName = (m.object as Identifier).name;
  const t = analysis.bindingTypes.get(objName);
  if (t?.kind !== "struct") return null;
  const info = analysis.unionEnums.get(t.name);
  if (!info || info.discField !== (m.property as Identifier).name) return null;
  return { objName, info };
}

/** Does the AST subtree read `<objName>.<anything>` (any non-computed member access)? */
export function readsAnyMemberField(node: unknown, objName: string): boolean {
  if (Array.isArray(node)) {
    return node.some((n) => readsAnyMemberField(n, objName));
  }
  if (!node || typeof node !== "object") return false;
  const n = node as {
    type?: string;
    computed?: boolean;
    object?: { type?: string; name?: string };
    property?: { type?: string };
  };
  if (
    n.type === "MemberExpression" &&
    !n.computed &&
    n.object?.type === "Identifier" &&
    n.object.name === objName &&
    n.property?.type === "Identifier"
  ) {
    return true;
  }
  for (const k in node as Record<string, unknown>) {
    if (k === "type") continue;
    if (readsAnyMemberField((node as Record<string, unknown>)[k], objName)) {
      return true;
    }
  }
  return false;
}

/** Does the AST subtree read `<objName>.<field>` (a non-computed member access)? */
export function readsMemberField(
  node: unknown,
  objName: string,
  field: string,
): boolean {
  if (Array.isArray(node)) {
    return node.some((n) => readsMemberField(n, objName, field));
  }
  if (!node || typeof node !== "object") return false;
  const n = node as {
    type?: string;
    computed?: boolean;
    object?: { type?: string; name?: string };
    property?: { type?: string; name?: string };
  };
  if (
    n.type === "MemberExpression" &&
    !n.computed &&
    n.object?.type === "Identifier" &&
    n.object.name === objName &&
    n.property?.type === "Identifier" &&
    n.property.name === field
  ) {
    return true;
  }
  for (const k in node as Record<string, unknown>) {
    if (k === "type") continue;
    if (readsMemberField((node as Record<string, unknown>)[k], objName, field)) {
      return true;
    }
  }
  return false;
}

export function lowerType(
  ty: TSType,
  structs: Set<string>,
  // In-scope generic type-param names (series 081). A bare `TSTypeReference` whose
  // name is here resolves to a `{kind:"param"}` `RustType` (a type variable),
  // instead of failing loud as an undeclared struct. Threaded through recursion so
  // a nested `Vec<T>` / `Option<T>` resolves its inner `T` too. Empty by default
  // (a non-generic scope); the class/method path passes `analysis.typeParams`.
  typeParams: Set<string> = EMPTY_TYPE_PARAMS,
): RustType {
  switch (ty.type) {
    case "TSNumberKeyword":
      return { kind: "f64" };
    case "TSStringKeyword":
      return { kind: "String" };
    case "TSBooleanKeyword":
      return { kind: "bool" };
    case "TSVoidKeyword":
      return UNIT;
    case "TSArrayType": {
      // `T[]` / `number[]` shorthand → `Vec<T>` (series 081; equivalent to the
      // `Array<T>` reference form). The element resolves through the same
      // `typeParams` scope, so `U[]` in a generic method is `Vec<U>`.
      const elem = (ty as unknown as { elementType: TSType }).elementType;
      return { kind: "vec", elem: lowerType(elem, structs, typeParams) };
    }
    case "TSTypeReference": {
      const ref = ty as Extract<TSType, { type: "TSTypeReference" }>;
      // A bare `T` in scope of a generic class/method (series 081) → a type
      // variable. Checked *before* the built-in wrappers so a param named `Array`
      // etc. can't collide (a valid TS program never shadows those, but the scope
      // check is authoritative here). A param never carries type arguments.
      if (typeParams.has(ref.typeName.name) && !ref.typeArguments) {
        return { kind: "param", name: ref.typeName.name };
      }
      if (ref.typeName.name === "Promise") {
        // An `async fn`'s Rust return type is its resolved `T`, not a wrapper —
        // Rust wraps in `Future` implicitly. `Promise<void>` → `()`. In-dialect
        // `Promise` only ever annotates an `async` return (see design 014).
        const inner = ref.typeArguments?.params?.[0];
        if (!inner) throw new UnsupportedError(ty);
        return lowerType(inner, structs, typeParams);
      }
      if (ref.typeName.name === "Array") {
        const inner = ref.typeArguments?.params?.[0];
        if (!inner) throw new UnsupportedError(ty);
        return { kind: "vec", elem: lowerType(inner, structs, typeParams) };
      }
      if (ref.typeName.name === "Record") {
        // `Record<string, V>` → `HashMap<String, V>`. Only a `string` key maps
        // soundly: `f64` (a `number` key) is neither `Eq` nor `Hash` in Rust.
        const [key, value] = ref.typeArguments?.params ?? [];
        if (!key || !value) throw new UnsupportedError(ty);
        if (key.type !== "TSStringKeyword") {
          throw new UnsupportedError({
            type: "Record with a non-string key (only string keys map to HashMap)",
          });
        }
        return {
          kind: "hashmap",
          key: { kind: "String" },
          value: lowerType(value, structs, typeParams),
        };
      }
      if (ref.typeName.name === "Map") {
        // `Map<K, V>` → `IndexMap<K, V>` (series 061). The key type follows the
        // `Hash + Eq` key policy (`lowerMapKeyType`): `String`, gated struct, or
        // `OrderedFloat<f64>` for a scalar number.
        const [key, value] = ref.typeArguments?.params ?? [];
        if (!key || !value) throw new UnsupportedError(ty);
        return {
          kind: "hashmap",
          key: lowerMapKeyType(key, structs, typeParams),
          value: lowerType(value, structs, typeParams),
        };
      }
      if (ref.typeName.name === "Set") {
        // `Set<T>` → `IndexSet<T>` (series 061); element follows the key policy.
        const elem = ref.typeArguments?.params?.[0];
        if (!elem) throw new UnsupportedError(ty);
        return { kind: "set", elem: lowerMapKeyType(elem, structs, typeParams) };
      }
      // A reference to a declared `interface`/`class` → its nominal `struct` type.
      // A **generic instantiation** `Box<number>` (series 081) carries type
      // arguments → `{kind:"struct", name, args}` (emitted `Box<f64>`), so an
      // annotation `const b: Box<number> = …` matches the inferred ctor return. An
      // unknown type name stays fail-loud (`Promise`, `Map`, … are unsupported).
      if (structs.has(ref.typeName.name)) {
        const targs = ref.typeArguments?.params;
        if (targs && targs.length > 0) {
          return {
            kind: "struct",
            name: ref.typeName.name,
            args: targs.map((a) => lowerType(a, structs, typeParams)),
          };
        }
        return { kind: "struct", name: ref.typeName.name };
      }
      throw new UnsupportedError(ty);
    }
    case "TSFunctionType": {
      // A function-type annotation `(a: A, b: B) => R` → a bare `fn`-pointer
      // `fn(A, B) -> R` (series 048). oxc's TSFunctionType carries `params`
      // (each an `Identifier` with its own `typeAnnotation`) and a `returnType`
      // wrapped in a `TSTypeAnnotation`.
      const f = ty as unknown as {
        params: { typeAnnotation?: { typeAnnotation: TSType } | null }[];
        returnType?: { typeAnnotation: TSType } | null;
      };
      const params = f.params.map((p) => {
        const inner = p.typeAnnotation?.typeAnnotation;
        if (!inner) throw new UnsupportedError(ty);
        return lowerType(inner, structs, typeParams);
      });
      const ret = f.returnType
        ? lowerType(f.returnType.typeAnnotation, structs, typeParams)
        : UNIT;
      return { kind: "fnPtr", params, ret };
    }
    case "TSNullKeyword":
    case "TSUndefinedKeyword":
      // A bare `null`/`undefined` type (not in a `T | null` union) has no `T` to
      // make `Option` over — fail-loud (series 042).
      throw new UnsupportedError(ty);
    case "TSLiteralType": {
      // A singleton literal *type* used as a field annotation — `kind: "circle"` on
      // a discriminated-union member interface (series 093, 1d). We don't track
      // singleton types at the value level, so it widens to its base primitive (the
      // field holds that exact value at runtime; the union's variant already pins it).
      const lit = (ty as unknown as { literal?: { value?: unknown } }).literal;
      const v = lit?.value;
      if (typeof v === "string") return { kind: "String" };
      if (typeof v === "number") return { kind: "f64" };
      if (typeof v === "boolean") return { kind: "bool" };
      throw new UnsupportedError(ty);
    }
    case "TSUnionType": {
      // `T | undefined` / `T | null` / `T | null | undefined` → `Option<T>`
      // (series 042). A union of two *real* types is enum territory — fail-loud.
      const u = ty as unknown as { types: TSType[] };
      const real = u.types.filter(
        (m) => m.type !== "TSUndefinedKeyword" && m.type !== "TSNullKeyword",
      );
      const hasNullish = real.length !== u.types.length;
      // A literal union `"n" | "s"` / `0 | 1` → a nominal union `enum` (series 093),
      // referenced as `{kind:"struct", name}`. The name matches `collectUnions`'
      // registration (the alias name lives in `structs`/TSTypeReference; an inline
      // union computes the same `__anonymous_union_<hash>` here). A nullish member
      // wraps the enum in `Option`.
      const lits = classifyLiteralUnion(real);
      if (lits) {
        const inner: RustType = { kind: "struct", name: anonUnionName(lits) };
        return hasNullish ? { kind: "option", inner } : inner;
      }
      const dunion = classifyDiscriminatedUnion(real);
      if (dunion) {
        const inner: RustType = { kind: "struct", name: anonDiscUnionName(dunion) };
        return hasNullish ? { kind: "option", inner } : inner;
      }
      // Named-interface members (D): every member a bare `TSTypeReference`. The anon
      // name hashes the (order-independent) interface-name set, so it matches what
      // `collectUnions` registered — but only *if* it registered one (a discriminated
      // named union). `structs` carries every registered union name, so gate on that:
      // an unregistered named union (no shared discriminant) falls through to fail-loud.
      const namedNames = real.map((m) => namedRef(m));
      if (namedNames.every((n): n is string => n !== null)) {
        const nm = anonNamedUnionName(namedNames);
        if (structs.has(nm)) {
          const inner: RustType = { kind: "struct", name: nm };
          return hasNullish ? { kind: "option", inner } : inner;
        }
      }
      // Primitive / mixed union (F): `string | number`, `string | Point`. The anon
      // name hashes the primitive+named member set; gate on registration via `structs`.
      const prim = classifyPrimitiveUnion(real, (n) => structs.has(n));
      if (prim) {
        const nm = anonPrimUnionName(prim);
        if (structs.has(nm)) {
          const inner: RustType = { kind: "struct", name: nm };
          return hasNullish ? { kind: "option", inner } : inner;
        }
      }
      // Non-discriminated object union (E): `{a} | {b}`. Fully determined by the
      // type node (all inline objects, no discriminant), so no `structs` gate.
      const nondisc = classifyNonDiscriminatedUnion(real);
      if (nondisc) {
        const inner: RustType = { kind: "struct", name: anonNonDiscUnionName(nondisc) };
        return hasNullish ? { kind: "option", inner } : inner;
      }
      if (hasNullish && real.length === 1 && real[0]) {
        return { kind: "option", inner: lowerType(real[0], structs, typeParams) };
      }
      throw new UnsupportedError(ty);
    }
    default:
      throw new UnsupportedError(ty);
  }
}

