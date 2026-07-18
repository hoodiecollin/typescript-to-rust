//! `JSON.stringify` fidelity (series 045). serde_json serializes an `f64` as
//! `1.0`, but JS `JSON.stringify` prints `1`; and object key order must be
//! insertion order. So we serialize to a `serde_json::Value` (with the
//! `preserve_order` feature) and render it with JS number/formatting rules here.

use serde::Serialize;
use serde_json::Value;

/// `parseJson<T>(s)` result (series 084, the `@ttr/std` shim). A purpose-built
/// std-shim result type: the dialect has no generic/payload-carrying enum to
/// model a raw `{ ok, value } | { ok, error }` union, so the compiler lowers
/// `parseJson<T>(s)` to `ParseResult::<T>::parse(&s)` and reads the tagged
/// surface (`.ok` field, `.value()` / `.error()` accessors). `serde`'s
/// structural deserialize *is* the validation — an ill-shaped input yields an
/// error result rather than a panic. Mirrors the TS `ParseResult<T>` union in
/// `@ttr/std` so the differential oracle observes identical `.ok`/`.value`.
pub struct ParseResult<T> {
    /// `true` when deserialization succeeded (the discriminant).
    pub ok: bool,
    value: Option<T>,
    error: Option<String>,
}

impl<T: serde::de::DeserializeOwned> ParseResult<T> {
    /// Deserialize `s` into a `T`; never panics — a parse/shape error lands in
    /// the `error` arm with `ok: false`.
    pub fn parse(s: &str) -> ParseResult<T> {
        match serde_json::from_str::<T>(s) {
            Ok(v) => ParseResult { ok: true, value: Some(v), error: None },
            Err(e) => ParseResult { ok: false, value: None, error: Some(e.to_string()) },
        }
    }

    /// The deserialized value (borrowed, so it can be read repeatedly under a
    /// proven-`ok` branch) — mirrors the TS `if (r.ok) { r.value.x; r.value.y }`.
    pub fn value(&self) -> &T {
        self.value.as_ref().expect("parseJson: value on an error result")
    }

    /// The error string (borrowed), read under the `!ok` branch.
    pub fn error(&self) -> &str {
        self.error.as_deref().expect("parseJson: error on an ok result")
    }

    /// `fromJsonValue<T>(v)` (series 090) — dynamic → static. Deserialize an
    /// already-parsed `serde_json::Value` (the inner tree of a `JsonValue`) into a
    /// modeled `T`; never panics — a shape mismatch lands in the `error` arm,
    /// mirroring `parse`.
    pub fn from_value(v: serde_json::Value) -> ParseResult<T> {
        match serde_json::from_value::<T>(v) {
            Ok(val) => ParseResult { ok: true, value: Some(val), error: None },
            Err(e) => ParseResult { ok: false, value: None, error: Some(e.to_string()) },
        }
    }
}

/// A dynamic JSON value (series 090, epic #59) — the opt-in escape hatch from the
/// statically-typed dialect into an untyped tree, reached only via `@ttr/std`'s
/// `parseJsonValue` / `fromJsonValue` / `toJsonValue`. A `#[serde(transparent)]`
/// newtype over `serde_json::Value`, so it (de)serializes exactly as the inner
/// value — it drops straight into `ParseResult<T>` and `stringify` with no
/// special-casing — while the newtype lets us hang inherent, fail-loud accessor
/// methods on it without colliding with `serde_json::Value`'s own `.get`/`.as_f64`.
///
/// Navigation into a missing object key / out-of-bounds index yields a `Null`
/// value (matching JS `undefined`, so `.is_null()` distinguishes and chaining
/// `v.get("a").get("b")` stays safe); navigating into a *non-container*, or
/// coercing a mismatched scalar, is fail-loud (`panic!`) — the differential
/// mirror of the TS wrapper's `throw`. Panic messages carry the TS-facing accessor
/// name (`asNumber`, `get`, …) so the differential observes matching failures.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct JsonValue(pub serde_json::Value);

impl JsonValue {
    /// Object member (`Null` if absent); panics on a non-object. Takes
    /// `impl AsRef<str>` so a dialect string (`"k".to_string()`) or a `&str` both
    /// pass without an emitter-side coercion.
    pub fn get(&self, key: impl AsRef<str>) -> JsonValue {
        match &self.0 {
            Value::Object(map) => {
                JsonValue(map.get(key.as_ref()).cloned().unwrap_or(Value::Null))
            }
            _ => panic!("get: JsonValue is not an object"),
        }
    }

    /// Array element (`Null` if out of bounds); panics on a non-array.
    pub fn at(&self, i: f64) -> JsonValue {
        match &self.0 {
            Value::Array(arr) => {
                if i < 0.0 || i.fract() != 0.0 {
                    return JsonValue(Value::Null);
                }
                JsonValue(arr.get(i as usize).cloned().unwrap_or(Value::Null))
            }
            _ => panic!("at: JsonValue is not an array"),
        }
    }

    /// Number → `f64`; panics otherwise.
    pub fn as_number(&self) -> f64 {
        match &self.0 {
            Value::Number(n) => {
                n.as_f64().expect("asNumber: JsonValue number not representable as f64")
            }
            _ => panic!("asNumber: JsonValue is not a number"),
        }
    }

    /// String → owned `String`; panics otherwise.
    pub fn as_string(&self) -> String {
        match &self.0 {
            Value::String(s) => s.clone(),
            _ => panic!("asString: JsonValue is not a string"),
        }
    }

    /// Bool → `bool`; panics otherwise.
    pub fn as_bool(&self) -> bool {
        match &self.0 {
            Value::Bool(b) => *b,
            _ => panic!("asBool: JsonValue is not a bool"),
        }
    }

    pub fn is_null(&self) -> bool {
        self.0.is_null()
    }
    pub fn is_number(&self) -> bool {
        self.0.is_number()
    }
    pub fn is_string(&self) -> bool {
        self.0.is_string()
    }
    pub fn is_bool(&self) -> bool {
        self.0.is_boolean()
    }
    pub fn is_array(&self) -> bool {
        self.0.is_array()
    }
    pub fn is_object(&self) -> bool {
        self.0.is_object()
    }

    /// Array element count as `f64` (the dialect's `number`); panics on a non-array.
    pub fn length(&self) -> f64 {
        match &self.0 {
            Value::Array(arr) => arr.len() as f64,
            _ => panic!("length: JsonValue is not an array"),
        }
    }
}

/// `JSON.stringify(v)` — compact, JS number formatting.
pub fn stringify<T: Serialize>(v: &T) -> String {
    let val = serde_json::to_value(v).expect("JSON.stringify: serialize");
    let mut out = String::new();
    write_value(&val, &mut out);
    out
}

fn write_value(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&format_number(n)),
        Value::String(s) => write_json_string(s, out),
        Value::Array(arr) => {
            out.push('[');
            for (i, item) in arr.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (k, val)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(k, out);
                out.push(':');
                write_value(val, out);
            }
            out.push('}');
        }
    }
}

/// JS number formatting: an integral value prints without a decimal point
/// (`1`, not `1.0`); a fractional value uses the shortest round-trip form.
fn format_number(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    if let Some(f) = n.as_f64() {
        if f.is_finite() && f.fract() == 0.0 {
            return format!("{}", f as i64);
        }
        return format!("{}", f);
    }
    "null".to_string()
}

fn write_json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}
