# ttr brand assets

Marks and lockups for **typescript-to-rust** (`ttr`). Flat SVG, 120-unit grid,
round caps, no gradients.

## Palette

- primary cyan `#14b8c6` (the TS side) · accent rust `#d2542a` (the Rust side)
- deep `#0b6f79` · ink `#0f1115`

The **mark** is two combs interlocking tooth-for-tooth — a cyan TS side (two
teeth) and a rust Rust side (one tooth in the gap). Keep the 4-unit gap. The
**wordmark** is `ttr` in JetBrains Mono 700, with the long form
`typescript-to-rust` in JetBrains Mono 400 tracked +2.6.

## Files

| file | use |
|---|---|
| `ttr/ttrmark-primary.svg` | icon / favicon / package icon, any background |
| `ttr/ttrmark-mono.svg` | single-ink on light |
| `ttr/ttrmark-mono-inverse.svg` | single-ink on dark |
| `ttr/ttr-horizontal-{light,dark,mono}.svg` | mark + wordmark + descriptor |
| `ttr/ttr-stacked-{light,dark,mono}.svg` | centred, for square slots |

Use the `-light` variant on light backgrounds and `-dark` on dark ones (the
README picks per theme via `<picture>`). Mono lockups fill with `currentColor` —
set `color` on the parent and they follow.

## A note on the lockups

The `-horizontal-*` and `-stacked-*` wordmarks are **outlined** — the JetBrains
Mono `ttr` (700) and `typescript-to-rust` (400) text has been converted to
`<path>` geometry, so every lockup renders identically on any device without the
font installed. To re-typeset (change the wording or tracking), edit the original
live-`<text>` versions from git history and re-outline. The icon marks are pure
geometry and were always font-free.
