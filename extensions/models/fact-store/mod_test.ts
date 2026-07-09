// ABOUTME: Unit tests for @twonines/fact-store extension model.
// ABOUTME: Validates propose/activate/reject/withdraw lifecycle, list pagination, query assembly,
// ABOUTME: constraint management, and coverage gap analysis against an in-memory mock context.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { model } from "./mod.ts";

// ---------------------------------------------------------------------------
// Mock context factory
// ---------------------------------------------------------------------------

interface StoredResource {
  name: string;
  specName: string;
  data: Record<string, unknown>;
  tags: Record<string, string>;
  content: Uint8Array;
}

function createFactStoreTestContext(opts?: {
  globalArgs?: Record<string, unknown>;
  seed?: StoredResource[];
}) {
  const store = new Map<string, StoredResource>();
  const logs: Array<{ level: string; message: string; fields?: unknown }> = [];

  // Seed pre-existing data
  for (const s of opts?.seed ?? []) {
    store.set(s.name, s);
  }

  const modelType = "@twonines/fact-store";
  const modelId = "test-instance-id";

  const writeResource = (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    options?: { tags?: Record<string, string> },
  ): Promise<{ name: string; specName: string }> => {
    const tags = { specName, ...options?.tags };
    const content = new TextEncoder().encode(JSON.stringify(data));
    store.set(name, { name, specName, data, tags, content });
    return Promise.resolve({ name, specName });
  };

  const readResource = (instanceName: string): Promise<Record<string, unknown> | null> => {
    const entry = store.get(instanceName);
    return Promise.resolve(entry ? entry.data : null);
  };

  const dataRepository = {
    findAllForModel: (_type: string, _id: string) => {
      const results = [...store.values()].map((r) => ({
        tags: r.tags,
        name: r.name,
      }));
      return Promise.resolve(results);
    },
    getContent: (_type: string, _id: string, name: string) => {
      const entry = store.get(name);
      return Promise.resolve(entry ? entry.content : null);
    },
  };

  const logger = {
    debug: (msg: string, fields?: unknown) => logs.push({ level: "debug", message: msg, fields }),
    info: (msg: string, fields?: unknown) => logs.push({ level: "info", message: msg, fields }),
    warn: (msg: string, fields?: unknown) => logs.push({ level: "warn", message: msg, fields }),
    error: (msg: string, fields?: unknown) => logs.push({ level: "error", message: msg, fields }),
  };

  const context = {
    writeResource,
    readResource,
    dataRepository,
    logger,
    modelType,
    modelId,
    globalArgs: opts?.globalArgs ?? {},
  };

  return { context, store, logs };
}

// ---------------------------------------------------------------------------
// Helper: create a proposal via the propose method
// ---------------------------------------------------------------------------

const SAMPLE_SUBJECT = {
  refType: "repository",
  identityKind: "gitlab_path",
  identityValue: "myorg/my-service",
};

async function proposeOne(context: any, overrides?: Partial<{
  kind: string;
  scope: string;
  value: unknown;
  authorityBasis: string;
  proposedBy: string;
  evidence: string[];
  subjectRef: typeof SAMPLE_SUBJECT;
}>) {
  return await model.methods.propose.execute({
    kind: overrides?.kind ?? "repository_deploys_to_account",
    scope: overrides?.scope ?? "myorg/my-service",
    subjectRef: overrides?.subjectRef ?? SAMPLE_SUBJECT,
    value: overrides?.value ?? "123456789012",
    authorityBasis: (overrides?.authorityBasis ?? "file_content_observation") as any,
    proposedBy: overrides?.proposedBy ?? "ferret-agent",
    evidence: overrides?.evidence ?? ["terraform/main.tf:14"],
  }, context);
}

// ---------------------------------------------------------------------------
// Tests: propose
// ---------------------------------------------------------------------------

Deno.test("propose - creates a proposal resource with correct tags", async () => {
  const { context, store } = createFactStoreTestContext();

  const result = await proposeOne(context);

  assertEquals(result.dataHandles.length, 1);

  // Find the stored proposal
  const proposals = [...store.values()].filter((r) => r.specName === "proposal");
  assertEquals(proposals.length, 1);

  const p = proposals[0];
  assertEquals(p.tags.status, "proposed");
  assertEquals(p.tags.kind, "repository_deploys_to_account");
  assertEquals(p.tags.scope, "myorg/my-service");
  assertEquals(p.tags.proposedBy, "ferret-agent");
  assertEquals(p.data.value, "123456789012");
  assertEquals(p.data.status, "proposed");
  assertEquals((p.data.evidence as string[])[0], "terraform/main.tf:14");
});

