---
name: 🚦 Release gate
about: A release obligation that BLOCKS the tag — plus the versioned-asset ledger for the milestone.
title: "Release gate: "
labels: release-gate
---

<!--
  PLAYBOOK §5.2. An open `release-gate` issue on a milestone means that milestone CANNOT be
  tagged, even if every feature on it is closed. Assign the milestone — `release-gate` requires
  one, and is mutually exclusive with `idea` / `plan-next` / `experiment`.

  File this the moment you KNOWINGLY defer a release obligation. The deferral is exactly when it
  gets forgotten, because everything still builds locally.

  Open ONE of these per release milestone, at the START of the cycle — the ledger below only
  works if it exists before the work lands.
-->

### What blocks the tag

<!-- One obligation per bullet. Publishing an artifact, reconciling a version line, proving a
     reclose, rotating a credential. Not features — features are ordinary milestone work. -->

- [ ]

### Versioned-asset ledger

<!--
  EVERY independently versioned asset in the project gets a row — not just the ones you touched.
  Fill this in when the milestone opens, defaulting every row to "no change".

  Then UPDATE THE ROW IN THE SAME PASS that lands a change touching that asset. Deciding "does
  this need a bump?" with the change in front of you is reliable; reconstructing it at tag time
  from a diff is not.

  An absent row and a "no change" row look identical at tag time but mean opposite things:
  "verified untouched" vs "never considered". Only the explicit table tells them apart.

  Include internal packages nobody names. They still resolve from a registry, and their failure
  is the quiet one — the version EXISTS, so nothing errors, and the release ships stale source
  behind a correct-looking version number. A publish dry-run does not catch it.
-->

| Asset | Released | Bump needed | Why |
|---|---|---|---|
| | | no change | |

### Verification

<!-- How "releasable" is PROVEN, not assumed. The command / CI check / clean-room build that
     someone can re-run, and what its passing output looks like. Note any check whose evidence
     goes stale (a badge from before a publish is not a live result). -->

### Release order

<!-- Order is usually load-bearing: publish → merge to trunk → tag → close the milestone.
     Note anything here that must happen before/after something else, and why. -->
