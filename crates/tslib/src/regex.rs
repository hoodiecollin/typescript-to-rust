//! RegExp fidelity (series 101, epic #56 / Tier-3) — JS-shaped wrappers over the
//! Rust `regex` crate. The emitter routes `/pat/flags` and `new RegExp("lit")` to
//! [`Regex::new_lit`] (fn-first, per the codegen-helper-boundary note) so the two
//! fidelity chores it must not open-code live here once:
//!
//!   1. **byte→char offset conversion** for `search` (the `regex` crate returns
//!      byte offsets; JS observes char/UTF-16 offsets — we use the 083/098
//!      char-indexed model), and
//!   2. the **`RegExpMatchArray` shape** (`[full, g1, …]` with a non-participating
//!      group rendered `None` → JS `undefined`, via the shipped 066 Option model),
//!      plus the `.groups` named-capture surface.
//!
//! Pattern translation + validation (flag prefix, reject backref/lookaround) runs
//! at **transpile time** (the pattern is statically known), so `new_lit` receives
//! an already-Rust-`regex`-syntax pattern and only compiles it. The stateful `g`/
//! `lastIndex`/`exec`-loop and sticky `y` idioms fail loud at transpile time (the
//! `regex` engine is an immutable, stateless value); `matchAll` covers iteration.

/// A compiled JS regex — a newtype over `regex::Regex`. `global` records the JS
/// `g` flag (the emitter also uses it at transpile time to pick `find_all` vs
/// `captures` / `replace_all` vs `replace_first`); it is kept for design fidelity.
pub struct Regex {
    inner: regex::Regex,
    #[allow(dead_code)]
    global: bool,
}

/// One JS match — the positional `[full, g1, g2, …]` array (a non-participating
/// group is `None` → JS `undefined`) plus the participating named groups (backing
/// `match.groups.<name>`).
pub struct Match {
    positional: Vec<Option<String>>,
    named: Vec<(String, String)>,
}

impl Match {
    /// `m[i]` — the `i`-th group (`0` = whole match), `None` for out-of-range or a
    /// non-participating optional group (→ JS `undefined`, the 066 Option model).
    pub fn get(&self, i: f64) -> Option<String> {
        if i < 0.0 {
            return None;
        }
        self.positional.get(i as usize).cloned().flatten()
    }

    /// `m.groups.<name>` — the named group's text, `None` when it did not
    /// participate (→ JS `undefined`).
    pub fn group(&self, name: &str) -> Option<String> {
        self.named
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
    }
}

/// Build a [`Match`] from a `regex::Captures`, reading the named groups off the
/// owning `regex::Regex` (`capture_names`).
fn build_match(re: &regex::Regex, caps: &regex::Captures) -> Match {
    let positional = caps
        .iter()
        .map(|m| m.map(|mm| mm.as_str().to_string()))
        .collect();
    let mut named = Vec::new();
    for name in re.capture_names().flatten() {
        if let Some(m) = caps.name(name) {
            named.push((name.to_string(), m.as_str().to_string()));
        }
    }
    Match { positional, named }
}

impl Regex {
    /// Build a regex from a transpile-time-translated pattern (already carrying an
    /// `(?ims)` inline-flag prefix where needed) and the JS `g` flag. The pattern
    /// was validated at transpile time; a residual `regex-syntax` rejection panics
    /// with a clear message (both runs blow up → the differential still matches).
    pub fn new_lit(pattern_with_flags: &str, global: bool) -> Regex {
        let inner = regex::Regex::new(pattern_with_flags)
            .unwrap_or_else(|e| panic!("regex compile error: {e}"));
        Regex { inner, global }
    }

    /// `re.test(s)` → `bool`.
    pub fn is_match(&self, s: &str) -> bool {
        self.inner.is_match(s)
    }

    /// `re.exec(s)` / `s.match(re)` (no `g`) — the first match as a JS
    /// `RegExpMatchArray | null`.
    pub fn exec(&self, s: &str) -> Option<Match> {
        self.inner.captures(s).map(|c| build_match(&self.inner, &c))
    }

    /// `s.match(re)` (no `g`) — identical to [`Regex::exec`] (first match).
    pub fn captures(&self, s: &str) -> Option<Match> {
        self.exec(s)
    }

    /// `s.match(re)` with the `g` flag — the **full** matches only (JS `g`-match
    /// drops groups), `None` when there is no match (JS returns `null`).
    pub fn find_all(&self, s: &str) -> Option<Vec<String>> {
        let v: Vec<String> = self
            .inner
            .find_iter(s)
            .map(|m| m.as_str().to_string())
            .collect();
        if v.is_empty() {
            None
        } else {
            Some(v)
        }
    }

    /// `s.matchAll(re)` — every match as its `[full, g1, …]` array. A
    /// non-participating group renders as `""` (a documented divergence from JS
    /// `undefined`, in the spirit of the capturing-split divergence).
    pub fn captures_all(&self, s: &str) -> Vec<Vec<String>> {
        self.inner
            .captures_iter(s)
            .map(|caps| {
                caps.iter()
                    .map(|m| m.map(|mm| mm.as_str().to_string()).unwrap_or_default())
                    .collect()
            })
            .collect()
    }

    /// `s.replace(re, repl)` — first match. `repl` is a transpile-time-translated
    /// `regex`-crate replacement template (`${1}` / `${name}` / `${0}` / `$$`).
    pub fn replace_first(&self, s: &str, repl: &str) -> String {
        self.inner.replace(s, repl).into_owned()
    }

    /// `s.replaceAll(re, repl)` / `s.replace(re/g, repl)` — all matches.
    pub fn replace_all(&self, s: &str, repl: &str) -> String {
        self.inner.replace_all(s, repl).into_owned()
    }

    /// `s.split(re)` — split on the pattern (JS's capturing-group-inclusion quirk
    /// is a documented divergence; `regex` drops captured separators).
    pub fn split(&self, s: &str) -> Vec<String> {
        self.inner.split(s).map(|p| p.to_string()).collect()
    }

    /// `s.search(re)` — the **char** index of the first match, `-1.0` if none
    /// (byte→char converted for the 083/098 char-indexed model).
    pub fn search(&self, s: &str) -> f64 {
        match self.inner.find(s) {
            Some(m) => s[..m.start()].chars().count() as f64,
            None => -1.0,
        }
    }
}
