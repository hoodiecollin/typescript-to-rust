//! `tslib` — JS-semantics fidelity for the TypeScript → Rust translator.
//!
//! The translator emits **native idiomatic Rust** wherever a JS method maps
//! cleanly (see 027's hybrid rule). This crate owns only the *quirk-heavy*
//! surfaces, where JS runtime behavior differs from the obvious Rust and would
//! otherwise be open-coded (and subtly mis-coded) in the emitter:
//!
//!   - `Array.prototype.at` — negative indexing from the end.
//!   - `String.prototype.padStart` / `padEnd` — not in std.
//!
//! Design boundary (see the codegen-helper-boundary note): this layer is for
//! *behavioral* fidelity — what a value **does** at runtime. It is **fn-first**;
//! a `macro_rules!` is reserved for genuine variadics / literal-ergonomics, never
//! a type/ownership coercion (that belongs in the translator's inference passes).
//! Numeric args arrive as `f64` (the translator's `number`) and are floored here,
//! confining the runtime coercion to this audited crate rather than a codegen
//! `as usize` cast.

pub mod array;
pub mod gen;
pub mod json;
pub mod string;