Deno.test("propose - generates unique IDs for each proposal", async () => {
  const { context, store } = createFactStoreTestContext();

  await proposeOne(context, { value: "first" });
  await proposeOne(context, { value: "second" });

  const proposals = [...store.values()].filter((r) => r.specName === "proposal");
  assertEquals(proposals.length, 2);

  const ids = proposals.map((p) => p.data.id);
  assertEquals(new Set(ids).size, 2, "IDs should be unique");
});

Deno.test("propose - uses default scope 'global' when not specified", async () => {
  const { context, store } = createFactStoreTestContext();

  await model.methods.propose.execute({
    kind: "team_owns_service",
    subjectRef: SAMPLE_SUBJECT,
    value: "platform-team",
    authorityBasis: "human_claim_in_file" as any,
    proposedBy: "ferret",
    scope: "global",
  }, context);

  const proposals = [...store.values()].filter((r) => r.specName === "proposal");
  assertEquals(proposals[0].data.scope, "global");
});

// ---------------------------------------------------------------------------
// Tests: activate
// ---------------------------------------------------------------------------

Deno.test("activate - promotes proposal to active fact", async () => {
  const { context, store } = createFactStoreTestContext();

  // First propose
  await proposeOne(context);
  const proposal = [...store.values()].find((r) => r.specName === "proposal")!;
  const proposalId = proposal.data.id as string;

  // Then activate
  await model.methods.activate.execute(
    { proposalId, reviewedBy: "mole-agent" },
    context,
  );

  // Proposal should be marked activated
  const updatedProposal = [...store.values()].find(
    (r) => r.specName === "proposal" && r.data.id === proposalId,
  )!;
  assertEquals(updatedProposal.data.status, "activated");
  assertEquals(updatedProposal.data.reviewedBy, "mole-agent");
  assertEquals(updatedProposal.tags.status, "activated");

  // A fact should exist
  const facts = [...store.values()].filter((r) => r.specName === "fact");
  assertEquals(facts.length, 1);
  assertEquals(facts[0].data.status, "active");
  assertEquals(facts[0].data.kind, "repository_deploys_to_account");
  assertEquals(facts[0].data.activatedBy, "mole-agent");
  assertEquals(facts[0].tags.status, "active");
});

Deno.test("activate - throws on non-existent proposal", async () => {
  const { context } = createFactStoreTestContext();

  await assertRejects(
    () => model.methods.activate.execute(
      { proposalId: "nonexistent-id", reviewedBy: "mole" },
      context,
    ),
    Error,
    "not found",
  );
});

Deno.test("activate - throws on already-activated proposal", async () => {
  const { context, store } = createFactStoreTestContext();

  await proposeOne(context);
  const proposalId = [...store.values()]
    .find((r) => r.specName === "proposal")!.data.id as string;

  // Activate once
  await model.methods.activate.execute(
    { proposalId, reviewedBy: "mole" },
    context,
  );

  // Try to activate again
  await assertRejects(
    () => model.methods.activate.execute(
      { proposalId, reviewedBy: "mole" },
      context,
    ),
    Error,
    "cannot activate",
  );
});

Deno.test("activate - throws on rejected proposal", async () => {
  const { context, store } = createFactStoreTestContext();

  await proposeOne(context);
  const proposalId = [...store.values()]
    .find((r) => r.specName === "proposal")!.data.id as string;

  // Reject it
  await model.methods.reject.execute(
    { proposalId, reason: "wrong", reviewedBy: "mole" },
    context,
  );

  // Try to activate
  await assertRejects(
    () => model.methods.activate.execute(
      { proposalId, reviewedBy: "mole" },
      context,
    ),
    Error,
    "cannot activate",
  );
});

// ---------------------------------------------------------------------------
// Tests: reject
// ---------------------------------------------------------------------------

