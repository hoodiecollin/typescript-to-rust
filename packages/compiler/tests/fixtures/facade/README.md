# facade generator fixtures (series 122)

`ttr-facade-fixture.rustdoc.json` is the captured rustdoc JSON of the reference
crate `crates/ttr-facade-fixture` (which re-exports `crates/ttr-facade-fixture-inner`).
It is the hermetic input for the FAC1–FAC15 specs — the generator's analog of
`@ttr/plugin-leftpad`.

**Pinned:** `format_version: 57`, emitted by `nightly-1.98.0` (2026-06-19).

## Regenerate

```sh
cargo +nightly rustdoc -p ttr-facade-fixture -- -Zunstable-options --output-format json
# normalize machine-specific paths, then overwrite the fixture:
bun -e 'const j=await Bun.file("target/doc/ttr_facade_fixture.json").json();
  for (const k of Object.keys(j.external_crates)) j.external_crates[k].path=null;
  j.crate_version=null;
  await Bun.write("packages/compiler/tests/fixtures/facade/ttr-facade-fixture.rustdoc.json", JSON.stringify(j,null,1)+"\n")'
```

Normalization nulls the absolute `.rmeta` paths in `external_crates` (machine-specific)
so the fixture is deterministic across machines. If a toolchain bump changes
`format_version`, update the pin in `docs/work/122-ttr-facade-generator/design.md`
(§Engine mechanics + §Ground-truth schema) in the same change.

The live integration spec (FAC3) re-runs the command above and asserts this captured
file is still current; it skips loudly when no nightly rustdoc-json toolchain is present.
