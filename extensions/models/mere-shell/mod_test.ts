// ABOUTME: Unit tests for mere-shell extension model.
// ABOUTME: Validates version resolution, binary caching, and command execution flow.
import { assertEquals } from "jsr:@std/assert";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./mod.ts";

Deno.test("run - resolves latest version and executes command", async () => {
  const originalFetch = globalThis.fetch;
  const originalCommand = Deno.Command;
  const originalStat = Deno.stat;
  const originalLstat = Deno.lstat;
  const originalMkdir = Deno.mkdir;
  const originalWriteFile = Deno.writeFile;
  const originalWriteTextFile = Deno.writeTextFile;
  const originalEnvGet = Deno.env.get;

  // Mock fetch - Codeberg API + binary download + config/key
  globalThis.fetch = (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/releases/latest")) {
      return Promise.resolve(
        new Response(JSON.stringify({ tag_name: "v0.15.2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.includes("/releases/download/")) {
      return Promise.resolve(
        new Response(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), { status: 200 }),
      );
    }
    if (url.includes("config.kdl")) {
      return Promise.resolve(new Response("repo \"mere\" {}", { status: 200 }));
    }
    if (url.includes("mere.pub")) {
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      );
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };

  // Mock Deno.stat to simulate "not cached" then "store doesn't exist"
  // deno-lint-ignore no-explicit-any
  (Deno as any).stat = (_path: string) => {
    return Promise.reject(new Deno.errors.NotFound("not found"));
  };

  // deno-lint-ignore no-explicit-any
  (Deno as any).lstat = (_path: string) => {
    return Promise.reject(new Deno.errors.NotFound("not found"));
  };

  // deno-lint-ignore no-explicit-any
  (Deno as any).mkdir = (_path: string, _opts?: Deno.MkdirOptions) => {
    return Promise.resolve();
  };

  // deno-lint-ignore no-explicit-any
  (Deno as any).writeFile = (
    _path: string,
    _data: Uint8Array,
    _opts?: Deno.WriteFileOptions,
  ) => {
    return Promise.resolve();
  };

  // deno-lint-ignore no-explicit-any
  (Deno as any).writeTextFile = (_path: string, _data: string) => {
    return Promise.resolve();
  };

  // deno-lint-ignore no-explicit-any
  (Deno.env as any).get = (key: string) => {
    if (key === "SWAMP_REPO_DIR") return "/tmp/test-swamp";
    return undefined;
  };

  // Mock Deno.Command to simulate a successful mere shell run
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    constructor(
      _cmd: string,
      _opts: Deno.CommandOptions,
    ) {}
    output() {
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: new TextEncoder().encode("Build Summary 27/27\n"),
        stderr: new TextEncoder().encode(""),
      });
    }
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { mereVersion: "latest", mereRoot: "", useHostStore: false },
      methodName: "run",
    });

    const result = await model.methods.run.execute(
      { packages: ["zig"], command: "zig build test", workdir: undefined },
      context,
    );
    assertEquals(result.dataHandles.length, 1);

    const resources = getWrittenResources();
    // deno-lint-ignore no-explicit-any
    const data = resources[0].data as any;
    assertEquals(data.success, true);
    assertEquals(data.exitCode, 0);
    assertEquals(data.mereVersion, "0.15.2");
    assertEquals(data.packages, ["zig"]);
    assertEquals(data.command, "zig build test");
    assertEquals(data.stdout, "Build Summary 27/27\n");
    assertEquals(typeof data.durationMs, "number");
  } finally {
    globalThis.fetch = originalFetch;
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
    // deno-lint-ignore no-explicit-any
    (Deno as any).stat = originalStat;
    // deno-lint-ignore no-explicit-any
    (Deno as any).lstat = originalLstat;
    // deno-lint-ignore no-explicit-any
    (Deno as any).mkdir = originalMkdir;
    // deno-lint-ignore no-explicit-any
    (Deno as any).writeFile = originalWriteFile;
    // deno-lint-ignore no-explicit-any
    (Deno as any).writeTextFile = originalWriteTextFile;
    // deno-lint-ignore no-explicit-any
    (Deno.env as any).get = originalEnvGet;
  }
});