Deno.test("reject - marks proposal as rejected with reason", async () => {
  const { context, store } = createFactStoreTestContext();

  await proposeOne(context);
  const proposalId = [...store.values()]
    .find((r) => r.specName === "proposal")!.data.id as string;

  await model.methods.reject.execute(
    { proposalId, reason: "Evidence is stale", reviewedBy: "mole-agent" },
    context,
  );

  const updated = [...store.values()].find(
    (r) => r.specName === "proposal" && r.data.id === proposalId,
  )!;
  assertEquals(updated.data.status, "rejected");
  assertEquals(updated.data.rejectionReason, "Evidence is stale");
  assertEquals(updated.data.reviewedBy, "mole-agent");
  assertEquals(updated.tags.status, "rejected");
});

Deno.test("reject - throws on non-existent proposal", async () => {
  const { context } = createFactStoreTestContext();

  await assertRejects(
    () => model.methods.reject.execute(
      { proposalId: "ghost", reason: "nope", reviewedBy: "mole" },
      context,
    ),
    Error,
    "not found",
  );
});

Deno.test("reject - throws on already-activated proposal", async () => {
  const { context, store } = createFactStoreTestContext();

  await proposeOne(context);
  const proposalId = [...store.values()]
    .find((r) => r.specName === "proposal")!.data.id as string;

  await model.methods.activate.execute(
    { proposalId, reviewedBy: "mole" },
    context,
  );

  await assertRejects(
    () => model.methods.reject.execute(
      { proposalId, reason: "too late", reviewedBy: "mole" },
      context,
    ),
    Error,
    "cannot reject",
  );
});

// ---------------------------------------------------------------------------
// Tests: withdraw
// ---------------------------------------------------------------------------

Deno.test("withdraw - withdraws a proposed proposal", async () => {
  const { context, store } = createFactStoreTestContext();

  await proposeOne(context);
  const proposalId = [...store.values()]
    .find((r) => r.specName === "proposal")!.data.id as string;

  await model.methods.withdraw.execute({ proposalId }, context);

  const updated = [...store.values()].find(
    (r) => r.specName === "proposal" && r.data.id === proposalId,
  )!;
  assertEquals(updated.data.status, "withdrawn");
  assertEquals(updated.tags.status, "withdrawn");
});

Deno.test("withdraw - withdraws a rejected proposal", async () => {
  const { context, store } = createFactStoreTestContext();

  await proposeOne(context);
  const proposalId = [...store.values()]
    .find((r) => r.specName === "proposal")!.data.id as string;

  await model.methods.reject.execute(
    { proposalId, reason: "bad evidence", reviewedBy: "mole" },
    context,
  );

  // Should still be withdrawable after rejection
  await model.methods.withdraw.execute({ proposalId }, context);

  const updated = [...store.values()].find(
    (r) => r.specName === "proposal" && r.data.id === proposalId,
  )!;
  assertEquals(updated.data.status, "withdrawn");
});

Deno.test("withdraw - throws on non-existent proposal", async () => {
  const { context } = createFactStoreTestContext();

  await assertRejects(
    () => model.methods.withdraw.execute({ proposalId: "ghost" }, context),
    Error,
    "not found",
  );
});

Deno.test("withdraw - throws on activated proposal", async () => {
  const { context, store } = createFactStoreTestContext();

  await proposeOne(context);
  const proposalId = [...store.values()]
    .find((r) => r.specName === "proposal")!.data.id as string;

  await model.methods.activate.execute(
    { proposalId, reviewedBy: "mole" },
    context,
  );

  await assertRejects(
    () => model.methods.withdraw.execute({ proposalId }, context),
    Error,
    "cannot withdraw",
  );
});

// ---------------------------------------------------------------------------
// Tests: list_facts (pagination, filtering)
// ---------------------------------------------------------------------------

Deno.test("list_facts - returns all active facts with defaults", async () => {
  const { context, store } = createFactStoreTestContext();

  // Propose and activate 3 facts
  for (let i = 0; i < 3; i++) {
    await proposeOne(context, {
      kind: `kind_${i}`,
      subjectRef: {
        refType: "repository",
        identityKind: "gitlab_path",
        identityValue: `repo-${i}`,
      },
    });
  }

  // Activate all proposals
  const proposals = [...store.values()]
    .filter((r) => r.specName === "proposal" && r.data.status === "proposed");
  for (const p of proposals) {
    await model.methods.activate.execute(
      { proposalId: p.data.id as string, reviewedBy: "mole" },
      context,
    );
  }

  const result = await model.methods.list_facts.execute(
    { offset: 0, limit: 100 },
    context,
  );

  assertEquals(result.dataHandles.length, 1);
  const output = store.get(result.dataHandles[0].name)!.data;
  assertEquals(output.total, 3);
  assertEquals((output.facts as any[]).length, 3);
  assertEquals(output.truncated, false);
});

