<!-- Generated from PLAYBOOK.md §10. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

## 10. Documentation discipline

- **Design docs live as `rfc` issues, not files** (§9). Filing one is a small workflow: a dedup
  check against existing issues, the body template, and the epic cross-link.
- **Two roadmap docs**, both deferring to Issues as authoritative:
  - **`VERSION_ROADMAP.md`** — the *honest state* of the current release effort: situation →
    scope (locked) → complete → still deferred.
  - **`WHAT_IT_IS.md`** — an "is / isn't" account: per-feature guarantees *and* honest limits,
    with a standing *"verify maturity claims against the code"* and *"where the README
    over-promises, this doc wins."*
- **`CONTRIBUTING.md`** states the two-axis model, the label ladder + invariants, the design→plan→
  spec doctrine, and the RFC-as-issue rule. It's where a newcomer learns the system.
