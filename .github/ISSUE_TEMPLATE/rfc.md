---
name: 📐 Design-doc (RFC)
about: Gate 1 — the WHAT & WHY of a non-trivial change, captured AS AN ISSUE. Design is never a committed file.
title: "RFC: "
labels: rfc, idea
---

<!--
  Gate 1 of the design → plan → spec doctrine (PLAYBOOK §4.1).
  This is SOLUTION-shaped, not CODE-shaped: describe behavior and the shape of the
  solution. File lists / build order / signatures belong in the IMPLEMENTATION-PLAN (Gate 2),
  not here. Do NOT commit a proposal-*.md file — this issue IS the design.
  When it ships: fold durable parts into ARCHITECTURE.md and CLOSE this issue.
-->

### Summary
<!-- What is being proposed, in a paragraph. -->

### Motivation / problem
<!-- Why now? What breaks or is missing without this? -->

### Desired behavior
<!-- What the system should DO, observably. The seed of the BDD scenarios. -->

### Solution shape
<!-- The approach and the key abstractions. No file-by-file detail yet. -->

### Alternatives considered
<!-- Other approaches and why they were not chosen. -->

### Non-goals & limits
<!-- What this explicitly does NOT do. Where WHAT_IT_IS.md would need updating. -->

### Gotchas surfaced
<!-- Conceptual risks this design review uncovered. -->

### Decision
<!-- On accept: drop `idea`, add `plan-next`, and proceed to the implementation-plan (Gate 2). -->