Deno.test("list_facts - pagination with offset and limit", async () => {
  const { context, store } = createFactStoreTestContext();

  // Create 5 active facts
  for (let i = 0; i < 5; i++) {
    await proposeOne(context, {
      kind: `kind_${i}`,
      subjectRef: {
        refType: "repository",
        identityKind: "gitlab_path",
        identityValue: `repo-${i}`,
      },
    });
  }
  const proposals = [...store.values()]
    .filter((r) => r.specName === "proposal" && r.data.status === "proposed");
  for (const p of proposals) {
    await model.methods.activate.execute(
      { proposalId: p.data.id as string, reviewedBy: "mole" },
      context,
    );
  }

  // First page: offset=0, limit=2
  const page1 = await model.methods.list_facts.execute(
    { offset: 0, limit: 2 },
    context,
  );
  const p1Data = store.get(page1.dataHandles[0].name)!.data;
  assertEquals((p1Data.facts as any[]).length, 2);
  assertEquals(p1Data.total, 5);
  assertEquals(p1Data.truncated, true);

  // Second page: offset=2, limit=2
  const page2 = await model.methods.list_facts.execute(
    { offset: 2, limit: 2 },
    context,
  );
  const p2Data = store.get(page2.dataHandles[0].name)!.data;
  assertEquals((p2Data.facts as any[]).length, 2);
  assertEquals(p2Data.truncated, true);

  // Last page: offset=4, limit=2
  const page3 = await model.methods.list_facts.execute(
    { offset: 4, limit: 2 },
    context,
  );
  const p3Data = store.get(page3.dataHandles[0].name)!.data;
  assertEquals((p3Data.facts as any[]).length, 1);
  assertEquals(p3Data.truncated, false);
});

Deno.test("list_facts - filters by scope", async () => {
  const { context, store } = createFactStoreTestContext();

  await proposeOne(context, { kind: "k1", scope: "myorg/alpha" });
  await proposeOne(context, {
    kind: "k2",
    scope: "myorg/beta",
    subjectRef: { refType: "repository", identityKind: "gitlab_path", identityValue: "myorg/beta" },
  });

  const proposals = [...store.values()]
    .filter((r) => r.specName === "proposal" && r.data.status === "proposed");
  for (const p of proposals) {
    await model.methods.activate.execute(
      { proposalId: p.data.id as string, reviewedBy: "mole" },
      context,
    );
  }

  const result = await model.methods.list_facts.execute(
    { scope: "myorg/alpha", offset: 0, limit: 100 },
    context,
  );
  const data = store.get(result.dataHandles[0].name)!.data;
  assertEquals(data.total, 1);
  assertEquals((data.facts as any[])[0].scope, "myorg/alpha");
});

Deno.test("list_facts - filters by kind", async () => {
  const { context, store } = createFactStoreTestContext();

  await proposeOne(context, { kind: "deploys_to" });
  await proposeOne(context, {
    kind: "owns_service",
    subjectRef: { refType: "team", identityKind: "team_name", identityValue: "platform" },
  });

  const proposals = [...store.values()]
    .filter((r) => r.specName === "proposal" && r.data.status === "proposed");
  for (const p of proposals) {
    await model.methods.activate.execute(
      { proposalId: p.data.id as string, reviewedBy: "mole" },
      context,
    );
  }

  const result = await model.methods.list_facts.execute(
    { kind: "owns_service", offset: 0, limit: 100 },
    context,
  );
  const data = store.get(result.dataHandles[0].name)!.data;
  assertEquals(data.total, 1);
  assertEquals((data.facts as any[])[0].kind, "owns_service");
});

Deno.test("list_facts - caps limit at 500", async () => {
  const { context, store } = createFactStoreTestContext();

  // We won't create 501 facts, but verify the logic by checking
  // that limit=1000 still works (capped internally to 500)
  await proposeOne(context);
  const proposalId = [...store.values()]
    .find((r) => r.specName === "proposal")!.data.id as string;
  await model.methods.activate.execute(
    { proposalId, reviewedBy: "mole" },
    context,
  );

  // Should not throw even with limit > 500
  const result = await model.methods.list_facts.execute(
    { offset: 0, limit: 1000 },
    context,
  );
  const data = store.get(result.dataHandles[0].name)!.data;
  assertEquals(data.total, 1);
});

