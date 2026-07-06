# 038 — Specs: complete move coverage

Differential oracle (compile + stdout match) plus emitted-Rust clone-placement
assertions. Every case is a shape that hit `E0382`/`E0507` before this series.

## Move-through-store (a name moved into an owning position)

- **A** struct literal capturing a reused movable → clones the field value.
- **B** array literal capturing a reused movable → clones the element.
- **E** by-value method argument (`Vec.push`) of a reused movable → cloned.
- **G(assign)** an assignment whose value is a reused movable → cloned.
- **negative** a move-into-store that is the *last* use stays bare (no needless clone).

## Move-out-of-place (a projection read by value)

- **D** a non-Copy field read into a `let` clones when the base is reused (partial move).
- **F** a non-Copy index read into a `let` clones (cannot move out of index).
- **negative** a Copy field/index read is not cloned.
- **negative** a field read whose owned-local base is not reused stays a bare partial move.

## Move-out-of-borrow (projection in non-let positions)

- **G1** a field out of a *borrowed* struct param clones even when not reused (`E0507`).
- **G2** returning a field of a borrowed struct param clones it.
- **G3** returning an index element clones it (cannot move out of index).
- **G4** a field projection passed as an owned argument is cloned.
- **negative** returning a field of an *owned local* (not reused) stays a bare move.

## Combined (probed, behave end-to-end)

Constructor storing a reused param (two fields); `push` a struct then reuse it; a
nested field (`o.inner.name`) out of a borrowed param; a loop moving a struct into a
growing `Vec`. All compile and match the TS run.

## Fail-loud

The pass only *adds* clones. A projection the type environment can't resolve, or a
shape not covered, stays a bare move that cargo rejects loudly — never a wrong value.
