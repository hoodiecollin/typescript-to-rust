---
name: session-info
description: Report metadata about the current Claude Code session — context-window usage (used / remaining / %), model, message counts, tokens generated, git branch, CLI version, and session timing. Use when the user asks about context window size, how much context is left, session stats, or "session info / metadata".
---

# session-info

Reports metadata about the **current** Claude Code session by parsing its
transcript JSONL. The most important field is **context-window usage**.

## How to run it

Run the bundled script from the repo root with bun and show the user its output:

```bash
bun run .claude/skills/session-info/session-info.ts --text
```

- `--text` → human-readable summary (default when reporting to the user).
- omit `--text` → JSON, when the user wants raw data or you need to compute on it.

The script locates the transcript itself via `CLAUDE_CODE_SESSION_ID` (falling
back to the most-recently-modified transcript under `~/.claude/projects`), so no
arguments are needed.

## What it reports

- **Context window**: total for the model, tokens used, tokens remaining, and
  percent used — with a breakdown (prompt = input + cache-read + cache-write,
  plus the last reply's output tokens).
- **Model** and **CLI version**.
- **Messages**: user vs. assistant counts.
- **Cumulative output tokens** generated this session.
- **Working directory** and **git branch**.
- **Started / last-active** timestamps.

## Notes on accuracy

- Context usage is derived from the **last assistant turn's** `usage` block in
  the transcript, so it reflects the state as of the previous reply — it won't
  include the tokens of the request currently being processed.
- Context-window totals are a lookup table keyed by model id (default 200,000).
  If the running model uses an extended/beta window, edit `CONTEXT_WINDOWS` in
  `session-info.ts`.
- For the live, authoritative context gauge, the built-in `/context` command is
  the ground truth; this skill is a scriptable, parseable complement.
