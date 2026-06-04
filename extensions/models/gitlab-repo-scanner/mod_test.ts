// ABOUTME: Unit tests for gitlab-repo-scanner extension model.
// ABOUTME: Validates scan and fetch_files logic against mocked HTTP responses.
import { assertEquals, assertExists } from "jsr:@std/assert";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./mod.ts";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_PROJECT = {
  name: "my-service",
  description: "A sample service",
  default_branch: "main",
  last_activity_at: "2026-06-04T12:00:00Z",
  visibility: "private",
  star_count: 3,
  forks_count: 0,
  topics: ["go", "k8s"],
};

const MOCK_LANGUAGES = { Go: 92.5, Shell: 7.5 };

const MOCK_CONTRIBUTORS = [
  { name: "Alice", email: "alice@example.com", commits: 42 },
  { name: "Bob", email: "bob@example.com", commits: 17 },
];

const MOCK_TREE = [
  { path: "go.mod", type: "blob" },
  { path: "Dockerfile", type: "blob" },
  { path: "cmd", type: "tree" },
  { path: "cmd/main.go", type: "blob" },
  { path: "README.md", type: "blob" },
  { path: "k8s", type: "tree" },
  { path: "k8s/deployment.yaml", type: "blob" },
];

function mockFetch(overrides?: Record<string, string>) {
  return (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/languages")) {
      return Promise.resolve(new Response(JSON.stringify(MOCK_LANGUAGES), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    if (url.includes("/contributors")) {
      return Promise.resolve(new Response(JSON.stringify(MOCK_CONTRIBUTORS), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    if (url.includes("/repository/tree")) {
      return Promise.resolve(new Response(JSON.stringify(MOCK_TREE), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    if (url.includes("/repository/files/")) {
      const pathMatch = url.match(/files\/([^/]+)\/raw/);
      const filePath = pathMatch ? decodeURIComponent(pathMatch[1]) : "";
      const content = overrides?.[filePath] ?? `content of ${filePath}`;
      return Promise.resolve(new Response(content, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }));
    }
    if (url.includes("/projects/")) {
      return Promise.resolve(new Response(JSON.stringify(MOCK_PROJECT), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("scan - returns metadata and file tree", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch() as typeof fetch;

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { url: "https://gitlab.example.com", token: "test-token" },
      methodName: "scan",
    });

    const result = await model.methods.scan.execute(
      { projectPath: "myorg/my-service" },
      context,
    );

    assertEquals(result.dataHandles.length, 1);

    const resources = getWrittenResources();
    // deno-lint-ignore no-explicit-any
    const data = resources[0].data as any;

    assertEquals(data.path, "myorg/my-service");
    assertEquals(data.name, "my-service");
    assertEquals(data.defaultBranch, "main");
    assertEquals(data.visibility, "private");
    assertEquals(data.languages, MOCK_LANGUAGES);
    assertEquals(data.contributors.length, 2);
    assertEquals(data.contributors[0].name, "Alice");
    assertEquals(data.fileTree.length, 7);
    assertExists(data.scannedAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("scan - fetches known high-signal files that exist in tree", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({
    "go.mod": "module myorg/my-service\n\ngo 1.22",
    "Dockerfile": "FROM alpine:3.19\nCOPY . .",
    "README.md": "# My Service",
  }) as typeof fetch;

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { url: "https://gitlab.example.com", token: "test-token" },
      methodName: "scan",
    });

    await model.methods.scan.execute({ projectPath: "myorg/my-service" }, context);

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    const knownPaths = data.knownFiles.map((f: { path: string }) => f.path);

    // go.mod, Dockerfile, README.md are in mock tree and should be fetched
    assertEquals(knownPaths.includes("go.mod"), true);
    assertEquals(knownPaths.includes("Dockerfile"), true);
    assertEquals(knownPaths.includes("README.md"), true);
    // .gitlab-ci.yml is NOT in mock tree — should not appear
    assertEquals(knownPaths.includes(".gitlab-ci.yml"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("scan - file tree includes non-high-signal paths for discovery", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch() as typeof fetch;

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { url: "https://gitlab.example.com", token: "test-token" },
      methodName: "scan",
    });

    await model.methods.scan.execute({ projectPath: "myorg/my-service" }, context);

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    const treePaths = data.fileTree.map((f: { path: string }) => f.path);

    // k8s/deployment.yaml is in tree but not in high-signal list
    assertEquals(treePaths.includes("k8s/deployment.yaml"), true);
    // its content is NOT fetched automatically
    const knownPaths = data.knownFiles.map((f: { path: string }) => f.path);
    assertEquals(knownPaths.includes("k8s/deployment.yaml"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetch_files - returns content for requested paths", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({
    "k8s/deployment.yaml": "apiVersion: apps/v1\nkind: Deployment",
  }) as typeof fetch;

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { url: "https://gitlab.example.com", token: "test-token" },
      methodName: "fetch_files",
    });

    await model.methods.fetch_files.execute(
      { projectPath: "myorg/my-service", paths: ["k8s/deployment.yaml"] },
      context,
    );

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.path, "myorg/my-service");
    assertEquals(data.files.length, 1);
    assertEquals(data.files[0].path, "k8s/deployment.yaml");
    assertEquals(data.files[0].content, "apiVersion: apps/v1\nkind: Deployment");
    assertEquals(data.files[0].truncated, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetch_files - reports error for missing files", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // Only respond to project metadata, return 404 for everything else
    if (url.includes("/projects/") && !url.includes("/repository/")) {
      return Promise.resolve(new Response(JSON.stringify(MOCK_PROJECT), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { url: "https://gitlab.example.com", token: "test-token" },
      methodName: "fetch_files",
    });

    await model.methods.fetch_files.execute(
      { projectPath: "myorg/my-service", paths: ["does/not/exist.yaml"] },
      context,
    );

    // deno-lint-ignore no-explicit-any
    const data = getWrittenResources()[0].data as any;
    assertEquals(data.files[0].content, null);
    assertExists(data.files[0].error);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
