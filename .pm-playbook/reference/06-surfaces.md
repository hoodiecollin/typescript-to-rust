<!-- Generated from PLAYBOOK.md §6. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

## 6. Surfaces — the delivery axis (`surface:*` labels)

A **Surface** designates a *distinct, independently shippable product surface* — a face of the
product a user touches (core lib, IDE extension, marketing site), one that may have its **own
release cadence and tag namespace**. Modeled as **labels**, only when a repo **ships more than one
artifact**; a single-artifact repo has one implicit surface (`core`) and needs no labels.

> **Why "surface," not "channel":** *"release channel"* already means a **stability stream**
> (stable / beta / nightly / canary) — an orthogonal concept that must stay separable (you can
> ship a beta *of* the extension). A Surface is a shippable *face*, not a maturity tier. And
> **"workstream" is retired** — it conflated the surface axis with subsystem decomposition.

| Surface label | Color | Covers |
|---|---|---|
| `surface:core` *(often implicit/default)* | `#1d76db` | The primary product line (core `v*` releases). |
| `surface:ide-extension` | `#007ACC` | Editor extension + language server (ships on its **own** `ext-v*` / `vscode-v*` tag line). |
| `surface:website` | `#1d76db` | Marketing + docs site (usually continuously deployed, no version tag). |
| `surface:cli` / `surface:sdk` | `#1d76db` | Any other independently shipped user-facing artifact. |

> **`ci` is *not* a surface** — CI/build tooling ships nothing to a user. It's just a labeled
> concern (`ci`), not a delivery surface. The test is "is a user touching this thing?"

### 6.1 The surface-exclusion rule (load-bearing)

**Never put a non-core `surface:*` issue on a core `v*` milestone.** A `surface:website` or
`surface:ide-extension` issue milestoned onto `v0.5.0` would read as *"done — awaiting v0.5.0"*
even though it already shipped on its own line, and it would never appear in the core changelog.
Non-core surfaces:

- ship on their **own release line / tag namespace** (or deploy continuously);
- are **excluded from the core roadmap and changelog** by a scope filter on their `surface:*`
  label;
- get their **own milestones** in their own namespace if they version at all (e.g. `ext-v0.1.0`).

The **Surface Board** view groups by these labels.
