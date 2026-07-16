/**
 * Union-type support (series 093) — the pure, `analysis`-free helpers for lowering
 * a TS union `A | B | …` to a Rust `enum`: member classification, deterministic
 * variant-ident sanitization, and the order-independent structural hash that names
 * an anonymous/inline union (`__anonymous_union_<hash>`) so two spellings of the
 * same union set dedup to one enum.
 *
 * Stage 1a scope: **literal** members only (string / number literal types). Object
 * / primitive / named-interface members return `null` from {@link classifyLiteralUnion}
 * and stay fail-loud in `lowerType` until a later stage.
 */

import type { TSType } from "./ast";
import type { HirUnionVariant } from "./hir";

/** FNV-1a (32-bit) → 8 lowercase hex. A pure string digest (no `Math.random`/`Date`). */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** A stage-1a union member: a string- or number-literal type. */
export interface LiteralMember {
  kind: "str" | "num";
  /** The literal value as it appears in source (drives Display + `switch` matching). */
  value: string | number;
}

/** Is `m` a `null`/`undefined` union member (stripped to `Option<T>` by the caller)? */
export function isNullishMember(m: TSType): boolean {
  return m.type === "TSUndefinedKeyword" || m.type === "TSNullKeyword";
}

/**
 * Does the union mix literal member(s) with object/named member(s)? The **G** shape
 * (`"loading" | { kind: "done" }`) — its narrowing is irregular (equality for the
 * literal part, `.kind`/`typeof` for the object part), a documented residual
 * (design §9) that fails loud with a precise message rather than a fragile partial.
 */
export function isMixedLiteralObjectUnion(members: TSType[]): boolean {
  let hasLit = false;
  let hasObj = false;
  for (const m of members) {
    if (m.type === "TSLiteralType") hasLit = true;
    else if (m.type === "TSTypeLiteral" || m.type === "TSTypeReference") {
      hasObj = true;
    }
  }
  return hasLit && hasObj;
}

/**
 * A discriminated **object** union (series 093, stage 1b): every member is an
 * inline object type `{kind:"circle", r:number}` sharing a common literal-typed
 * discriminant field. Maps to a struct-variant `enum` (`Circle { r: f64 }`).
 */
export interface DiscObjectMember {
  /** The discriminant literal value (drives the variant name + construction/match). */
  discValue: string;
  /** The member's non-discriminant fields (name + annotation, lowered by the caller). */
  fields: { name: string; ann: TSType }[];
}
export interface DiscriminatedUnion {
  discField: string;
  members: DiscObjectMember[];
}

/** Discriminant-field name precedence when a union has more than one candidate. */
const DISC_PREFERENCE = ["kind", "type", "tag", "_type"];

export interface PropSig {
  name: string;
  ann: TSType;
  literal: LiteralMember | null;
}

/**
 * Convert a list of TS type-member nodes (an inline `{ … }` body or an interface
 * body) to prop signatures, or null if any member isn't a plain non-computed
 * property signature. Shared by inline object unions (C/E) and the named-interface
 * resolver (D) so both classify against the same shape.
 */
export function extractPropSignatures(members: unknown[]): PropSig[] | null {
  const props: PropSig[] = [];
  for (const p of members) {
    const ps = p as {
      type?: string;
      computed?: boolean;
      key?: { name?: string };
      typeAnnotation?: { typeAnnotation?: TSType };
    };
    if (ps.type !== "TSPropertySignature" || ps.computed) return null;
    const name = ps.key?.name;
    const ann = ps.typeAnnotation?.typeAnnotation;
    if (!name || !ann) return null;
    props.push({ name, ann, literal: literalMember(ann) });
  }
  return props.length > 0 ? props : null;
}

/** The property signatures of an inline object type `{ … }`, or null if `m` isn't one. */
function objectMemberProps(m: TSType): PropSig[] | null {
  if (m.type !== "TSTypeLiteral") return null;
  return extractPropSignatures(
    (m as unknown as { members?: unknown[] }).members ?? [],
  );
}

/** The identifier name of a bare `TSTypeReference` (`Circle`), else null. */
export function namedRef(m: TSType): string | null {
  if (m.type !== "TSTypeReference") return null;
  const tn = (m as unknown as { typeName?: { type?: string; name?: string } })
    .typeName;
  return tn?.type === "Identifier" && typeof tn.name === "string"
    ? tn.name
    : null;
}

