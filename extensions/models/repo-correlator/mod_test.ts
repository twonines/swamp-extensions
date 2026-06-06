// ABOUTME: Unit tests for repo-correlator extension model.
// ABOUTME: Validates propose, accept, reject, and list lifecycle.
import { assertEquals, assertExists } from "jsr:@std/assert";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./mod.ts";

const GLOBAL_ARGS = { namespace: "test" };

const EXISTING_PROPOSAL = {
  id: "abc123def456",
  kind: "primary_language",
  subject: "myorg/my-service",
  value: "go",
  evidence: [{ source: "go.mod", path: "go.mod", excerpt: "module myorg/my-service" }],
  confidence: 0.9,
  proposedBy: "ferret",
  proposedAt: "2026-06-04T00:00:00Z",
  status: "proposed",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("propose - stores new proposal with proposed status", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
    methodName: "propose",
  });
  // No existing resource — readResource returns null
  // deno-lint-ignore no-explicit-any
  (context as any).readResource = async () => null;

  await model.methods.propose.execute(
    {
      kind: "primary_language",
      subject: "myorg/my-service",
      value: "go",
      evidence: [{ source: "go.mod", path: "go.mod", excerpt: "module myorg/my-service" }],
      confidence: 0.95,
      proposedBy: "ferret",
    },
    context,
  );

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  // deno-lint-ignore no-explicit-any
  const data = resources[0].data as any;
  assertEquals(data.kind, "primary_language");
  assertEquals(data.subject, "myorg/my-service");
  assertEquals(data.value, "go");
  assertEquals(data.status, "proposed");
  assertEquals(data.confidence, 0.95);
  assertEquals(data.evidence.length, 1);
  assertExists(data.id);
  assertExists(data.proposedAt);
});

Deno.test("propose - generates deterministic ID for same kind+subject+value", async () => {
  const { context: ctx1, getWrittenResources: get1 } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
    methodName: "propose",
  });
  const { context: ctx2, getWrittenResources: get2 } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
    methodName: "propose",
  });
  // deno-lint-ignore no-explicit-any
  (ctx1 as any).readResource = async () => null;
  // deno-lint-ignore no-explicit-any
  (ctx2 as any).readResource = async () => null;

  await model.methods.propose.execute(
    { kind: "primary_language", subject: "myorg/my-service", value: "go", evidence: [] },
    ctx1,
  );
  await model.methods.propose.execute(
    { kind: "primary_language", subject: "myorg/my-service", value: "go", evidence: [] },
    ctx2,
  );

  // deno-lint-ignore no-explicit-any
  const id1 = (get1()[0].data as any).id;
  // deno-lint-ignore no-explicit-any
  const id2 = (get2()[0].data as any).id;
  assertEquals(id1, id2);
});

Deno.test("accept - transitions proposal to accepted status", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
    methodName: "accept",
  });
  // deno-lint-ignore no-explicit-any
  (context as any).readResource = async () => EXISTING_PROPOSAL;

  await model.methods.accept.execute(
    {
      id: EXISTING_PROPOSAL.id,
      reviewedBy: "mole",
      additionalEvidence: [{ source: "kubernetes-manifest", path: "k8s/deploy.yaml" }],
    },
    context,
  );

  // deno-lint-ignore no-explicit-any
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.status, "accepted");
  assertEquals(data.reviewedBy, "mole");
  assertExists(data.reviewedAt);
  assertEquals(data.evidence.length, 2); // original + additional
});

Deno.test("reject - transitions proposal to rejected with reason", async () => {
  const deployProposal = {
    ...EXISTING_PROPOSAL,
    id: "deadbeef1234",
    kind: "deploys_to",
    value: "cluster-prod",
    confidence: 0.5,
  };

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
    methodName: "reject",
  });
  // deno-lint-ignore no-explicit-any
  (context as any).readResource = async () => deployProposal;

  await model.methods.reject.execute(
    {
      id: deployProposal.id,
      reason: "CI variable references staging, not prod cluster",
      reviewedBy: "mole",
    },
    context,
  );

  // deno-lint-ignore no-explicit-any
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.status, "rejected");
  assertEquals(data.rejectionReason, "CI variable references staging, not prod cluster");
  assertExists(data.reviewedAt);
});

Deno.test("accept - throws if proposal not found", async () => {
  const { context } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
    methodName: "accept",
  });
  // deno-lint-ignore no-explicit-any
  (context as any).readResource = async () => null;

  let threw = false;
  try {
    await model.methods.accept.execute({ id: "nonexistent", reviewedBy: "mole" }, context);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