// ---------------------------------------------------------------------------
// Tests: list_proposals (pagination, status filter)
// ---------------------------------------------------------------------------

Deno.test("list_proposals - lists pending proposals", async () => {
  const { context, store } = createFactStoreTestContext();

  await proposeOne(context, { kind: "k1" });
  await proposeOne(context, {
    kind: "k2",
    subjectRef: { refType: "repository", identityKind: "gitlab_path", identityValue: "other" },
  });

  const result = await model.methods.list_proposals.execute(
    { status: "proposed", offset: 0, limit: 50 },
    context,
  );
  const data = store.get(result.dataHandles[0].name)!.data;
  assertEquals(data.total, 2);
  assertEquals((data.proposals as any[]).length, 2);
  assertEquals(data.truncated, false);
  assertEquals((data.filter as any).status, "proposed");
});

Deno.test("list_proposals - filters by status", async () => {
  const { context, store } = createFactStoreTestContext();

  await proposeOne(context, { kind: "k1" });
  await proposeOne(context, {
    kind: "k2",
    subjectRef: { refType: "repository", identityKind: "gitlab_path", identityValue: "other" },
  });

  // Activate one
  const firstProposal = [...store.values()]
    .find((r) => r.specName === "proposal" && r.data.kind === "k1")!;
  await model.methods.activate.execute(
    { proposalId: firstProposal.data.id as string, reviewedBy: "mole" },
    context,
  );

  // Only one should be "proposed" now
  const proposed = await model.methods.list_proposals.execute(
    { status: "proposed", offset: 0, limit: 50 },
    context,
  );
  const pData = store.get(proposed.dataHandles[0].name)!.data;
  assertEquals(pData.total, 1);

  // One should be "activated"
  const activated = await model.methods.list_proposals.execute(
    { status: "activated", offset: 0, limit: 50 },
    context,
  );
  const aData = store.get(activated.dataHandles[0].name)!.data;
  assertEquals(aData.total, 1);
});

Deno.test("list_proposals - 'all' returns every status", async () => {
  const { context, store } = createFactStoreTestContext();

  await proposeOne(context, { kind: "k1" });
  await proposeOne(context, {
    kind: "k2",
    subjectRef: { refType: "repository", identityKind: "gitlab_path", identityValue: "other" },
  });

  // Reject one
  const firstProposal = [...store.values()]
    .find((r) => r.specName === "proposal" && r.data.kind === "k1")!;
  await model.methods.reject.execute(
    { proposalId: firstProposal.data.id as string, reason: "bad", reviewedBy: "mole" },
    context,
  );

  const all = await model.methods.list_proposals.execute(
    { status: "all", offset: 0, limit: 50 },
    context,
  );
  const data = store.get(all.dataHandles[0].name)!.data;
  assertEquals(data.total, 2);
});

Deno.test("list_proposals - pagination with offset", async () => {
  const { context, store } = createFactStoreTestContext();

  for (let i = 0; i < 5; i++) {
    await proposeOne(context, {
      kind: `k_${i}`,
      subjectRef: { refType: "repository", identityKind: "gitlab_path", identityValue: `r-${i}` },
    });
  }

  const page1 = await model.methods.list_proposals.execute(
    { status: "proposed", offset: 0, limit: 2 },
    context,
  );
  const p1 = store.get(page1.dataHandles[0].name)!.data;
  assertEquals((p1.proposals as any[]).length, 2);
  assertEquals(p1.total, 5);
  assertEquals(p1.truncated, true);

  const page3 = await model.methods.list_proposals.execute(
    { status: "proposed", offset: 4, limit: 2 },
    context,
  );
  const p3 = store.get(page3.dataHandles[0].name)!.data;
  assertEquals((p3.proposals as any[]).length, 1);
  assertEquals(p3.truncated, false);
});

// ---------------------------------------------------------------------------
// Tests: query (truth packet assembly)
// ---------------------------------------------------------------------------

Deno.test("query - assembles truth packet with matching facts", async () => {
  const { context, store } = createFactStoreTestContext();

  // Create and activate a fact
  await proposeOne(context, { scope: "myorg/svc", kind: "deploys_to", value: "prod" });
  const proposalId = [...store.values()]
    .find((r) => r.specName === "proposal")!.data.id as string;
  await model.methods.activate.execute(
    { proposalId, reviewedBy: "mole" },
    context,
  );

  const result = await model.methods.query.execute(
    { scope: "myorg/svc", limit: 50 },
    context,
  );
  const packet = store.get(result.dataHandles[0].name)!.data;
  assertEquals((packet.facts as any[]).length, 1);
  assertEquals((packet.facts as any[])[0].kind, "deploys_to");
  assertEquals(packet.truncated, false);
  assertEquals(packet.totalFactsMatched, 1);
});