/**
 * Find the discriminant field among a set of members' props: a field present in
 * every member whose type is a single literal, with pairwise-distinct values, then
 * the name-precedence tiebreak (`kind` > `type` > `tag` > `_type` > leftmost). Null
 * when there is no such field (non-discriminated → case E). Shared by the inline
 * (C) and named-interface (D) classifiers.
 */
function findDiscriminant(memberProps: PropSig[][]): string | null {
  if (memberProps.length < 2) return null;
  const candidates: string[] = [];
  for (const p of memberProps[0]!) {
    if (!p.literal) continue;
    const values = new Set<string>();
    let ok = true;
    for (const props of memberProps) {
      const q = props.find((x) => x.name === p.name);
      if (!q || !q.literal) {
        ok = false;
        break;
      }
      values.add(String(q.literal.value));
    }
    if (ok && values.size === memberProps.length) candidates.push(p.name);
  }
  if (candidates.length === 0) return null;
  return DISC_PREFERENCE.find((n) => candidates.includes(n)) ?? candidates[0]!;
}

/**
 * Classify a discriminated object union: every member an inline object type with a
 * common literal-typed discriminant field (distinct values across members). Returns
 * null when a member is not an inline object (named-interface / primitive → later
 * stage) or no common literal discriminant exists (non-discriminated → stage 1e).
 */
export function classifyDiscriminatedUnion(
  members: TSType[],
): DiscriminatedUnion | null {
  const memberProps: PropSig[][] = [];
  for (const m of members) {
    const props = objectMemberProps(m);
    if (!props) return null;
    memberProps.push(props);
  }
  const discField = findDiscriminant(memberProps);
  if (!discField) return null;
  const out: DiscObjectMember[] = memberProps.map((props) => {
    const disc = props.find((x) => x.name === discField)!;
    return {
      discValue: String(disc.literal!.value),
      fields: props
        .filter((x) => x.name !== discField)
        .map((x) => ({ name: x.name, ann: x.ann })),
    };
  });
  return { discField, members: out };
}

/**
 * The order-independent canonical name for an **anonymous** discriminated union —
 * hashes the discriminant field plus each variant's `discValue` + sorted field-name
 * set, so two spellings of the same union dedup to one enum.
 */
export function anonDiscUnionName(d: DiscriminatedUnion): string {
  const sigs = d.members
    .map(
      (m) =>
        `${m.discValue}:{${m.fields
          .map((f) => f.name)
          .sort()
          .join(",")}}`,
    )
    .sort();
  return `__anonymous_union_${fnv1a(`disc:${d.discField}|${sigs.join("|")}`)}`;
}

/**
 * A discriminated union whose members are **named interfaces** (series 093, stage
 * 1d, case D): `type Shape = Circle | Square`, each interface carrying a shared
 * literal discriminant. Maps to a **newtype-variant** enum `Shape::Circle(Circle)`
 * preserving the nominal inner struct.
 */
export interface NamedDiscMember {
  /** The interface name — both the variant name and the newtype's inner type. */
  interfaceName: string;
  /** The discriminant literal value (drives construction + `switch(x.kind)` match). */
  discValue: string;
}
export interface NamedDiscriminatedUnion {
  discField: string;
  members: NamedDiscMember[];
}

/**
 * Classify a named-interface discriminated union (D): every member a bare
 * `TSTypeReference` to an interface (resolved to its props via `resolve`), the set
 * sharing a common literal discriminant with distinct values. Returns null when a
 * member is not a resolvable named interface or no common discriminant exists.
 */
export function classifyNamedDiscriminatedUnion(
  members: TSType[],
  resolve: (name: string) => PropSig[] | null,
): NamedDiscriminatedUnion | null {
  const names: string[] = [];
  const memberProps: PropSig[][] = [];
  for (const m of members) {
    const name = namedRef(m);
    if (!name) return null;
    const props = resolve(name);
    if (!props) return null;
    names.push(name);
    memberProps.push(props);
  }
  const discField = findDiscriminant(memberProps);
  if (!discField) return null;
  const out: NamedDiscMember[] = memberProps.map((props, i) => {
    const disc = props.find((x) => x.name === discField)!;
    return { interfaceName: names[i]!, discValue: String(disc.literal!.value) };
  });
  return { discField, members: out };
}

