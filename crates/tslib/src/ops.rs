//! JS-operator trait layer (series 088) — the Rust-side mirror of the std-shim
//! isolation boundary. **Inside a generic body, a bare `T` is a JS value**, and
//! every operator on it lowers to one of these traits' methods instead of a native
//! Rust operator. The translator emits native operators everywhere else (concrete,
//! non-generic code is completely untouched); this layer exists only so a
//! *monomorphized* generic body — which can't dispatch on the operands' runtime
//! type, and for which Rust has no native operator bound spanning `f64`/`String` —
//! can still express JS `+`/`<`/`===` semantics uniformly.
//!
//! Design boundary: fine trait granularity is **forced** — `String` supports `+`
//! (concat) but not `-`, so arithmetic can't be a single bound. Because the two
//! operands are the same `T`, arithmetic returns `Self` and comparison/equality
//! returns `bool`, so **no associated `Output` type is needed** and bounds stay
//! bare (`T: JsAdd`). Dispatch is **by reference** (`&self, &Self`) so it composes
//! with the ownership passes — never move out of a field. Each method is trivial,
//! so rustc inlines it (zero-cost).
//!
//! The trait bound **is** the constraint: "numeric-only arithmetic" is encoded here
//! (only `f64` implements `JsSub`/`JsMul`/…), not in the validator. A `String`
//! instantiation of a `-` fails **at the bound** — loud, never miscompiled.
//!
//! Per-struct `JsEq` (structural `===` over a struct-typed `T`) is emitted by the
//! translator alongside each qualifying (`PartialEq`-deriving) user struct, not
//! here — it delegates to the struct's derived `PartialEq`.

/// JS `+` — `f64` addition or `String` concatenation.
pub trait JsAdd {
    fn js_add(&self, rhs: &Self) -> Self;
}
/// JS `-` — `f64` only.
pub trait JsSub {
    fn js_sub(&self, rhs: &Self) -> Self;
}
/// JS `*` — `f64` only.
pub trait JsMul {
    fn js_mul(&self, rhs: &Self) -> Self;
}
/// JS `/` — `f64` only.
pub trait JsDiv {
    fn js_div(&self, rhs: &Self) -> Self;
}
/// JS `%` — `f64` only.
pub trait JsRem {
    fn js_rem(&self, rhs: &Self) -> Self;
}
/// JS `< <= > >=`.
pub trait JsOrd {
    fn js_lt(&self, rhs: &Self) -> bool;
    fn js_le(&self, rhs: &Self) -> bool;
    fn js_gt(&self, rhs: &Self) -> bool;
    fn js_ge(&self, rhs: &Self) -> bool;
}
/// JS `=== !==` (over a primitive; a struct-typed `T` gets a per-struct impl).
pub trait JsEq {
    fn js_eq(&self, rhs: &Self) -> bool;
    fn js_ne(&self, rhs: &Self) -> bool;
}

/// Generate the uniform `JsOrd`/`JsEq` arms (native `PartialOrd`/`PartialEq`) for a
/// type, plus optionally the arithmetic arms. The specialized `JsAdd` for `String`
/// (concat, not native `+`) is written out separately below.
macro_rules! impl_js_ops {
    // ordering + equality only (`bool`)
    (@cmp $ty:ty) => {
        impl JsOrd for $ty {
            fn js_lt(&self, rhs: &Self) -> bool { self < rhs }
            fn js_le(&self, rhs: &Self) -> bool { self <= rhs }
            fn js_gt(&self, rhs: &Self) -> bool { self > rhs }
            fn js_ge(&self, rhs: &Self) -> bool { self >= rhs }
        }
        impl JsEq for $ty {
            fn js_eq(&self, rhs: &Self) -> bool { self == rhs }
            fn js_ne(&self, rhs: &Self) -> bool { self != rhs }
        }
    };
    // full numeric set: native arithmetic (return `Self`) + ordering + equality (`f64`)
    (@num $ty:ty) => {
        impl JsAdd for $ty { fn js_add(&self, rhs: &Self) -> Self { self + rhs } }
        impl JsSub for $ty { fn js_sub(&self, rhs: &Self) -> Self { self - rhs } }
        impl JsMul for $ty { fn js_mul(&self, rhs: &Self) -> Self { self * rhs } }
        impl JsDiv for $ty { fn js_div(&self, rhs: &Self) -> Self { self / rhs } }
        impl JsRem for $ty { fn js_rem(&self, rhs: &Self) -> Self { self % rhs } }
        impl_js_ops!(@cmp $ty);
    };
}

impl_js_ops!(@num f64);
impl_js_ops!(@cmp bool);
impl_js_ops!(@cmp String);

// `String`'s `JsAdd` is JS string concatenation (`format!`), the specialized arm —
// not native `+` (`String: Add<&str>`, not `Add<String>`). Ordering is lexicographic
// over UTF-8 bytes (≡ Unicode scalar), the documented JS ⇄ Rust edge for astral chars.
impl JsAdd for String {
    fn js_add(&self, rhs: &Self) -> Self {
        format!("{self}{rhs}")
    }
}
