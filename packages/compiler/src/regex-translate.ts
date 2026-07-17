/**
 * Transpile-time JS→Rust regex translation & validation (series 101, epic #56).
 *
 * A regex literal `/pat/flags` (and `new RegExp("lit", "flags")`) is statically
 * known, so the pattern is validated and translated to the Rust `regex` crate's
 * syntax **here**, at transpile time — the point of maximum value: an unsupported
 * construct (backreference / lookahead / lookbehind, or the sticky `y` / indices
 * `d` flag) fails loud with a message *naming the construct*, and is **never**
 * mistranslated. The faithful core (char classes, quantifiers, alternation,
 * anchors, numbered + named + non-capturing groups, word boundaries) is left
 * untouched; the `i`/`m`/`s` flags fold into an inline `(?ims)` prefix.
 *
 * The `regex` crate is a finite-automaton engine: it has no backreferences and no
 * lookaround. That omission is the whole reason this validator exists.
 */

import { UnsupportedError } from "./errors";

/** A translated regex literal: the Rust-`regex`-syntax pattern + the JS `g` flag. */
export interface TranslatedRegex {
  /** The `regex`-crate pattern, carrying an `(?ims)` prefix when flags require it. */
  rustPattern: string;
  /** The JS `g` (global) flag — picks `find_all`/`replace_all` at the call site. */
  global: boolean;
}

/**
 * Validate + translate a JS regex `pattern`/`flags` pair to the Rust `regex`
 * crate. Throws {@link UnsupportedError} naming the construct on a backreference,
 * lookahead, lookbehind, or the sticky `y` / indices `d` flag.
 */
export function translateRegex(pattern: string, flags: string): TranslatedRegex {
  rejectUnsupportedConstructs(pattern);
  const { prefix, global } = translateFlags(flags);
  return { rustPattern: prefix + pattern, global };
}

/**
 * Scan the flag string: `i`/`m`/`s` fold into an `(?ims)` inline prefix, `g`
 * becomes the `global` bit, `u` is a no-op accept (Rust `regex` is Unicode by
 * default). The sticky `y` and indices `d` flags — and any unknown flag — fail
 * loud (they need the stateful/indices model this v1 does not build).
 */
function translateFlags(flags: string): { prefix: string; global: boolean } {
  let global = false;
  let i = false;
  let m = false;
  let s = false;
  for (const f of flags) {
    switch (f) {
      case "g":
        global = true;
        break;
      case "i":
        i = true;
        break;
      case "m":
        m = true;
        break;
      case "s":
        s = true;
        break;
      case "u":
        // Rust `regex` is Unicode-aware by default — `u` is a no-op accept
        // (documented `\d`/`\w` divergence for non-ASCII input, see dialect.md).
        break;
      case "y":
        throw new UnsupportedError({
          type: "the sticky `y` flag (stateful `lastIndex` anchoring) is not modeled — the regex is a stateless value in v1 (use `s.matchAll(re)` for iteration)",
        });
      case "d":
        throw new UnsupportedError({
          type: "the `d` (hasIndices / match `.indices`) flag is not modeled",
        });
      default:
        throw new UnsupportedError({
          type: `unknown regex flag '${f}'`,
        });
    }
  }
  const inline = `${i ? "i" : ""}${m ? "m" : ""}${s ? "s" : ""}`;
  return { prefix: inline ? `(?${inline})` : "", global };
}

/**
 * Reject the constructs the Rust `regex` engine cannot express — naming each one
 * so the failure is actionable and never a silent mistranslation. Scans with
 * escape- and char-class-awareness so a `\(` literal or a `[(?=]` class member is
 * not mistaken for a group.
 */
function rejectUnsupportedConstructs(pattern: string): void {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const next = pattern[i + 1];
      // A backslash followed by 1-9 is a backreference (`\1`); `\0` is a NUL
      // escape, and `\d`/`\w`/`\b`/… are character-class/anchor escapes.
      if (next && next >= "1" && next <= "9") {
        throw new UnsupportedError({
          type: "a backreference (`\\1`) is not supported by the Rust `regex` engine (finite-automaton, no backrefs) — inline the alternation or restructure the pattern",
        });
      }
      // `\k<name>` is a named backreference.
      if (next === "k" && pattern[i + 2] === "<") {
        throw new UnsupportedError({
          type: "a named backreference (`\\k<name>`) is not supported by the Rust `regex` engine",
        });
      }
      i++; // skip the escaped char
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(" && pattern[i + 1] === "?") {
      const third = pattern[i + 2];
      // Lookahead: `(?=…)` / `(?!…)`.
      if (third === "=" || third === "!") {
        throw new UnsupportedError({
          type: `lookahead \`(?${third}…)\` is not supported by the Rust \`regex\` engine (finite-automaton, no lookaround)`,
        });
      }
      // Lookbehind: `(?<=…)` / `(?<!…)`. A `(?<name>…)` named group (letter after
      // `<`) is fine — only `=`/`!` after `<` is lookbehind.
      if (third === "<" && (pattern[i + 3] === "=" || pattern[i + 3] === "!")) {
        throw new UnsupportedError({
          type: "lookbehind `(?<=…)` / `(?<!…)` is not supported by the Rust `regex` engine",
        });
      }
    }
  }
}

/**
 * Translate a JS `String.replace` replacement template to the Rust `regex`
 * crate's `Replacer` string syntax (series 101). Runs at transpile time on a
 * **literal** template, so `` $` `` / `$'` (no `regex` equivalent) fail loud here.
 *
 * | JS         | Rust `regex` |
 * |------------|--------------|
 * | `$1`..`$n` | `${1}`..`${n}` (braced, so a following digit/letter can't extend the name) |
 * | `$<name>`  | `${name}`    |
 * | `$&`       | `${0}`       |
 * | `$$`       | `$$` (literal `$`) |
 * | `` $` ``, `$'` | **fail-loud** |
 */
export function translateReplacement(repl: string): string {
  let out = "";
  let i = 0;
  while (i < repl.length) {
    const c = repl[i];
    if (c !== "$") {
      out += c;
      i++;
      continue;
    }
    const next = repl[i + 1];
    if (next === "$") {
      out += "$$"; // literal `$`
      i += 2;
      continue;
    }
    if (next === "&") {
      out += "${0}"; // whole match
      i += 2;
      continue;
    }
    if (next === "`" || next === "'") {
      throw new UnsupportedError({
        type: "the `` $` `` / `$'` (before-/after-match) replacement specials have no Rust `regex` equivalent",
      });
    }
    if (next === "<") {
      const end = repl.indexOf(">", i + 2);
      if (end !== -1) {
        out += `\${${repl.slice(i + 2, end)}}`;
        i = end + 1;
        continue;
      }
    }
    if (next && next >= "0" && next <= "9") {
      let j = i + 1;
      while (j < repl.length) {
        const d = repl[j];
        if (d === undefined || d < "0" || d > "9") break;
        j++;
      }
      out += `\${${repl.slice(i + 1, j)}}`;
      i = j;
      continue;
    }
    // A lone `$` not starting a recognized special is a literal `$` (JS keeps it
    // literal when it isn't a valid replacement pattern) → `$$` in `regex` syntax.
    out += "$$";
    i++;
  }
  return out;
}