/**
 * The order-independent canonical name for an **anonymous** named-interface union —
 * hashes the sorted interface-name set (`nom:Circle|nom:Square`). Computable from
 * the union type node alone (the interface names live there), so `lowerType` and
 * `collectUnions` agree on the name without resolving the interfaces.
 */
export function anonNamedUnionName(names: string[]): string {
  const sigs = names.map((n) => `nom:${n}`).sort();
  return `__anonymous_union_${fnv1a(sigs.join("|"))}`;
}

/**
 * A primitive / mixed-type union (series 093, stage 1d, case F): every member a
 * primitive keyword (`string`/`number`/`boolean`) or a single named struct, narrowed
 * at consumption by `typeof`. Maps to a **newtype-variant** enum `Str(String)`,
 * `Num(f64)`, `Bool(bool)`, `Point(Point)`.
 */
export interface PrimMember {
  tag: "str" | "num" | "bool" | "nom";
  /** The variant name (`Str`/`Num`/`Bool` for primitives; the struct name for `nom`). */
  name: string;
}
export interface PrimitiveUnion {
  members: PrimMember[];
}

/**
 * Classify a primitive/mixed union (F): members are `string`/`number`/`boolean`
 * keywords and/or a **single** named struct (so `typeof x === "object"` narrows to
 * exactly one member). Requires ≥1 primitive (an all-named union is D or fail-loud)
 * and no duplicate member type. Returns null otherwise.
 */
export function classifyPrimitiveUnion(
  members: TSType[],
  isStruct: (name: string) => boolean,
): PrimitiveUnion | null {
  const out: PrimMember[] = [];
  const seen = new Set<string>();
  let hasPrim = false;
  let nomCount = 0;
  for (const m of members) {
    let pm: PrimMember | null = null;
    if (m.type === "TSStringKeyword") pm = { tag: "str", name: "Str" };
    else if (m.type === "TSNumberKeyword") pm = { tag: "num", name: "Num" };
    else if (m.type === "TSBooleanKeyword") pm = { tag: "bool", name: "Bool" };
    else {
      const nm = namedRef(m);
      if (nm && isStruct(nm)) pm = { tag: "nom", name: nm };
    }
    if (!pm) return null;
    if (pm.tag === "nom") nomCount++;
    else hasPrim = true;
    const key = pm.tag === "nom" ? `nom:${pm.name}` : `prim:${pm.tag}`;
    if (seen.has(key)) return null;
    seen.add(key);
    out.push(pm);
  }
  if (!hasPrim || nomCount > 1 || out.length < 2) return null;
  return { members: out };
}

/**
 * A non-discriminated object union (series 093, stage 1e, case E): every member an
 * inline object type with **no** common literal discriminant. Maps to a struct-variant
 * enum whose variant names derive from each member's (sorted) field-name set, narrowed
 * at consumption by `"field" in x`.
 */
export interface NonDiscMember {
  /** PascalCased sorted field-name set (`{name,age}` → `AgeName`); collisions get an ordinal. */
  variantName: string;
  fields: { name: string; ann: TSType }[];
  /** Sorted field-name set — the construction (exact-set) + `in`-narrow key. */
  fieldSet: string[];
}
export interface NonDiscriminatedUnion {
  members: NonDiscMember[];
}

/**
 * Classify a non-discriminated object union (E): every member an inline object type,
 * with no common literal discriminant (that would be C). Variant names come from the
 * sorted field-name set, PascalCased; a name collision gets a stable ordinal. Returns
 * null when a member is not an inline object or the union is actually discriminated.
 */
export function classifyNonDiscriminatedUnion(
  members: TSType[],
): NonDiscriminatedUnion | null {
  const memberProps: PropSig[][] = [];
  for (const m of members) {
    const props = objectMemberProps(m);
    if (!props) return null;
    memberProps.push(props);
  }
  if (memberProps.length < 2) return null;
  if (findDiscriminant(memberProps)) return null;
  const seen = new Map<string, number>();
  const out: NonDiscMember[] = memberProps.map((props) => {
    const fieldSet = props.map((p) => p.name).sort();
    const base =
      fieldSet
        .map((f) => f.charAt(0).toUpperCase() + f.slice(1))
        .join("") || "Empty";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      variantName: n === 1 ? base : `${base}${n}`,
      fields: props.map((p) => ({ name: p.name, ann: p.ann })),
      fieldSet,
    };
  });
  return { members: out };
}

