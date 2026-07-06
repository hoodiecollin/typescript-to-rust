//! `String.prototype` methods absent from Rust's std (or with JS-specific rules).

/// `String.prototype.padStart` — left-pad `s` to `target_len` using `pad`.
///
/// JS semantics: if `s` is already at least `target_len` long, it is returned
/// unchanged; otherwise `pad` is repeated (and truncated) to fill the deficit on
/// the **left**. Length is counted in UTF-16 code units in JS; this first slice
/// counts Rust `char`s (documented divergence for non-BMP text). `target_len`
/// arrives as `f64` and is floored.
pub fn pad_start(s: &str, target_len: f64, pad: &str) -> String {
    let mut out = pad_fill(s, target_len, pad);
    out.push_str(s);
    out
}

/// `String.prototype.padEnd` — right-pad `s` to `target_len` using `pad`.
pub fn pad_end(s: &str, target_len: f64, pad: &str) -> String {
    let fill = pad_fill(s, target_len, pad);
    let mut out = s.to_string();
    out.push_str(&fill);
    out
}

/// The pad fragment for a deficit of `target_len - len(s)` chars — `pad` repeated
/// and truncated. Empty when `s` already meets the target or `pad` is empty.
fn pad_fill(s: &str, target_len: f64, pad: &str) -> String {
    let target = target_len.trunc().max(0.0) as usize;
    let len = s.chars().count();
    if len >= target || pad.is_empty() {
        return String::new();
    }
    let deficit = target - len;
    pad.chars().cycle().take(deficit).collect()
}