Deno.test("run - handles command failure gracefully", async () => {
  const originalFetch = globalThis.fetch;
  const originalCommand = Deno.Command;
  const originalStat = Deno.stat;
  const originalLstat = Deno.lstat;
  const originalMkdir = Deno.mkdir;
  const originalWriteFile = Deno.writeFile;
  const originalWriteTextFile = Deno.writeTextFile;
  const originalEnvGet = Deno.env.get;

  globalThis.fetch = (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/releases/latest")) {
      return Promise.resolve(
        new Response(JSON.stringify({ tag_name: "v0.15.2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.includes("/releases/download/")) {
      return Promise.resolve(
        new Response(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), { status: 200 }),
      );
    }
    if (url.includes("config.kdl") || url.includes("mere.pub")) {
      return Promise.resolve(new Response("data", { status: 200 }));
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };

  // deno-lint-ignore no-explicit-any
  (Deno as any).stat = () =>
    Promise.reject(new Deno.errors.NotFound("not found"));
  // deno-lint-ignore no-explicit-any
  (Deno as any).lstat = () =>
    Promise.reject(new Deno.errors.NotFound("not found"));
  // deno-lint-ignore no-explicit-any
  (Deno as any).mkdir = () => Promise.resolve();
  // deno-lint-ignore no-explicit-any
  (Deno as any).writeFile = () => Promise.resolve();
  // deno-lint-ignore no-explicit-any
  (Deno as any).writeTextFile = () => Promise.resolve();
  // deno-lint-ignore no-explicit-any
  (Deno.env as any).get = (key: string) => {
    if (key === "SWAMP_REPO_DIR") return "/tmp/test-swamp";
    return undefined;
  };

  // Simulate a failed build (but store init succeeds)
  let commandCallCount = 0;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    constructor(_cmd: string, _opts: Deno.CommandOptions) {}
    output() {
      commandCallCount++;
      // First call is store init — must succeed
      if (commandCallCount === 1) {
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new TextEncoder().encode(""),
          stderr: new TextEncoder().encode(""),
        });
      }
      // Second call is the actual shell command — fails
      return Promise.resolve({
        code: 1,
        success: false,
        stdout: new TextEncoder().encode(""),
        stderr: new TextEncoder().encode("error: compilation failed\n"),
      });
    }
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { mereVersion: "0.15.2", mereRoot: "", useHostStore: false },
      methodName: "run",
    });

    await model.methods.run.execute(
      {
        packages: ["zig"],
        command: "zig build test",
        workdir: "/some/project",
      },
      context,
    );

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.success, false);
    assertEquals(data.exitCode, 1);
    assertEquals(data.stderr, "error: compilation failed\n");
    assertEquals(data.mereVersion, "0.15.2");
  } finally {
    globalThis.fetch = originalFetch;
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
    // deno-lint-ignore no-explicit-any
    (Deno as any).stat = originalStat;
    // deno-lint-ignore no-explicit-any
    (Deno as any).lstat = originalLstat;
    // deno-lint-ignore no-explicit-any
    (Deno as any).mkdir = originalMkdir;
    // deno-lint-ignore no-explicit-any
    (Deno as any).writeFile = originalWriteFile;
    // deno-lint-ignore no-explicit-any
    (Deno as any).writeTextFile = originalWriteTextFile;
    // deno-lint-ignore no-explicit-any
    (Deno.env as any).get = originalEnvGet;
  }
});

Deno.test("run - handles version resolution failure", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnvGet = Deno.env.get;

  globalThis.fetch = () => {
    return Promise.resolve(new Response("Server Error", { status: 500 }));
  };

  // deno-lint-ignore no-explicit-any
  (Deno.env as any).get = (key: string) => {
    if (key === "SWAMP_REPO_DIR") return "/tmp/test-swamp";
    return undefined;
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { mereVersion: "latest", mereRoot: "", useHostStore: false },
      methodName: "run",
    });

    await model.methods.run.execute(
      { packages: ["zig"], command: "zig build", workdir: undefined },
      context,
    );

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.success, false);
    assertEquals(data.exitCode, -1);
    assertEquals(typeof data.error, "string");
    assertEquals(data.error.includes("Failed to fetch"), true);
  } finally {
    globalThis.fetch = originalFetch;
    // deno-lint-ignore no-explicit-any
    (Deno.env as any).get = originalEnvGet;
  }
});

Deno.test("run - uses pinned version without API call", async () => {
  const originalFetch = globalThis.fetch;
  const originalCommand = Deno.Command;
  const originalStat = Deno.stat;
  const originalLstat = Deno.lstat;
  const originalMkdir = Deno.mkdir;
  const originalWriteFile = Deno.writeFile;
  const originalWriteTextFile = Deno.writeTextFile;
  const originalEnvGet = Deno.env.get;

  let apiCalled = false;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/releases/latest")) {
      apiCalled = true;
    }
    if (url.includes("/releases/download/")) {
      return Promise.resolve(
        new Response(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), { status: 200 }),
      );
    }
    if (url.includes("config.kdl") || url.includes("mere.pub")) {
      return Promise.resolve(new Response("data", { status: 200 }));
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };

  // deno-lint-ignore no-explicit-any
  (Deno as any).stat = () =>
    Promise.reject(new Deno.errors.NotFound("not found"));
  // deno-lint-ignore no-explicit-any
  (Deno as any).lstat = () =>
    Promise.reject(new Deno.errors.NotFound("not found"));
  // deno-lint-ignore no-explicit-any
  (Deno as any).mkdir = () => Promise.resolve();
  // deno-lint-ignore no-explicit-any
  (Deno as any).writeFile = () => Promise.resolve();
  // deno-lint-ignore no-explicit-any
  (Deno as any).writeTextFile = () => Promise.resolve();
  // deno-lint-ignore no-explicit-any
  (Deno.env as any).get = (key: string) => {
    if (key === "SWAMP_REPO_DIR") return "/tmp/test-swamp";
    return undefined;
  };

  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    constructor(_cmd: string, _opts: Deno.CommandOptions) {}
    output() {
      return Promise.resolve({
        code: 0,
        success: true,
        stdout: new TextEncoder().encode("ok\n"),
        stderr: new TextEncoder().encode(""),
      });
    }
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {
        mereVersion: "0.15.1",
        mereRoot: "/custom/root",
        useHostStore: false,
      },
      methodName: "run",
    });

    await model.methods.run.execute(
      { packages: ["busybox"], command: "ls", workdir: undefined },
      context,
    );

    assertEquals(apiCalled, false);
    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.mereVersion, "0.15.1");
    assertEquals(data.packages, ["busybox"]);
  } finally {
    globalThis.fetch = originalFetch;
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
    // deno-lint-ignore no-explicit-any
    (Deno as any).stat = originalStat;
    // deno-lint-ignore no-explicit-any
    (Deno as any).lstat = originalLstat;
    // deno-lint-ignore no-explicit-any
    (Deno as any).mkdir = originalMkdir;
    // deno-lint-ignore no-explicit-any
    (Deno as any).writeFile = originalWriteFile;
    // deno-lint-ignore no-explicit-any
    (Deno as any).writeTextFile = originalWriteTextFile;
    // deno-lint-ignore no-explicit-any
    (Deno.env as any).get = originalEnvGet;
  }
});
