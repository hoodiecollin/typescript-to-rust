---
name: 🛠️ Implementation-plan
about: Gate 2 — the HOW, written AFTER the design-doc is accepted and BEFORE any code.
title: "Plan: "
labels: plan-next
---

<!--
  Gate 2 of the design → plan → spec doctrine (PLAYBOOK §4.1).
  Precondition: an ACCEPTED design-doc (Gate 1) exists — link it below.
  This is CODE-shaped: it turns the accepted design into an ordered build.
  Its job is to surface EXECUTION gotchas before coding starts.
  Often this lives as a section/comment on the tracking issue rather than a separate issue.
-->

### Design-doc
<!-- Link the accepted RFC this plan implements: #___ -->

### Files to create / modify
<!-- Concrete paths, each with a one-line note on what changes. -->
- `path/to/file` — …

### Build order
<!-- The sequence of steps. Each step should be independently reviewable / testable. -->
1. …

### Interfaces / signatures
<!-- The new/changed public shapes: function signatures, types, routes, schema. -->

### Dependencies & blockers
<!-- What must exist first (substrate, other issues). Link blocking issues. -->

### BDD scenarios (Gate 3 seed)
<!-- The executable acceptance criteria to write FIRST (RED), then implement to GREEN.
     Given/When/Then. These are the definition of done. -->
- **Given** … **When** … **Then** …

### Execution gotchas
<!-- Ordering hazards, migration concerns, interface mismatches surfaced while planning. -->
