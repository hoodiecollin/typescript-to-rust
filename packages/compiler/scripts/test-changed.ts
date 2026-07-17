#!/usr/bin/env bun
/**
 * `bun run test:changed` — the fast LOCAL dev loop.
 *
 * Runs only the differential/test files you've changed, so you get quick
 * feedback while iterating on one area instead of monitoring the whole suite.
 *
 * This is NOT the regression gate. The compiler is a shared dependency of every
 * fixture (~738 specs across 99 files), so a change to `src/**` or `crates/**`
 * can regress ANY spec — a subset run can't prove that. Only the full batched
 * suite (`bun run test`, or `bun run check`) is the gate. Use this to iterate,
 * then run the full suite before you call the work done.
 *
 * "Changed" = tracked edits vs HEAD + untracked files in your working tree. Any
 * extra args are forwarded to `bun test` (e.g. `bun run test:changed -t "RE-1"`).
 */

import { $ } from "bun";

const TEST_RE = /^packages\/compiler\/tests\/.*\.test\.ts$/;
// A change under either of these can regress arbitrary specs → subset is unsafe
// as a gate.
const SRC_RE = /^(packages\/compiler\/src\/|crates\/)/;

async function changedFiles(): Promise<string[]> {
  // `diff --name-only HEAD` covers both staged and unstaged edits to tracked
  // files; `ls-files --others` adds untracked (new) files. Together: the whole
  // working-tree delta.
  const [tracked, untracked] = await Promise.all([
    $`git diff --name-only HEAD`.text(),
    $`git ls-files --others --exclude-standard`.text(),
  ]);
  const seen = new Set<string>();
  for (const block of [tracked, untracked]) {
    for (const line of block.split("\n")) {
      const f = line.trim();
      if (f) seen.add(f);
    }
  }
  return [...seen];
}

const changed = await changedFiles();
const tests = changed.filter((f) => TEST_RE.test(f)).sort();
const srcChanged = changed.some((f) => SRC_RE.test(f));

if (tests.length === 0) {
  if (srcChanged) {
    console.error(
      "compiler source changed but no test files did — a subset can't prove " +
        "regression. Run the full suite: bun run test",
    );
  } else {
    console.error("No changed test files. (Full gate: bun run test)");
  }
  process.exit(0);
}

if (srcChanged) {
  console.error(
    `⚠️  compiler source changed — running ${tests.length} changed test file(s) for quick feedback, but this is NOT a full regression. Run \`bun run test\` before finishing.\n`,
  );
} else {
  console.error(`Running ${tests.length} changed test file(s):\n`);
}
for (const t of tests) console.error(`  ${t}`);
console.error("");

const passthru = process.argv.slice(2);
const proc = Bun.spawn(["bun", "test", ...tests, ...passthru], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await proc.exited);
