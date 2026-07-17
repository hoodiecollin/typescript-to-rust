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
pub mod http;
pub mod io;
pub mod json;
pub mod number;
pub mod ops;
pub mod rng;
pub mod string;
pub mod truthy;

/// JS `Math.min(...)` — the minimum of a variadic `f64` list, **NaN-propagating**
/// (any `NaN` argument makes the whole result `NaN`, unlike `f64::min` which
/// ignores `NaN`). The sanctioned variadic macro (029 Tm route), not a coercion
/// macro. `Math.min()` with no args is JS `Infinity`.
#[macro_export]
macro_rules! min {
    () => { f64::INFINITY };
    ($($x:expr),+ $(,)?) => {{
        let mut __acc = f64::INFINITY;
        $(
            let __v: f64 = $x;
            if __v.is_nan() { __acc = f64::NAN; }
            else if !__acc.is_nan() && __v < __acc { __acc = __v; }
        )+
        __acc
    }};
}

/// JS `Math.max(...)` — the maximum of a variadic `f64` list, **NaN-propagating**.
/// `Math.max()` with no args is JS `-Infinity`.
#[macro_export]
macro_rules! max {
    () => { f64::NEG_INFINITY };
    ($($x:expr),+ $(,)?) => {{
        let mut __acc = f64::NEG_INFINITY;
        $(
            let __v: f64 = $x;
            if __v.is_nan() { __acc = f64::NAN; }
            else if !__acc.is_nan() && __v > __acc { __acc = __v; }
        )+
        __acc
    }};
}
