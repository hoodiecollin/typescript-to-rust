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

/// `String.prototype.replace(a, b)` — replace only the **first** occurrence of
/// `from` with `to` (the JS quirk; `replaceAll` / native `.replace` replace all).
/// A string `from` (not a RegExp) is the only form the dialect models.
pub fn replace_first(s: &str, from: &str, to: &str) -> String {
    s.replacen(from, to, 1)
}

/// `String.prototype.split(sep)` for a non-empty separator — JS returns an array
/// of the pieces (an empty string between adjacent separators is kept). Rust's
/// `str::split` matches this exactly for a non-empty pattern.
pub fn split(s: &str, sep: &str) -> Vec<String> {
    s.split(sep).map(|p| p.to_string()).collect()
}

/// `String.prototype.split("")` — the empty-separator quirk. JS splits into
/// UTF-16 code units; this first slice splits into Rust `char`s (documented
/// divergence for non-BMP text, matching the padStart/slice precedent).
pub fn split_chars(s: &str) -> Vec<String> {
    s.chars().map(|c| c.to_string()).collect()
}

/// Normalize a JS string index against the char length: truncate toward zero,
/// resolve a negative index from the end, then clamp into `[0, len]`.
fn str_index(i: f64, len: usize) -> usize {
    let len = len as i64;
    let i = i.trunc() as i64;
    let resolved = if i < 0 { len + i } else { i };
    resolved.clamp(0, len) as usize
}

/// `String.prototype.slice(start, end)` — a substring of `[start, end)` with JS's
/// clamping and negative-from-the-end semantics (`end` exclusive). Indices count
/// Rust `char`s this slice (UTF-16-vs-char divergence documented). An empty or
/// inverted range yields `""`.
pub fn str_slice(s: &str, start: f64, end: f64) -> String {
    let chars: Vec<char> = s.chars().collect();
    let a = str_index(start, chars.len());
    let b = str_index(end, chars.len());
    if b <= a {
        String::new()
    } else {
        chars[a..b].iter().collect()
    }
}

/// `String.prototype.slice(start)` — the end-omitted form, from `start` through
/// the end of the string.
pub fn str_slice_from(s: &str, start: f64) -> String {
    let chars: Vec<char> = s.chars().collect();
    let a = str_index(start, chars.len());
    chars[a..].iter().collect()
}

/// `String.prototype.substring(start, end)` — like `slice`, but a **negative**
/// index is treated as `0` (not from-the-end), and if `start > end` the two are
/// **swapped** (both JS quirks that distinguish it from `slice`).
pub fn substring(s: &str, start: f64, end: f64) -> String {
    let chars: Vec<char> = s.chars().collect();
    let len = chars.len() as i64;
    let clamp0 = |i: f64| -> usize {
        let i = i.trunc() as i64;
        i.clamp(0, len) as usize
    };
    let mut a = clamp0(start);
    let mut b = clamp0(end);
    if a > b {
        std::mem::swap(&mut a, &mut b);
    }
    chars[a..b].iter().collect()
}

/// `String.prototype.charAt(i)` — the 1-char string at index `i`, or `""` when
/// out of range (the JS quirk; JS returns `""`, not `undefined`, for `charAt`).
/// Char-indexed this slice (UTF-16-vs-char divergence documented).
pub fn char_at(s: &str, index: f64) -> String {
    let i = index.trunc();
    if i < 0.0 {
        return String::new();
    }
    s.chars()
        .nth(i as usize)
        .map(|c| c.to_string())
        .unwrap_or_default()
}
