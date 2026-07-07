//! `JSON.stringify` fidelity (series 045). serde_json serializes an `f64` as
//! `1.0`, but JS `JSON.stringify` prints `1`; and object key order must be
//! insertion order. So we serialize to a `serde_json::Value` (with the
//! `preserve_order` feature) and render it with JS number/formatting rules here.

use serde::Serialize;
use serde_json::Value;

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
