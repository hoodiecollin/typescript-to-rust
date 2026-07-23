/**
 * `@ttr/plugin-leftpad` — the reference third-party plugin (epic #95, series 110).
 *
 * The **TS half** of the plugin (design §4, bilingual from v1). Like `@ttr/std`,
 * `leftPad` is an **intrinsic**: the compiler recognizes it *by the reserved import
 * specifier* `"@ttr/plugin-leftpad"` (never a name heuristic) and expands a call to
 * a core-HIR `ttr_plugin_leftpad::left_pad` call into the plugin's Rust crate. The
 * TS body here exists so the differential oracle (which runs the input TS under
 * Bun) executes real, faithful behavior that matches the emitted Rust. A user's own
 * `leftPad` imported from anywhere else is *not* hijacked.
 *
 * `leftPad(s, width, fill)` is JS `String.prototype.padStart(width, fill)`: a
 * multi-char `fill` is cycled and truncated to the deficit, and a string already
 * at/over `width` is returned unchanged. (The Rust side counts `char`s where JS
 * counts UTF-16 code units — identical for non-astral input, per the dialect's
 * char-indexed string model, series 098.)
 */
export function leftPad(s: string, width: number, fill: string): string {
  return s.padStart(width, fill);
}
