/**
 * Behavioral fixture coverage (series 030) — the differential tier, driven from
 * fixture files rather than inline strings.
 *
 * For each full-program fixture (one that prints via `console.log`), the emitted
 * Rust must (1) compile and run, and (2) produce byte-identical stdout to the
 * TypeScript run under Bun. The `expected` column pins the value so a fixture
 * that silently changes behavior fails loudly.
 *
 * This complements `compiler.test.ts`: that file curates a hand-picked set of
 * inline differentials proving specific lowering mechanics; this file broadens
 * *breadth* — deeper nesting, recursion, precedence-that-aligns, multi-method
 * classes, matrices — across every shipped feature area.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

/**
 * Behavioral fixtures and their pinned stdout. Each is a complete program whose
 * top-level statements drive the generated `main`. Kept in lockstep with the
 * files under `fixtures/`; a new full-program fixture is added here to earn its
 * differential.
 */
const BEHAVIORAL: ReadonlyArray<readonly [string, string]> = [
  ["01_variables/03_compound_assign", "13"],
  ["01_variables/04_keyword_ident", "7"],
  ["02_control_flow/06_nested_if", "B"],
  ["02_control_flow/07_while_nested_if", "5"],
  ["02_control_flow/08_switch_multi_stmt", "two"],
  ["02_control_flow/09_forof_print", "7\n8\n9"],
  ["03_functions/03_recursion_factorial", "120"],
  ["03_functions/04_recursion_fibonacci", "55"],
  ["03_functions/05_nested_calls", "26"],
  ["03_functions/06_triple_nest", "3"],
  ["03_functions/07_bool_return", "pos"],
  ["03_functions/08_precedence_mix", "26"],
  ["03_functions/09_left_assoc", "5"],
  ["03_functions/10_modulo", "2"],
  ["03_functions/11_negative", "-7"],
  ["03_functions/12_string_concat", "hi ada"],
  ["04_data_structures/04_matrix", "10"],
  ["04_data_structures/05_array_of_structs", "5"],
  ["04_data_structures/06_hashmap_write", "7"],
  ["04_data_structures/07_index_param", "20"],
  ["05_interfaces/02_nested_struct", "3"],
  ["06_classes/02_multi_method", "24"],
  ["06_classes/03_getter_method", "212"],
  ["07_async/02_multi_await", "3"],
  ["10_ownership/05_struct_borrow", "42"],
];

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, `${name}.ts`), "utf8");
}

function runTs(source: string): string {
  const proc = Bun.spawnSync(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(source),
  });
  return new TextDecoder().decode(proc.stdout).trim();
}

describe("behavioral fixtures (tier 2: BEHAVES — differential)", () => {
  for (const [name, expected] of BEHAVIORAL) {
    test(`${name} → ${JSON.stringify(expected)}`, async () => {
      const source = readFixture(name);

      // Reference: the TypeScript itself under Bun.
      const tsStdout = runTs(source);

      // Candidate: emit Rust and run it.
      const rust = emit(
        parseSync(`${name}.ts`, source).program as unknown as Program,
      );
      const rustRun = await runRust(rust);

      expect(rustRun.ok).toBe(true);
      expect(rustRun.stdout.trim()).toBe(tsStdout);
      expect(rustRun.stdout.trim()).toBe(expected);
    });
  }
});
