//! The reference plugin crate (epic #95, series 110) — the Rust half of
//! `@ttr/plugin-leftpad`.
//!
//! `left_pad` reproduces JS `String.prototype.padStart(width, fill)` fidelity: a
//! multi-char `fill` is cycled and truncated to exactly the deficit, and a string
//! already at/over `width` is returned unchanged. This is the runtime the plugin's
//! `expand()` emits a core-HIR `call` into — a genuine quirk-heavy behavior (the
//! reason a plugin brings a crate rather than open-coding the emit).
//!
//! Length is counted in Rust `char`s (Unicode scalar values), consistent with the
//! dialect's char-indexed string model (series 098), which diverges from JS's
//! UTF-16 code-unit count only for astral / surrogate inputs.

/// Left-pad `s` to `width` chars using `fill` (JS `padStart` semantics). `width`
/// arrives as `f64` (the dialect's `number`); it is truncated toward zero, with
/// `NaN`/negative treated as `0` (matching JS `ToLength`). An empty `fill`, or an
/// `s` already at/over `width`, returns `s` unchanged.
pub fn left_pad(s: &str, width: f64, fill: &str) -> String {
    let target = if width.is_nan() || width < 0.0 {
        0
    } else {
        width as usize
    };
    let s_len = s.chars().count();
    if s_len >= target || fill.is_empty() {
        return s.to_string();
    }
    let deficit = target - s_len;
    let fill_chars: Vec<char> = fill.chars().collect();
    let pad: String = (0..deficit)
        .map(|i| fill_chars[i % fill_chars.len()])
        .collect();
    let mut out = String::with_capacity(pad.len() + s.len());
    out.push_str(&pad);
    out.push_str(s);
    out
}

#[cfg(test)]
mod tests {
    use super::left_pad;

    #[test]
    fn pads_deficit_with_single_char() {
        assert_eq!(left_pad("7", 3.0, "0"), "007");
    }

    #[test]
    fn already_at_width_is_unchanged() {
        assert_eq!(left_pad("42", 2.0, "0"), "42");
        assert_eq!(left_pad("longer", 3.0, "0"), "longer");
    }

    #[test]
    fn multi_char_fill_is_cycled_and_truncated() {
        assert_eq!(left_pad("x", 5.0, "ab"), "ababx");
        assert_eq!(left_pad("z", 2.0, "."), ".z");
    }

    #[test]
    fn empty_fill_returns_unchanged() {
        assert_eq!(left_pad("x", 5.0, ""), "x");
    }

    #[test]
    fn nan_and_negative_width_treated_as_zero() {
        assert_eq!(left_pad("x", f64::NAN, "0"), "x");
        assert_eq!(left_pad("x", -3.0, "0"), "x");
    }

    #[test]
    fn fractional_width_truncates_toward_zero() {
        assert_eq!(left_pad("7", 3.9, "0"), "007");
    }
}
