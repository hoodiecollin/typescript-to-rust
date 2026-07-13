/**
 * #44 spike — Finding 2 reproduction: `noLib` vs full `lib.d.ts`.
 *
 *   bun run docs/work/044-type-layer-spike/perf.ts
 *
 * Shows the sharp split: annotation-derived receiver types resolve under cheap
 * `noLib`, but inference *through* a built-in method signature (`.get()`'s
 * return type) needs lib.d.ts and costs ~65x more (paid once per compile).
 */

import * as _oxc from "../../../packages/compiler/node_modules/oxc-parser/src-js/index.js";
const parseSync: any = (_oxc as any).parseSync ?? (_oxc as any).default?.parseSync;
import * as _tsmod from "../../../node_modules/typescript/lib/typescript.js";
const ts: any = (_tsmod as any).default ?? _tsmod;

const FILE = "in.ts";
const SRC = `class Store {
  cache: Map<string, number>;
  read(k: string): number | undefined {
    const got = this.cache.get(k);   // lib-typed: Map.get returns V | undefined
    return got;
  }
}`;

function findBySpan(node: any, sf: any, s: number, e: number): any {
  let b: any;
  if (node.getStart(sf) === s && node.getEnd() === e) b = node;
  ts.forEachChild(node, (c: any) => {
    const r = findBySpan(c, sf, s, e);
    if (r) b = r;
  });
  return b;
}

/** Type of the whole `this.cache.get(k)` call expression (the RESULT of .get). */
function getResultType(useLib: boolean): string {
  const parsed = parseSync(FILE, SRC);
  let call: any;
  (function w(n: any) {
    if (!n || typeof n !== "object") return;
    if (n.type === "CallExpression" && n.callee?.property?.name === "get") call = n;
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(w);
      else if (v && typeof v === "object") w(v);
    }
  })(parsed.program);

  let host: any;
  let options: any;
  if (useLib) {
    host = ts.createCompilerHost({ target: ts.ScriptTarget.ES2020 });
    const orig = host.getSourceFile.bind(host);
    host.getSourceFile = (f: string, ...a: any[]) =>
      f === FILE ? ts.createSourceFile(FILE, SRC, ts.ScriptTarget.ES2020, true) : orig(f, ...a);
    host.fileExists = (f: string) => (f === FILE ? true : ts.sys.fileExists(f));
    host.readFile = (f: string) => (f === FILE ? SRC : ts.sys.readFile(f));
    options = { target: ts.ScriptTarget.ES2020 };
  } else {
    const sf = ts.createSourceFile(FILE, SRC, ts.ScriptTarget.Latest, true);
    host = {
      getSourceFile: (f: string) => (f === FILE ? sf : undefined),
      getDefaultLibFileName: () => "lib.d.ts",
      writeFile() {},
      getCurrentDirectory: () => "",
      getDirectories: () => [],
      fileExists: (f: string) => f === FILE,
      readFile: (f: string) => (f === FILE ? SRC : undefined),
      getCanonicalFileName: (f: string) => f,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
    };
    options = { noLib: true, target: ts.ScriptTarget.Latest };
  }
  const program = ts.createProgram([FILE], options, host);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(FILE);
  const node = findBySpan(sf, sf, call.start, call.end);
  return checker.typeToString(checker.getTypeAtLocation(node));
}

console.log("noLib   -> .get() result type:", getResultType(false));
console.log("withLib -> .get() result type:", getResultType(true));
for (const lib of [false, true]) {
  const N = 20;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) getResultType(lib);
  console.log(
    `${lib ? "withLib" : "noLib  "} avg program+checker+query: ${((performance.now() - t0) / N).toFixed(1)} ms (x${N})`,
  );
}
