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

/// `String.prototype.at(i)` — the 1-char string at index `i`, or `undefined`
/// (→ `None`) when out of range. Unlike `charAt`, a negative `i` counts from the
/// end and an out-of-range read is **`None`**, not `""` (the JS distinction).
/// Char-indexed (UTF-16-vs-char divergence documented, per `charAt`).
pub fn str_at(s: &str, index: f64) -> Option<String> {
    let chars: Vec<char> = s.chars().collect();
    let len = chars.len() as i64;
    let i = index.trunc() as i64;
    let resolved = if i < 0 { len + i } else { i };
    if resolved < 0 || resolved >= len {
        return None;
    }
    Some(chars[resolved as usize].to_string())
}

/// `String.prototype.indexOf(needle, from)` — the char index of the first
/// occurrence of `needle` at or after `from`, or `-1`. JS clamps a negative
/// `from` to `0` (it is **not** counted from the end, unlike `slice`). An empty
/// `needle` matches at `min(from, len)`. Char-indexed (divergence documented).
///
/// Substring search runs through `str::find` (memchr/two-way, no per-call
/// allocation) instead of collecting the whole haystack into a `Vec<char>` and
/// scanning char windows. Because both `s` and `needle` are valid UTF-8, a byte
/// match is a char match at a char boundary, so the result is byte-identical to
/// the char-window scan; the byte offset is converted back to a **char** index
/// (`s[..b].chars().count()`) to preserve the documented UTF-16-vs-char divergence.
pub fn index_of(s: &str, needle: &str, from: f64) -> f64 {
    let f = from.trunc();
    // Char index at which the search starts (JS clamps negative/NaN to 0).
    let start_char = if f.is_nan() || f < 0.0 { 0 } else { f as usize };
    if needle.is_empty() {
        // Empty needle matches at min(start, len) — clamp to the char length.
        return start_char.min(s.chars().count()) as f64;
    }
    // Byte offset of char `start_char`; `None` ⇒ start is at/past the end, where a
    // non-empty needle cannot match (JS returns -1).
    let byte_start = match char_to_byte(s, start_char) {
        Some(b) => b,
        None => return -1.0,
    };
    match s[byte_start..].find(needle) {
        Some(rel) => s[..byte_start + rel].chars().count() as f64,
        None => -1.0,
    }
}

/// Byte offset of char index `n` in `s`. Returns `Some(s.len())` when `n` equals
/// the char length (the valid one-past-the-end position), and `None` when `n` is
/// strictly past the end. `n == 0` short-circuits to `Some(0)`, so the common
/// `from = 0` search never walks the string.
fn char_to_byte(s: &str, n: usize) -> Option<usize> {
    let mut count = 0;
    for (b, _) in s.char_indices() {
        if count == n {
            return Some(b);
        }
        count += 1;
    }
    // n == char count ⇒ one-past-the-end (byte len); n > count ⇒ past the end.
    if n == count { Some(s.len()) } else { None }
}

/// `String.prototype.lastIndexOf(needle)` — the char index of the last
/// occurrence of `needle`, or `-1`. An empty `needle` matches at `len`.
/// Char-indexed (divergence documented). The 2-arg `fromIndex` form is a
/// fail-loud residual in the dialect (never reaches here).
pub fn last_index_of(s: &str, needle: &str) -> f64 {
    if needle.is_empty() {
        return s.chars().count() as f64;
    }
    // `str::rfind` gives the byte offset of the last match (allocation-free);
    // convert to a char index to preserve the documented char-vs-UTF-16 divergence.
    match s.rfind(needle) {
        Some(b) => s[..b].chars().count() as f64,
        None => -1.0,
    }
}

/// `String.prototype.split(sep, limit)` for a non-empty separator — like `split`
/// but returns **at most** `limit` pieces (JS truncates the array; it does not
/// merge the remainder into the last piece). A negative / NaN limit means "no
/// limit". `limit` arrives as `f64` and is floored.
pub fn split_limit(s: &str, sep: &str, limit: f64) -> Vec<String> {
    s.split(sep).take(split_take(limit)).map(|p| p.to_string()).collect()
}

/// `String.prototype.split("", limit)` — the empty-separator quirk with a piece
/// cap (char-indexed, matching `split_chars`).
pub fn split_chars_limit(s: &str, limit: f64) -> Vec<String> {
    s.chars().take(split_take(limit)).map(|c| c.to_string()).collect()
}

/// The piece cap for a `split(_, limit)` call — a floored non-negative `limit`,
/// or `usize::MAX` ("no limit") for a negative / NaN request.
fn split_take(limit: f64) -> usize {
    let l = limit.trunc();
    if l.is_nan() || l < 0.0 {
        usize::MAX
    } else {
        l as usize
    }
}

/// `String.prototype.substr(start, length)` — `length` chars starting at char
/// `start`. A negative `start` counts from the end (`max(len + start, 0)`); a
/// negative / NaN `length` yields `""`. Deprecated in JS but common. Char-indexed
/// (divergence documented). Both args arrive as `f64` and are floored.
pub fn substr(s: &str, start: f64, length: f64) -> String {
    let chars: Vec<char> = s.chars().collect();
    let a = substr_start(start, chars.len());
    let l = length.trunc();
    let count = if l.is_nan() || l < 0.0 { 0 } else { l as usize };
    let end = (a + count).min(chars.len());
    chars[a..end].iter().collect()
}

/// `String.prototype.substr(start)` — the length-omitted form, from `start`
/// (negative counts from the end) through the end of the string.
pub fn substr_from(s: &str, start: f64) -> String {
    let chars: Vec<char> = s.chars().collect();
    let a = substr_start(start, chars.len());
    chars[a..].iter().collect()
}

/// The resolved start char index for `substr`: a negative `start` is
/// `max(len + start, 0)`, then clamp into `[0, len]`.
fn substr_start(start: f64, len: usize) -> usize {
    let len = len as i64;
    let mut a = start.trunc() as i64;
    if a < 0 {
        a = (len + a).max(0);
    }
    a.clamp(0, len) as usize
}