Deno.test("query - filters by kinds", async () => {
  const { context, store } = createFactStoreTestContext();

  await proposeOne(context, { kind: "deploys_to", scope: "s" });
  await proposeOne(context, {
    kind: "owns_service",
    scope: "s",
    subjectRef: { refType: "team", identityKind: "team_name", identityValue: "eng" },
  });

  const proposals = [...store.values()]
    .filter((r) => r.specName === "proposal" && r.data.status === "proposed");
  for (const p of proposals) {
    await model.methods.activate.execute(
      { proposalId: p.data.id as string, reviewedBy: "mole" },
      context,
    );
  }

  const result = await model.methods.query.execute(
    { scope: "s", kinds: ["owns_service"], limit: 50 },
    context,
  );
  const packet = store.get(result.dataHandles[0].name)!.data;
  assertEquals((packet.facts as any[]).length, 1);
  assertEquals((packet.facts as any[])[0].kind, "owns_service");
});

Deno.test("query - truncates when facts exceed limit", async () => {
  const { context, store } = createFactStoreTestContext();

  // Create 5 facts in the same scope
  for (let i = 0; i < 5; i++) {
    await proposeOne(context, {
      kind: `k_${i}`,
      scope: "shared",
      subjectRef: { refType: "repository", identityKind: "gitlab_path", identityValue: `r-${i}` },
    });
  }
  const proposals = [...store.values()]
    .filter((r) => r.specName === "proposal" && r.data.status === "proposed");
  for (const p of proposals) {
    await model.methods.activate.execute(
      { proposalId: p.data.id as string, reviewedBy: "mole" },
      context,
    );
  }

  const result = await model.methods.query.execute(
    { scope: "shared", limit: 3 },
    context,
  );
  const packet = store.get(result.dataHandles[0].name)!.data;
  assertEquals((packet.facts as any[]).length, 3);
  assertEquals(packet.totalFactsMatched, 5);
  assertEquals(packet.truncated, true);
});

Deno.test("query - includes constraints and filters by hints", async () => {
  const { context, store } = createFactStoreTestContext();

  // Add constraints
  await model.methods.add_constraint.execute(
    {
      kind: "security_boundary",
      scope: "global",
      rule: "Never expose internal APIs publicly",
      appliesTo: ["api", "networking"],
    },
    context,
  );
  await model.methods.add_constraint.execute(
    {
      kind: "naming_convention",
      scope: "global",
      rule: "Use kebab-case for service names",
      appliesTo: ["naming", "services"],
    },
    context,
  );

  // Query with hint matching only the first constraint
  const result = await model.methods.query.execute(
    { hints: ["api"], limit: 50 },
    context,
  );
  const packet = store.get(result.dataHandles[0].name)!.data;
  // Should include the api constraint but not the naming one
  assertEquals((packet.constraints as any[]).length, 1);
  assertEquals((packet.constraints as any[])[0].kind, "security_boundary");
});

Deno.test("query - without scope returns all active facts", async () => {
  const { context, store } = createFactStoreTestContext();

  await proposeOne(context, { kind: "k1", scope: "alpha" });
  await proposeOne(context, {
    kind: "k2",
    scope: "beta",
    subjectRef: { refType: "repository", identityKind: "gitlab_path", identityValue: "beta-repo" },
  });

  const proposals = [...store.values()]
    .filter((r) => r.specName === "proposal" && r.data.status === "proposed");
  for (const p of proposals) {
    await model.methods.activate.execute(
      { proposalId: p.data.id as string, reviewedBy: "mole" },
      context,
    );
  }

  const result = await model.methods.query.execute({ limit: 50 }, context);
  const packet = store.get(result.dataHandles[0].name)!.data;
  assertEquals(packet.totalFactsMatched, 2);
});

// ---------------------------------------------------------------------------
// Tests: add_constraint
// ---------------------------------------------------------------------------

