#!/usr/bin/env bun
/**
 * session-info — report metadata about the current Claude Code session.
 *
 * Reads the current session's transcript JSONL (located via
 * CLAUDE_CODE_SESSION_ID, falling back to the most-recently-modified
 * transcript) and reports context-window usage plus other useful metadata.
 *
 * Output is JSON by default; pass `--text` for a human-readable summary.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Known context-window sizes (tokens) by model-id prefix. Default 200k. */
const CONTEXT_WINDOWS: Array<[prefix: string, tokens: number]> = [
  ["claude-opus-4", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-haiku-4", 200_000],
  ["claude-fable-5", 200_000],
];
const DEFAULT_CONTEXT_WINDOW = 200_000;

function contextWindowFor(model: string | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  for (const [prefix, tokens] of CONTEXT_WINDOWS) {
    if (model.startsWith(prefix)) return tokens;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/** Find `<sessionId>.jsonl` anywhere under ~/.claude/projects. */
async function findTranscriptBySessionId(
  sessionId: string,
): Promise<string | undefined> {
  const projectDirs = await readdir(PROJECTS_DIR, { withFileTypes: true });
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const candidate = join(PROJECTS_DIR, d.name, `${sessionId}.jsonl`);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // not in this project dir
    }
  }
  return undefined;
}

/** Fallback: the most-recently-modified transcript across all projects. */
async function findNewestTranscript(): Promise<string | undefined> {
  const projectDirs = await readdir(PROJECTS_DIR, { withFileTypes: true });
  let best: { path: string; mtimeMs: number } | undefined;
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const dir = join(PROJECTS_DIR, d.name);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dir, f);
      const s = await stat(p);
      if (!best || s.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: s.mtimeMs };
    }
  }
  return best?.path;
}

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type Record = {
  type?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  userType?: string;
  timestamp?: string;
  message?: { model?: string; usage?: Usage };
};

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function bar(fraction: number, width = 24): string {
  const filled = Math.min(width, Math.max(0, Math.round(fraction * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function main() {
  const asText = process.argv.includes("--text");
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;

  let transcript: string | undefined;
  if (sessionId) transcript = await findTranscriptBySessionId(sessionId);
  transcript ??= await findNewestTranscript();

  if (!transcript) {
    console.error("session-info: could not locate a transcript JSONL.");
    process.exit(1);
  }

  const raw = await readFile(transcript, "utf8");
  const lines = raw.split("\n");

  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let model: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let userType: string | undefined;
  let userMessages = 0;
  let assistantMessages = 0;
  let cumulativeOutputTokens = 0;
  let lastUsage: Usage | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: Record;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (rec.cwd) cwd = rec.cwd;
    if (rec.gitBranch) gitBranch = rec.gitBranch;
    if (rec.version) version = rec.version;
    if (rec.userType) userType = rec.userType;
    if (rec.timestamp) {
      firstTimestamp ??= rec.timestamp;
      lastTimestamp = rec.timestamp;
    }
    if (rec.type === "user") userMessages++;
    if (rec.type === "assistant") {
      assistantMessages++;
      const usage = rec.message?.usage;
      if (rec.message?.model) model = rec.message.model;
      if (usage) {
        lastUsage = usage;
        cumulativeOutputTokens += usage.output_tokens ?? 0;
      }
    }
  }

  const window = contextWindowFor(model);
  const promptTokens =
    (lastUsage?.input_tokens ?? 0) +
    (lastUsage?.cache_creation_input_tokens ?? 0) +
    (lastUsage?.cache_read_input_tokens ?? 0);
  const lastOutput = lastUsage?.output_tokens ?? 0;
  // Context occupied entering the next turn: prior prompt + the reply just produced.
  const contextUsed = promptTokens + lastOutput;
  const contextRemaining = Math.max(0, window - contextUsed);
  const pctUsed = window > 0 ? contextUsed / window : 0;

  const report = {
    sessionId: sessionId ?? null,
    transcript,
    model: model ?? null,
    contextWindow: {
      total: window,
      used: contextUsed,
      remaining: contextRemaining,
      percentUsed: Math.round(pctUsed * 1000) / 10,
      breakdown: {
        promptTokens,
        input: lastUsage?.input_tokens ?? 0,
        cacheRead: lastUsage?.cache_read_input_tokens ?? 0,
        cacheCreation: lastUsage?.cache_creation_input_tokens ?? 0,
        lastOutput,
      },
    },
    messages: { user: userMessages, assistant: assistantMessages },
    cumulativeOutputTokens,
    cwd: cwd ?? null,
    gitBranch: gitBranch ?? null,
    cliVersion: version ?? null,
    userType: userType ?? null,
    startedAt: firstTimestamp ?? null,
    lastActivityAt: lastTimestamp ?? null,
  };

  if (!asText) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const lines_out = [
    `Session      ${report.sessionId ?? "(unknown)"}`,
    `Model        ${report.model ?? "(unknown)"}`,
    `CLI version  ${report.cliVersion ?? "?"}`,
    ``,
    `Context      ${bar(pctUsed)}  ${report.contextWindow.percentUsed}%`,
    `             ${fmt(contextUsed)} / ${fmt(window)} used · ${fmt(contextRemaining)} remaining`,
    `             (prompt ${fmt(promptTokens)} — input ${fmt(report.contextWindow.breakdown.input)}, ` +
      `cache-read ${fmt(report.contextWindow.breakdown.cacheRead)}, ` +
      `cache-write ${fmt(report.contextWindow.breakdown.cacheCreation)}; last reply ${fmt(lastOutput)})`,
    ``,
    `Messages     ${report.messages.user} user · ${report.messages.assistant} assistant`,
    `Output total ${fmt(cumulativeOutputTokens)} tokens generated this session`,
    `Directory    ${report.cwd ?? "?"}  (git: ${report.gitBranch ?? "?"})`,
    `Started      ${report.startedAt ?? "?"}`,
    `Last active  ${report.lastActivityAt ?? "?"}`,
  ];
  console.log(lines_out.join("\n"));
}

main().catch((err) => {
  console.error("session-info: unexpected error:", err);
  process.exit(1);
});
