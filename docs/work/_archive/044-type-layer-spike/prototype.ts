/**
 * #44 spike — oxc ⇄ tsc coupling prototype (runnable).
 *
 *   bun run docs/work/044-type-layer-spike/prototype.ts
 *
 * Proves the coupling boundary the issue asks about: take an oxc AST node's
 * span, find the matching TypeScript-checker node, and answer
 * `getTypeAtLocation` for receiver shapes our hand-rolled `collectionOf`
 * (`lower.ts`, Identifier-only) cannot resolve — `this.field`, `local`, and a
 * `getX()` **CallExpression** receiver.
 *
 * Findings live in `findings.md` next to this file. This is a SPIKE artifact,
 * not wired into the pipeline; it exists so the eventual impl starts from a
 * working boundary rather than a guess.
 *
 * IMPORTANT (operational trap, see findings): under Bun the bare specifier
 * `"typescript"` resolves to a v7.0.2 *native shim* (`version.cjs`) with NO
 * compiler API. We pin the workspace's real v5.9.3 JS API by explicit path.
 */

// Both deps pinned by explicit workspace path so this spike artifact runs from
// repo root without living inside `packages/compiler` (oxc-parser is a compiler
// workspace dep; typescript's bare specifier is hijacked — see the note above).
import * as _oxc from "../../../packages/compiler/node_modules/oxc-parser/src-js/index.js";
const parseSync: any = (_oxc as any).parseSync ?? (_oxc as any).default?.parseSync;
// The real TS compiler API (v5.9.3), pinned by path — NOT the bare specifier.
import * as _tsmod from "../../../node_modules/typescript/lib/typescript.js";
const ts: any = (_tsmod as any).default ?? _tsmod;

const FILE = "in.ts";

/** Build a single in-memory Program + checker over `src`. */
function makeChecker(src: string, useLib: boolean) {
  if (useLib) {
    // Real lib.d.ts loaded from disk — needed only for inference *through*
    // built-in method signatures (e.g. what `.get()` returns). ~65x costlier.
    const host = ts.createCompilerHost({ target: ts.ScriptTarget.ES2020 });
    const orig = host.getSourceFile.bind(host);
    host.getSourceFile = (f: string, ...a: any[]) =>
      f === FILE ? ts.createSourceFile(FILE, src, ts.ScriptTarget.ES2020, true) : orig(f, ...a);
    host.fileExists = (f: string) => (f === FILE ? true : ts.sys.fileExists(f));
    host.readFile = (f: string) => (f === FILE ? src : ts.sys.readFile(f));
    const program = ts.createProgram([FILE], { target: ts.ScriptTarget.ES2020 }, host);
    return { checker: program.getTypeChecker(), sf: program.getSourceFile(FILE) };
  }
  // noLib — cheap (~1ms). Resolves types from *explicit annotations* only;
  // inference through lib method signatures collapses to `any`.
  const sf = ts.createSourceFile(FILE, src, ts.ScriptTarget.Latest, true);
  const host: any = {
    getSourceFile: (f: string) => (f === FILE ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (f: string) => f === FILE,
    readFile: (f: string) => (f === FILE ? src : undefined),
    getCanonicalFileName: (f: string) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram([FILE], { noLib: true, target: ts.ScriptTarget.Latest }, host);
  return { checker: program.getTypeChecker(), sf };
}

/**
 * The coupling primitive: find the tsc node whose [getStart, getEnd] matches an
 * oxc span. oxc and tsc both count in UTF-16 code units, so spans align with no
 * translation (see findings — verified across accents + surrogate-pair emoji).
 */
function findBySpan(node: any, sf: any, start: number, end: number): any {
  let best: any;
  if (node.getStart(sf) === start && node.getEnd() === end) best = node;
  ts.forEachChild(node, (c: any) => {
    const r = findBySpan(c, sf, start, end);
    if (r) best = r;
  });
  return best;
}

function walk(n: any, f: (n: any) => void) {
  if (!n || typeof n !== "object") return;
  if (typeof n.type === "string") f(n);
  for (const k of Object.keys(n)) {
    const v = n[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, f));
    else if (v && typeof v === "object") walk(v, f);
  }
}

/** For every `.get(k)`/`.has(k)`, resolve the receiver's type through tsc. */
function resolveReceivers(src: string, useLib = false) {
  const parsed = parseSync(FILE, src);
  const { checker, sf } = makeChecker(src, useLib);
  const out: { text: string; type: string }[] = [];
  walk(parsed.program, (n) => {
    if (
      n.type === "CallExpression" &&
      n.callee?.type === "MemberExpression" &&
      (n.callee.property?.name === "get" || n.callee.property?.name === "has")
    ) {
      const recv = n.callee.object;
      const node = findBySpan(sf, sf, recv.start, recv.end);
      const type = node
        ? checker.typeToString(checker.getTypeAtLocation(node))
        : "<no tsc node @span>";
      out.push({ text: src.slice(recv.start, recv.end), type });
    }
  });
  return out;
}

// ── Demo: the three receiver shapes `collectionOf` returns null for ──────────
const SRC = `class Store {
  cache: Map<string, number>;
  constructor() { this.cache = new Map(); }
  read(k: string): number {
    const local: Map<string, number> = this.cache;
    const a = this.cache.get(k);     // this.field   — collectionOf: null
    const b = local.get(k);          // local        — collectionOf: ok (identifier)
    const c = this.getMap().get(k);  // getX() call  — collectionOf: null
    return 0;
  }
  getMap(): Map<string, number> { return this.cache; }
}`;

console.log("receiver types via tsc (noLib, from annotations):");
for (const r of resolveReceivers(SRC, false)) {
  console.log(`  ${r.text.padEnd(16)} -> ${r.type}`);
}