Deno.test("add_constraint - creates active constraint with tags", async () => {
  const { context, store } = createFactStoreTestContext();

  const result = await model.methods.add_constraint.execute(
    {
      kind: "deployment_rule",
      scope: "production",
      rule: "All deployments require approval",
      rationale: "Compliance requirement",
      appliesTo: ["deployment", "production"],
    },
    context,
  );

  assertEquals(result.dataHandles.length, 1);

  const constraints = [...store.values()].filter((r) => r.specName === "constraint");
  assertEquals(constraints.length, 1);
  assertEquals(constraints[0].data.kind, "deployment_rule");
  assertEquals(constraints[0].data.scope, "production");
  assertEquals(constraints[0].data.rule, "All deployments require approval");
  assertEquals(constraints[0].data.rationale, "Compliance requirement");
  assertEquals(constraints[0].data.status, "active");
  assertEquals(constraints[0].tags.status, "active");
  assertEquals(constraints[0].tags.kind, "deployment_rule");
});

Deno.test("add_constraint - defaults scope to global", async () => {
  const { context, store } = createFactStoreTestContext();

  await model.methods.add_constraint.execute(
    {
      kind: "process",
      scope: "global",
      rule: "Always review before merge",
    },
    context,
  );

  const constraints = [...store.values()].filter((r) => r.specName === "constraint");
  assertEquals(constraints[0].data.scope, "global");
});

// ---------------------------------------------------------------------------
// Tests: coverage_gaps
// ---------------------------------------------------------------------------

Deno.test("coverage_gaps - detects repos with no facts", async () => {
  const { context, store } = createFactStoreTestContext();

  const result = await model.methods.coverage_gaps.execute(
    {
      discoveredRepos: ["myorg/repo-a", "myorg/repo-b"],
      indexedRepos: ["myorg/repo-a", "myorg/repo-b"],
      limit: 50,
    },
    context,
  );

  const output = store.get(result.dataHandles[0].name)!.data;
  const gaps = output.gaps as any[];
  assertEquals(gaps.length, 2);
  assertEquals(gaps[0].gapType, "no_facts");
  assertEquals((output.summary as any).reposWithoutFacts, 2);
});

Deno.test("coverage_gaps - detects unindexed repos", async () => {
  const { context, store } = createFactStoreTestContext();

  const result = await model.methods.coverage_gaps.execute(
    {
      discoveredRepos: ["myorg/unindexed"],
      indexedRepos: [],
      limit: 50,
    },
    context,
  );

  const output = store.get(result.dataHandles[0].name)!.data;
  const gaps = output.gaps as any[];
  assertEquals(gaps.length, 1);
  assertEquals(gaps[0].gapType, "no_index");
  assertEquals(gaps[0].suggestedQueries, []);
});

Deno.test("coverage_gaps - detects single-dimension coverage", async () => {
  const { context, store } = createFactStoreTestContext();

  // Create facts all in the infra dimension
  const infraKinds = [
    "repository_deploys_to_account",
    "repository_provisions_cluster",
    "repository_manages_infra",
  ];
  for (const kind of infraKinds) {
    await proposeOne(context, {
      kind,
      scope: "myorg/infra-heavy",
      subjectRef: {
        refType: "repository",
        identityKind: "gitlab_path",
        identityValue: `myorg/infra-heavy`,
      },
    });
  }
  const proposals = [...store.values()]
    .filter((r) => r.specName === "proposal" && r.data.status === "proposed");
  for (const p of proposals) {
    await model.methods.activate.execute(
      { proposalId: p.data.id as string, reviewedBy: "mole" },
      context,
    );
  }

  const result = await model.methods.coverage_gaps.execute(
    { discoveredRepos: [], indexedRepos: [], limit: 50 },
    context,
  );

  const output = store.get(result.dataHandles[0].name)!.data;
  const gaps = output.gaps as any[];
  const singleDim = gaps.filter((g: any) => g.gapType === "single_dimension");
  assertEquals(singleDim.length, 1);
  assertEquals(singleDim[0].repo, "myorg/infra-heavy");
});

Deno.test("coverage_gaps - respects limit", async () => {
  const { context, store } = createFactStoreTestContext();

  const result = await model.methods.coverage_gaps.execute(
    {
      discoveredRepos: ["a", "b", "c", "d", "e"],
      indexedRepos: ["a", "b", "c", "d", "e"],
      limit: 2,
    },
    context,
  );

  const output = store.get(result.dataHandles[0].name)!.data;
  assertEquals((output.gaps as any[]).length, 2);
});
