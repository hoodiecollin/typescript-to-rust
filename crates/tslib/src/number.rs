//! `Number.prototype` / `Number.*` methods whose JS semantics diverge from the
//! obvious Rust (series 083). Numeric args arrive as `f64` (the translator's
//! `number`); coercions are confined here rather than an emitter `as` cast.

/// `String(n)` / `n.toString()` (no radix) — JS number→string formatting. An
/// integral `f64` prints without a decimal (`1`, not `1.0`); `-0` prints `0`
/// (JS `String(-0)` is `"0"`); non-finite values print `Infinity`/`-Infinity`/
/// `NaN`. Fractions use Rust's shortest-round-trip `{}`, which matches JS's
/// shortest-round-trip form in the common range.
pub fn to_js_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if n == 0.0 {
        // Covers both +0 and -0 → "0" (JS `String(-0) === "0"`).
        return "0".to_string();
    }
    if n.fract() == 0.0 && n.abs() < 1e21 {
        // Integral in the non-exponential range → no decimal point.
        return format!("{}", n as i64);
    }
    format!("{}", n)
}

/// `n.toString(radix)` — render `n` in `radix` (2..=36). JS renders the integer
/// part in the given base; a fractional part is rare in practice and this slice
/// models the integer case (matching the common usage), rendering only the
/// truncated integer in `radix`. Radix 10 falls back to `to_js_string`.
pub fn to_radix(n: f64, radix: f64) -> String {
    let radix = radix.trunc() as u32;
    if radix == 10 || !(2..=36).contains(&radix) {
        return to_js_string(n);
    }
    let neg = n < 0.0;
    let mut int = n.abs().trunc() as u64;
    if int == 0 {
        return "0".to_string();
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while int > 0 {
        out.push(digits[(int % radix as u64) as usize]);
        int /= radix as u64;
    }
    if neg {
        out.push(b'-');
    }
    out.reverse();
    String::from_utf8(out).expect("ascii digits")
}

/// `n.toFixed(d)` — format `n` with exactly `d` digits after the decimal point,
/// rounding half-away-from-zero (JS's `toFixed` rounding). `d` is `0..=100` in
/// JS; Rust's `{:.*}` uses round-half-to-even, so for parity we round manually.
pub fn to_fixed(n: f64, digits: f64) -> String {
    let d = digits.trunc().clamp(0.0, 100.0) as usize;
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    let factor = 10f64.powi(d as i32);
    // Round half-away-from-zero (JS semantics), unlike Rust's `{:.*}` half-even.
    let scaled = (n * factor).abs() + 0.5;
    let rounded = scaled.floor() / factor;
    let signed = if n < 0.0 && rounded != 0.0 { -rounded } else { rounded };
    format!("{:.*}", d, signed)
}

/// `Number.parseInt(s, radix)` — parse a leading integer, tolerating trailing
/// non-digit garbage (the JS quirk `parseInt("42px", 10) === 42`). Skips leading
/// whitespace and an optional sign, honors a `0x` prefix when `radix` is 16 or 0.
/// Returns `NaN` when no digits are found (JS returns `NaN`).
pub fn parse_int(s: &str, radix: f64) -> f64 {
    let mut radix = radix.trunc() as i64;
    let t = s.trim_start();
    let bytes = t.as_bytes();
    let mut i = 0usize;
    let mut sign = 1f64;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        if bytes[i] == b'-' {
            sign = -1.0;
        }
        i += 1;
    }
    // `0x`/`0X` prefix handling for radix 16 or unspecified (0).
    if (radix == 16 || radix == 0)
        && i + 1 < bytes.len()
        && bytes[i] == b'0'
        && (bytes[i + 1] == b'x' || bytes[i + 1] == b'X')
    {
        i += 2;
        radix = 16;
    }
    if radix == 0 {
        radix = 10;
    }
    if !(2..=36).contains(&radix) {
        return f64::NAN;
    }
    let start = i;
    let mut acc = 0f64;
    while i < bytes.len() {
        let c = bytes[i] as char;
        let digit = c.to_digit(radix as u32);
        match digit {
            Some(dv) => {
                acc = acc * radix as f64 + dv as f64;
                i += 1;
            }
            None => break,
        }
    }
    if i == start {
        return f64::NAN;
    }
    sign * acc
}

/// `Number.parseFloat(s)` — parse a leading float, tolerating trailing garbage
/// (`parseFloat("3.14abc") === 3.14`). Returns `NaN` when no number is found.
pub fn parse_float(s: &str) -> f64 {
    let t = s.trim_start();
    let bytes = t.as_bytes();
    let mut end = 0usize;
    let mut seen_dot = false;
    let mut seen_e = false;
    let mut seen_digit = false;
    let mut i = 0usize;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_digit() {
            seen_digit = true;
            end = i + 1;
        } else if c == b'.' && !seen_dot && !seen_e {
            seen_dot = true;
        } else if (c == b'e' || c == b'E') && !seen_e && seen_digit {
            seen_e = true;
            // an optional sign right after the exponent marker
            if i + 1 < bytes.len() && (bytes[i + 1] == b'+' || bytes[i + 1] == b'-') {
                i += 1;
            }
        } else {
            break;
        }
        i += 1;
    }
    if !seen_digit {
        return f64::NAN;
    }
    t[..end].parse::<f64>().unwrap_or(f64::NAN)
}
