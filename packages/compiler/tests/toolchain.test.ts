/**
 * Specs for the toolchain policy + `ensureToolchain` bootstrap (series 123, issue
 * #121). Detection, consent, and install are exercised through an **injected spawn +
 * prompt seam**, so every spec is hermetic — no spec installs a real toolchain or
 * mutates the machine. One MSRV spec reads the real `Cargo.toml` files (ground
 * truth). IDs → docs/work/123-toolchain-requirements/specs.md (TOOL1–TOOL12).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ResolvedToolchainConfig,
  type SpawnLike,
  TOOLCHAIN_DEFAULTS,
  ToolchainError,
  emittedPinChannel,
  ensureToolchain,
  generateRustToolchainToml,
  normalizeChannelVersion,
  parseRustToolchainToml,
  parseTtrToml,
  resolveToolchainConfig,
} from "../src/toolchain";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

function config(
  over: Partial<ResolvedToolchainConfig> = {},
): ResolvedToolchainConfig {
  return { ...TOOLCHAIN_DEFAULTS, ...over };
}

type SpawnScript = (cmd: string[]) => {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

function recordingSpawn(handler: SpawnScript): {
  spawn: SpawnLike;
  calls: string[][];
} {
  const calls: string[][] = [];
  const spawn: SpawnLike = async (cmd) => {
    calls.push(cmd);
    const r = handler(cmd);
    return {
      exitCode: r.exitCode,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  };
  return { spawn, calls };
}

const quiet = () => {};

const isCargoVersion = (c: string[]) =>
  c[0] === "cargo" && c.includes("--version");
const isRustupVersion = (c: string[]) =>
  c[0] === "rustup" && c.includes("--version");
const isRustupInstall = (c: string[]) =>
  c[0] === "rustup" && c[1] === "toolchain" && c[2] === "install";
const hasNightly = (c: string[]) =>
  c.some((a) => a === "+nightly" || a.startsWith("+nightly-"));

// ── §1 MSRV pinning (TOOL1) ──────────────────────────────────────────────────

describe("TOOL1 MSRV pinning", () => {
  test("workspace pins rust-version=1.85 and a crate inherits it", () => {
    const root = Bun.TOML.parse(
      readFileSync(join(REPO_ROOT, "Cargo.toml"), "utf8"),
    ) as { workspace?: { package?: { "rust-version"?: string } } };
    expect(root.workspace?.package?.["rust-version"]).toBe("1.85");

    const crate = readFileSync(
      join(REPO_ROOT, "crates", "ts-primitives", "Cargo.toml"),
      "utf8",
    );
    expect(crate).toContain("rust-version.workspace = true");
    expect(crate).toContain('edition = "2024"');
  });
});

// ── §2 Config + precedence (TOOL2–TOOL3) ─────────────────────────────────────

describe("TOOL2 config precedence CLI>env>ttr.toml>rust-toolchain.toml>default", () => {
  const layers = {
    cli: { channel: "cli-ch" },
    env: { channel: "env-ch" },
    ttrToml: { channel: "ttr-ch" },
    rustToolchainToml: { channel: "rtc-ch" },
  };

  test("a value set at every layer resolves to the CLI one", () => {
    expect(resolveToolchainConfig(layers).channel).toBe("cli-ch");
  });

  test("removing layers top-down falls through in order", () => {
    expect(resolveToolchainConfig({ ...layers, cli: {} }).channel).toBe(
      "env-ch",
    );
    expect(
      resolveToolchainConfig({ ...layers, cli: {}, env: {} }).channel,
    ).toBe("ttr-ch");
    expect(
      resolveToolchainConfig({ ...layers, cli: {}, env: {}, ttrToml: {} })
        .channel,
    ).toBe("rtc-ch");
    expect(resolveToolchainConfig({}).channel).toBe(TOOLCHAIN_DEFAULTS.channel);
  });

  test("rust-toolchain.toml channel feeds the resolved config", () => {
    const rtc = parseRustToolchainToml({ toolchain: { channel: "nightly" } });
    expect(resolveToolchainConfig({ rustToolchainToml: rtc }).channel).toBe(
      "nightly",
    );
  });
});

describe("TOOL3 no_std config key is rejected fail-loud", () => {
  test("top-level no_std throws naming it", () => {
    let caught: unknown;
    try {
      parseTtrToml({ no_std: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolchainError);
    expect((caught as Error).message).toMatch(/no_std/);
  });

  test("no_std under [toolchain] throws too", () => {
    expect(() => parseTtrToml({ toolchain: { no_std: true } })).toThrow(
      ToolchainError,
    );
  });

  test("a normal ttr.toml parses without throwing", () => {
    const layer = parseTtrToml({
      toolchain: { channel: "stable", msrv: "1.85" },
      facade: { toolchain: "nightly", auto_install: true },
    });
    expect(layer).toMatchObject({
      channel: "stable",
      msrv: "1.85",
      facadeToolchain: "nightly",
      facadeAutoInstall: true,
    });
  });
});

// ── §3 Detection + fail-loud, non-interactive (TOOL4–TOOL6) ──────────────────

describe("TOOL4 cargo present resolves without prompting or installing", () => {
  test("harness resolves; no prompt, no install", async () => {
    const { spawn, calls } = recordingSpawn(() => ({ exitCode: 0 }));
    let prompted = false;
    const res = await ensureToolchain("harness", {
      config: config(),
      spawn,
      isInteractive: true,
      prompt: async () => {
        prompted = true;
        return true;
      },
    });
    expect(res.role).toBe("harness");
    expect(res.channel).toBe("stable");
    expect(prompted).toBe(false);
    expect(calls.some(isRustupInstall)).toBe(false);
  });
});

describe("TOOL5 cargo absent + non-interactive/--no-install fails loud", () => {
  const script: SpawnScript = (c) => ({
    exitCode: isCargoVersion(c) ? 1 : 0,
  });

  test("non-interactive: names the rustup remediation, never prompts/installs", async () => {
    const { spawn, calls } = recordingSpawn(script);
    let prompted = false;
    let caught: unknown;
    try {
      await ensureToolchain("harness", {
        config: config(),
        spawn,
        isInteractive: false,
        prompt: async () => {
          prompted = true;
          return true;
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolchainError);
    expect((caught as Error).message).toMatch(/rustup toolchain install/);
    expect(prompted).toBe(false);
    expect(calls.some(isRustupInstall)).toBe(false);
  });

  test("--no-install even when interactive fails loud", async () => {
    const { spawn, calls } = recordingSpawn(script);
    let caught: unknown;
    try {
      await ensureToolchain("harness", {
        config: config({ noInstall: true }),
        spawn,
        isInteractive: true,
        prompt: async () => true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolchainError);
    expect(calls.some(isRustupInstall)).toBe(false);
  });
});

describe("TOOL6 nightly is required by no role but facade", () => {
  test("harness + emitted resolve on a stable-only toolchain, never probing nightly", async () => {
    for (const role of ["harness", "emitted"] as const) {
      const { spawn, calls } = recordingSpawn(() => ({ exitCode: 0 }));
      const res = await ensureToolchain(role, {
        config: config(),
        spawn,
        isInteractive: false,
      });
      expect(res.channel).toBe("stable");
      expect(calls.some(hasNightly)).toBe(false);
    }
  });

  test("harness + emitted resolve on a nightly-only default toolchain", async () => {
    for (const role of ["harness", "emitted"] as const) {
      const { spawn, calls } = recordingSpawn(() => ({ exitCode: 0 }));
      const res = await ensureToolchain(role, {
        config: config({ channel: "nightly" }),
        spawn,
        isInteractive: false,
      });
      expect(res.channel).toBe("nightly");
      expect(calls.some(hasNightly)).toBe(false);
    }
  });

  test("facade probes +nightly", async () => {
    const { spawn, calls } = recordingSpawn(() => ({ exitCode: 0 }));
    const res = await ensureToolchain("facade", {
      config: config(),
      spawn,
      isInteractive: false,
    });
    expect(res.channel).toBe("nightly");
    expect(res.shim).toEqual(["+nightly"]);
    expect(calls.some(hasNightly)).toBe(true);
  });
});

// ── §4 Interactive install (TOOL7–TOOL9) ─────────────────────────────────────

describe("TOOL7 consent granted installs exactly the resolved rustup command", () => {
  const script: SpawnScript = (c) => ({
    exitCode: isCargoVersion(c) && !isRustupInstall(c) ? 1 : 0,
  });

  test("prompt yes runs rustup toolchain install <channel>, then proceeds", async () => {
    const { spawn, calls } = recordingSpawn(script);
    const res = await ensureToolchain("harness", {
      config: config(),
      spawn,
      isInteractive: true,
      prompt: async () => true,
      log: quiet,
    });
    expect(res.channel).toBe("stable");
    expect(calls).toContainEqual(["rustup", "toolchain", "install", "stable"]);
  });

  test("--yes installs without prompting", async () => {
    const { spawn, calls } = recordingSpawn(script);
    let prompted = false;
    const res = await ensureToolchain("emitted", {
      config: config({ assumeYes: true }),
      spawn,
      isInteractive: false,
      prompt: async () => {
        prompted = true;
        return true;
      },
      log: quiet,
    });
    expect(res.channel).toBe("stable");
    expect(prompted).toBe(false);
    expect(calls).toContainEqual(["rustup", "toolchain", "install", "stable"]);
  });
});

describe("TOOL8 consent declined installs nothing and fails loud", () => {
  test("no install spawned, machine untouched", async () => {
    const { spawn, calls } = recordingSpawn((c) => ({
      exitCode: isCargoVersion(c) ? 1 : 0,
    }));
    let caught: unknown;
    try {
      await ensureToolchain("harness", {
        config: config(),
        spawn,
        isInteractive: true,
        prompt: async () => false,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolchainError);
    expect(calls.some(isRustupInstall)).toBe(false);
  });
});

describe("TOOL9 no cargo and no rustup surfaces rustup-init on consent only", () => {
  const script: SpawnScript = (c) => ({
    exitCode: isCargoVersion(c) || isRustupVersion(c) ? 1 : 0,
  });

  test("non-interactive names rustup-init but never spawns it", async () => {
    const { spawn, calls } = recordingSpawn(script);
    let caught: unknown;
    try {
      await ensureToolchain("emitted", {
        config: config(),
        spawn,
        isInteractive: false,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolchainError);
    expect((caught as Error).message).toMatch(/rustup/);
    expect(calls.some((c) => c.join(" ").includes("sh.rustup.rs"))).toBe(false);
  });

  test("consent spawns the official rustup-init bootstrap", async () => {
    const { spawn, calls } = recordingSpawn(script);
    await ensureToolchain("emitted", {
      config: config(),
      spawn,
      isInteractive: true,
      prompt: async () => true,
      log: quiet,
    });
    expect(calls.some((c) => c.join(" ").includes("sh.rustup.rs"))).toBe(true);
  });
});

// ── §5 Facade nightly gating, generalizes FAC3 (TOOL10–TOOL12) ────────────────

describe("TOOL10 facade + nightly absent + auto_install=false fails loud", () => {
  test("names the nightly toolchain, never prompts or installs", async () => {
    const { spawn, calls } = recordingSpawn((c) => ({
      exitCode: isCargoVersion(c) ? 1 : 0,
    }));
    let prompted = false;
    let caught: unknown;
    try {
      await ensureToolchain("facade", {
        config: config({ facadeAutoInstall: false }),
        spawn,
        isInteractive: true,
        prompt: async () => {
          prompted = true;
          return true;
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolchainError);
    expect((caught as Error).message).toMatch(/nightly/);
    expect(prompted).toBe(false);
    expect(calls.some(isRustupInstall)).toBe(false);
  });
});

describe("TOOL11 facade + auto_install (or --yes) + consent installs nightly", () => {
  const script: SpawnScript = (c) => ({
    exitCode: isCargoVersion(c) && !isRustupInstall(c) ? 1 : 0,
  });

  test("auto_install=true + prompt yes installs rustup toolchain install nightly", async () => {
    const { spawn, calls } = recordingSpawn(script);
    const res = await ensureToolchain("facade", {
      config: config({ facadeAutoInstall: true }),
      spawn,
      isInteractive: true,
      prompt: async () => true,
      log: quiet,
    });
    expect(res.channel).toBe("nightly");
    expect(calls).toContainEqual(["rustup", "toolchain", "install", "nightly"]);
  });

  test("--yes installs nightly without prompting", async () => {
    const { spawn, calls } = recordingSpawn(script);
    const res = await ensureToolchain("facade", {
      config: config({ assumeYes: true }),
      spawn,
      isInteractive: false,
      log: quiet,
    });
    expect(res.channel).toBe("nightly");
    expect(calls).toContainEqual(["rustup", "toolchain", "install", "nightly"]);
  });
});

describe("TOOL12 nightly rust-toolchain.toml is reused for facade, no +nightly shim", () => {
  test("default nightly toolchain resolves facade without a +nightly shim", async () => {
    const { spawn, calls } = recordingSpawn(() => ({ exitCode: 0 }));
    const res = await ensureToolchain("facade", {
      config: config({ channel: "nightly" }),
      spawn,
      isInteractive: false,
    });
    expect(res.channel).toBe("nightly");
    expect(res.shim).toEqual([]);
    expect(calls.some(hasNightly)).toBe(false);
  });
});

// ── §6 rust-toolchain.toml generation for emitted crates (TOOL13–TOOL15) ──────

describe("TOOL13 generateRustToolchainToml pins the channel and round-trips", () => {
  test("emits valid TOML that parseRustToolchainToml reads back to the same channel", () => {
    const content = generateRustToolchainToml({ channel: "1.85.0" });
    const doc = Bun.TOML.parse(content) as {
      toolchain?: { channel?: string };
    };
    expect(doc.toolchain?.channel).toBe("1.85.0");
    expect(parseRustToolchainToml(doc).channel).toBe("1.85.0");
  });

  test("optional components are emitted", () => {
    const content = generateRustToolchainToml({
      channel: "stable",
      components: ["rustfmt", "clippy"],
    });
    const doc = Bun.TOML.parse(content) as {
      toolchain?: { channel?: string; components?: string[] };
    };
    expect(doc.toolchain?.channel).toBe("stable");
    expect(doc.toolchain?.components).toEqual(["rustfmt", "clippy"]);
  });
});

describe("TOOL14 emittedPinChannel defaults to the MSRV as a full version", () => {
  test("the default MSRV (1.85) normalizes to a full 1.85.0 version channel", () => {
    expect(emittedPinChannel(config())).toBe("1.85.0");
  });

  test("a full-version or named MSRV passes through unchanged", () => {
    expect(emittedPinChannel(config({ msrv: "1.86.0" }))).toBe("1.86.0");
    expect(emittedPinChannel(config({ msrv: "stable" }))).toBe("stable");
  });
});

describe("TOOL15 normalizeChannelVersion completes bare major.minor", () => {
  test("major.minor gains a .0 patch; everything else is unchanged", () => {
    expect(normalizeChannelVersion("1.85")).toBe("1.85.0");
    expect(normalizeChannelVersion("1.85.0")).toBe("1.85.0");
    expect(normalizeChannelVersion("stable")).toBe("stable");
    expect(normalizeChannelVersion("nightly-2026-06-19")).toBe(
      "nightly-2026-06-19",
    );
  });
});
