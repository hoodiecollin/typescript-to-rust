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

interface PropSig {
  name: string;
  ann: TSType;
  literal: LiteralMember | null;
}

/** The property signatures of an inline object type `{ … }`, or null if `m` isn't one. */
function objectMemberProps(m: TSType): PropSig[] | null {
  if (m.type !== "TSTypeLiteral") return null;
  const members = (m as unknown as { members?: unknown[] }).members ?? [];
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
  const discField =
    DISC_PREFERENCE.find((n) => candidates.includes(n)) ?? candidates[0]!;
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
