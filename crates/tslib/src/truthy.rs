//! JS truthiness + `Option` print rendering (series 066).
//!
//! The dialect models absence as `Option<T>` (`null ≡ undefined` → `None`). Two
//! runtime quirks live here, per the codegen-helper-boundary rule (fn-first —
//! these are *behavioral* fidelity, not type/ownership facts):
//!
//!   - **`is_truthy`** — the single JS-falsy predicate powering `||`, `&&`,
//!     `if (x)`, and `!x`. Falsy set: `false`, `0`/`-0`, `""`, `null`/`undefined`
//!     (`None`), `NaN`. Everything else (incl. `[]`, non-empty strings, non-zero
//!     numbers, `Some(_)`) is truthy. One shared predicate (design decision E)
//!     rather than a per-site rule.
//!   - **`fmt_opt`** — `console.log` rendering of an `Option<T>`: `Some(v)` prints
//!     the `v` render; `None` prints the literal `undefined` (canonical `None`
//!     spelling, design decision C).

use std::fmt::Display;

/// The JS-truthiness predicate. Implemented per operand type so the translator
/// can call `is_truthy(&x)` at any `||`/`&&`/`if`/`!` site regardless of `x`'s
/// Rust type. `bool` operands stay native (the translator does not route them
/// here); this trait covers the coercible types.
pub trait Truthy {
    fn is_truthy(&self) -> bool;
}

impl Truthy for bool {
    fn is_truthy(&self) -> bool {
        *self
    }
}

impl Truthy for f64 {
    /// `0.0`, `-0.0`, and `NaN` are falsy; every other finite/infinite value is
    /// truthy (matching JS `ToBoolean` on a number).
    fn is_truthy(&self) -> bool {
        *self != 0.0 && !self.is_nan()
    }
}

impl Truthy for str {
    /// The empty string is the only falsy string.
    fn is_truthy(&self) -> bool {
        !self.is_empty()
    }
}

impl Truthy for String {
    fn is_truthy(&self) -> bool {
        !self.is_empty()
    }
}

impl<T> Truthy for Option<T> {
    /// Absence (`None`) is falsy; a present value (`Some(_)`) is truthy — the
    /// dialect never inspects the inner value here (a `Some(0.0)` is truthy,
    /// because presence, not the inner number, is what an `Option` in a
    /// truthiness position asks about).
    fn is_truthy(&self) -> bool {
        self.is_some()
    }
}

/// The single JS-falsy predicate. `is_truthy(&x)` for any `x: Truthy`.
pub fn is_truthy<T: Truthy + ?Sized>(v: &T) -> bool {
    v.is_truthy()
}

/// `console.log` render of an `Option<T>`: `Some(v)` → the `v` render, `None` →
/// the literal `undefined` (design decision C). Returns a `String` so it drops
/// straight into a `println!("{}", …)` argument slot.
pub fn fmt_opt<T: Display>(v: &Option<T>) -> String {
    match v {
        Some(inner) => format!("{inner}"),
        None => "undefined".to_string(),
    }
}
