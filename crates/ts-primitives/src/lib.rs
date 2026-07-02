//! Runtime support for the TypeScript → Rust translator.
//!
//! Memory model: **Option A (idiomatic borrows).** The translator emits plain
//! Rust ownership (`T`, `&T`, `&mut T`) wherever it can prove it is sound, so
//! this crate is deliberately small. It exists only for the handful of TS
//! constructs that have *no* clean static Rust equivalent — chiefly `any` /
//! `unknown`. Prefer concrete types in generated code; reach for [`TsAny`] only
//! when the translator genuinely cannot monomorphize a value.

use std::collections::HashMap;
use std::fmt;

/// A dynamically-typed value mirroring TypeScript's `any` / `unknown`.
///
/// This is the escape hatch, not the default. The translator only emits
/// `TsAny` when a value's static type cannot be resolved within the strict
/// input dialect.
#[derive(Debug, Clone, PartialEq)]
pub enum TsAny {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<TsAny>),
    Object(HashMap<String, TsAny>),
}

impl TsAny {
    /// JavaScript `typeof`, as a `&'static str`.
    pub fn type_of(&self) -> &'static str {
        match self {
            TsAny::Undefined => "undefined",
            TsAny::Null => "object", // matches JS's historical `typeof null`
            TsAny::Bool(_) => "boolean",
            TsAny::Number(_) => "number",
            TsAny::String(_) => "string",
            TsAny::Array(_) | TsAny::Object(_) => "object",
        }
    }

    /// JavaScript truthiness.
    pub fn is_truthy(&self) -> bool {
        match self {
            TsAny::Undefined | TsAny::Null => false,
            TsAny::Bool(b) => *b,
            TsAny::Number(n) => *n != 0.0 && !n.is_nan(),
            TsAny::String(s) => !s.is_empty(),
            TsAny::Array(_) | TsAny::Object(_) => true,
        }
    }
}

impl fmt::Display for TsAny {
    /// Mirrors `String(value)` in JavaScript closely enough for `console.log`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TsAny::Undefined => f.write_str("undefined"),
            TsAny::Null => f.write_str("null"),
            TsAny::Bool(b) => write!(f, "{b}"),
            TsAny::Number(n) => write!(f, "{n}"),
            TsAny::String(s) => f.write_str(s),
            TsAny::Array(items) => {
                let parts: Vec<String> = items.iter().map(|i| i.to_string()).collect();
                f.write_str(&parts.join(","))
            }
            TsAny::Object(_) => f.write_str("[object Object]"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type_of_matches_js() {
        assert_eq!(TsAny::Number(1.0).type_of(), "number");
        assert_eq!(TsAny::Null.type_of(), "object");
        assert_eq!(TsAny::Undefined.type_of(), "undefined");
    }

    #[test]
    fn truthiness_matches_js() {
        assert!(!TsAny::Number(0.0).is_truthy());
        assert!(TsAny::Number(1.0).is_truthy());
        assert!(!TsAny::String(String::new()).is_truthy());
        assert!(TsAny::String("x".into()).is_truthy());
        assert!(!TsAny::Null.is_truthy());
    }

    #[test]
    fn display_matches_js_string_coercion() {
        assert_eq!(TsAny::Number(5.0).to_string(), "5");
        assert_eq!(TsAny::Number(5.5).to_string(), "5.5");
        assert_eq!(
            TsAny::Array(vec![TsAny::Number(1.0), TsAny::Number(2.0)]).to_string(),
            "1,2"
        );
        assert_eq!(TsAny::Undefined.to_string(), "undefined");
    }
}
