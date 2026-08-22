---
name: 🧭 Epic
about: An umbrella issue coordinating a set of child issues.
title: "Epic: "
labels: epic
---

> ## ✅ Decisions locked (YYYY-MM-DD)
> <!-- Settled decisions, newest appended with their own date. This block SUPERSEDES any
>      stale discussion further down. Each decision gets a ✅ and a one-line rationale. -->
> - **Decision:** … — ✅ rationale.

### In plain English
<!-- What this epic delivers, for a reader who has never seen it. Mark **release-blocking**
     here if it gates a release. Same heading every issue uses — an epic is read by the same
     tooling its children are (PLAYBOOK §9.6). -->

## Current state (ground truth)
<!-- Where the CODE actually is right now — not intentions. Update this as reality moves.
     If a claim here can't be pointed at code/commits, it doesn't belong. -->

## Children
<!-- Link children as GitHub NATIVE sub-issues (Parent issue / Sub-issues progress), NOT as
     task-list checkboxes (drift-prone) and NOT via a Project field.
       gh api repos/OWNER/REPO/issues/N/sub_issues -f sub_issue_id=<child REST id>
     Each child carries its OWN milestone; the epic may span releases. The Sub-issues progress
     bar rolls them up automatically. -->

## Upstream / downstream
<!-- Relationships to other epics: "upstream of #___ — its decisions determine …" -->

## Surface
<!-- Only for multi-artifact repos: surface:core / surface:website / surface:ide-extension.
     Non-core surface work must NOT be milestoned onto a core v* release (PLAYBOOK §6.1). -->