/** The order-independent canonical name for an anonymous non-discriminated union (E). */
export function anonNonDiscUnionName(u: NonDiscriminatedUnion): string {
  const sigs = u.members.map((m) => `{${m.fieldSet.join(",")}}`).sort();
  return `__anonymous_union_${fnv1a(`nondisc:${sigs.join("|")}`)}`;
}

/** The order-independent canonical name for an anonymous primitive/mixed union (F). */
export function anonPrimUnionName(u: PrimitiveUnion): string {
  const sigs = u.members
    .map((m) => (m.tag === "nom" ? `nom:${m.name}` : `prim:${m.tag}`))
    .sort();
  return `__anonymous_union_${fnv1a(sigs.join("|"))}`;
}

/** Extract a literal member from a `TSLiteralType`, or null if `m` is not one. */
function literalMember(m: TSType): LiteralMember | null {
  if (m.type !== "TSLiteralType") return null;
  const lit = (m as unknown as { literal?: { type?: string; value?: unknown } })
    .literal;
  const v = lit?.value;
  if (typeof v === "string") return { kind: "str", value: v };
  if (typeof v === "number") return { kind: "num", value: v };
  return null;
}

/**
 * Classify a union's already-nullish-stripped members. Returns the literal members
 * when **every** member is a string/number literal type (a stage-1a fieldless
 * union), else `null` (a shape 1a does not model — discriminated / object /
 * primitive — which stays fail-loud in `lowerType`).
 */
export function classifyLiteralUnion(members: TSType[]): LiteralMember[] | null {
  const out: LiteralMember[] = [];
  for (const m of members) {
    const lit = literalMember(m);
    if (!lit) return null;
    out.push(lit);
  }
  return out.length > 0 ? out : null;
}

/** The JS `String()` form of a literal value — the exact `Display` round-trip text. */
export function literalDisplay(m: LiteralMember): string {
  return String(m.value);
}

/**
 * Sanitize a literal value to a valid Rust variant identifier: split on
 * non-alphanumeric runs, PascalCase the segments, join. Empty / all-symbol → `Empty`;
 * a leading digit → `_`-prefixed; a negative number → `Neg`-prefixed. The result is
 * cosmetic — the original literal is preserved for Display/matching.
 */
export function sanitizeVariantIdent(value: string | number): string {
  const negative = typeof value === "number" && value < 0;
  const segs = String(value)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  let id = segs
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  if (id === "") id = "Empty";
  if (negative) id = `Neg${id}`;
  else if (/^[0-9]/.test(id)) id = `_${id}`;
  return id;
}

/**
 * The order-independent canonical name for an **anonymous** literal union: sort the
 * member signatures, hash them, and prefix. `"a" | "b"` and `"b" | "a"` hash the
 * same, so both spellings dedup to one Rust enum.
 */
export function anonUnionName(members: LiteralMember[]): string {
  const sigs = members
    .map((m) => (m.kind === "str" ? `s:${m.value}` : `n:${m.value}`))
    .sort();
  return `__anonymous_union_${fnv1a(sigs.join("|"))}`;
}

/**
 * Build the fieldless variant list for a literal union, sanitizing each ident and
 * disambiguating a collision (two distinct literals → same ident) with a stable
 * ordinal (`HasDash`, `HasDash2`). Variant order is canonical (sorted by signature)
 * so two spellings of the same union emit byte-identical Rust.
 */
export function literalVariants(members: LiteralMember[]): HirUnionVariant[] {
  const sorted = [...members].sort((a, b) =>
    (a.kind === "str" ? `s:${a.value}` : `n:${a.value}`).localeCompare(
      b.kind === "str" ? `s:${b.value}` : `n:${b.value}`,
    ),
  );
  const seen = new Map<string, number>();
  return sorted.map((m) => {
    const base = sanitizeVariantIdent(m.value);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      name: n === 1 ? base : `${base}${n}`,
      fields: [],
      display: literalDisplay(m),
    };
  });
}
