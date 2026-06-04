// ABOUTME: Stores and manages repository fact proposals and accepted facts.
// ABOUTME: Ferret proposes findings; mole accepts or rejects them.
// ABOUTME: Evidence records track what was checked, enabling mole to audit
// ABOUTME: or extend ferret's work before making a decision.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ProposalStatus = z.enum(["proposed", "accepted", "rejected"]);

const EvidenceSchema = z.object({
  source: z.string().describe("Where this was observed (e.g. 'go.mod', '.gitlab-ci.yml', 'file-tree')"),
  path: z.string().optional().describe("File path if source is a file"),
  excerpt: z.string().optional().describe("Relevant excerpt or value from the source (truncated)"),
});

const ProposalSchema = z.object({
  id: z.string().describe("Deterministic ID: sha256 of kind+subject+value (first 12 hex chars)"),
  kind: z.string().describe("Fact kind (e.g. 'primary_language', 'deploys_to', 'built_with')"),
  subject: z.string().describe("Subject identifier (e.g. 'myorg/my-service')"),
  value: z.unknown().describe("The proposed fact value"),
  evidence: z.array(EvidenceSchema).describe("What was examined to arrive at this proposal"),
  confidence: z.number().min(0).max(1).describe("Proposer confidence 0-1"),
  proposedBy: z.string().describe("Agent or process that proposed this fact"),
  proposedAt: z.string(),
  status: ProposalStatus,
  reviewedBy: z.string().optional().describe("Agent or process that accepted/rejected"),
  reviewedAt: z.string().optional(),
  rejectionReason: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hashId(kind: string, subject: string, value: unknown): Promise<string> {
  const input = `${kind}::${subject}::${JSON.stringify(value)}`;
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const model = {
  type: "@twonines/repo-correlator",
  version: "2026.06.04.1",
  description:
    "Stores and manages repository fact proposals. Ferret proposes findings with evidence; " +
    "mole accepts or rejects them after validation. Accepted facts become the jitter input layer.",
  globalArguments: z.object({
    namespace: z
      .string()
      .default("default")
      .describe("Namespace for isolating fact sets (e.g. org name)"),
  }),
  resources: {
    proposal: {
      description: "A fact proposal with evidence and lifecycle status",
      schema: ProposalSchema,
      lifetime: "infinite" as const,
      garbageCollection: 500,
    },
  },
  methods: {
    propose: {
      description:
        "Record a new fact proposal with supporting evidence. " +
        "If a proposal with the same kind+subject+value already exists, it is a no-op.",
      arguments: z.object({
        kind: z.string().describe("Fact kind (e.g. 'primary_language', 'deploys_to')"),
        subject: z.string().describe("Subject identifier (e.g. 'myorg/my-service')"),
        value: z.unknown().describe("The proposed fact value"),
        evidence: z
          .array(EvidenceSchema)
          .describe("Sources examined to support this proposal"),
        confidence: z.number().min(0).max(1).default(0.7),
        proposedBy: z.string().default("ferret"),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const id = await hashId(args.kind, args.subject, args.value);

        // Check for existing proposal with same content
        const existing = await context.readResource(id).catch(() => null);
        if (existing) {
          context.logger.info(
            "Proposal {id} ({kind}:{subject}) already exists, skipping",
            { id, kind: args.kind, subject: args.subject },
          );
          const handle = await context.writeResource("proposal", id, existing);
          return { dataHandles: [handle] };
        }

        const data: z.infer<typeof ProposalSchema> = {
          id,
          kind: args.kind,
          subject: args.subject,
          value: args.value,
          evidence: args.evidence ?? [],
          confidence: args.confidence ?? 0.7,
          proposedBy: args.proposedBy ?? "ferret",
          proposedAt: new Date().toISOString(),
          status: "proposed",
        };

        context.logger.info(
          "Proposed {kind}:{subject} (id={id}, confidence={conf})",
          { kind: args.kind, subject: args.subject, id, conf: data.confidence },
        );

        const handle = await context.writeResource("proposal", id, data);
        return { dataHandles: [handle] };
      },
    },

    accept: {
      description:
        "Accept a proposal as a validated fact. Optionally add or replace evidence " +
        "if mole checked additional sources during validation.",
      arguments: z.object({
        id: z.string().describe("Proposal ID to accept"),
        reviewedBy: z.string().default("mole"),
        additionalEvidence: z
          .array(EvidenceSchema)
          .optional()
          .describe("Any additional sources mole checked during validation"),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const existing = await context.readResource(args.id) as z.infer<typeof ProposalSchema> | null;
        if (!existing) {
          throw new Error(`Proposal ${args.id} not found`);
        }
        if (existing.status === "accepted") {
          context.logger.info("Proposal {id} already accepted", { id: args.id });
          const handle = await context.writeResource("proposal", args.id, existing);
          return { dataHandles: [handle] };
        }

        const updated: z.infer<typeof ProposalSchema> = {
          ...existing,
          status: "accepted",
          reviewedBy: args.reviewedBy ?? "mole",
          reviewedAt: new Date().toISOString(),
          evidence: args.additionalEvidence?.length
            ? [...existing.evidence, ...args.additionalEvidence]
            : existing.evidence,
          rejectionReason: undefined,
        };

        context.logger.info(
          "Accepted {kind}:{subject} (id={id})",
          { kind: existing.kind, subject: existing.subject, id: args.id },
        );

        const handle = await context.writeResource("proposal", args.id, updated);
        return { dataHandles: [handle] };
      },
    },

    reject: {
      description: "Reject a proposal with a reason.",
      arguments: z.object({
        id: z.string().describe("Proposal ID to reject"),
        reason: z.string().describe("Why this proposal was rejected"),
        reviewedBy: z.string().default("mole"),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const existing = await context.readResource(args.id) as z.infer<typeof ProposalSchema> | null;
        if (!existing) {
          throw new Error(`Proposal ${args.id} not found`);
        }

        const updated: z.infer<typeof ProposalSchema> = {
          ...existing,
          status: "rejected",
          reviewedBy: args.reviewedBy ?? "mole",
          reviewedAt: new Date().toISOString(),
          rejectionReason: args.reason,
        };

        context.logger.info(
          "Rejected {kind}:{subject} (id={id}): {reason}",
          { kind: existing.kind, subject: existing.subject, id: args.id, reason: args.reason },
        );

        const handle = await context.writeResource("proposal", args.id, updated);
        return { dataHandles: [handle] };
      },
    },

    list: {
      description:
        "List proposals filtered by status and/or subject. " +
        "Useful for mole to find all pending proposals for a subject.",
      arguments: z.object({
        status: ProposalStatus.optional().describe("Filter by status (omit for all)"),
        subject: z.string().optional().describe("Filter by subject prefix"),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const allData = await context.dataRepository.findAllForModel(
          context.modelType,
          context.modelId,
        );

        const results: z.infer<typeof ProposalSchema>[] = [];
        for (const entry of allData) {
          const content = await context.dataRepository.getContent(
            context.modelType,
            context.modelId,
            entry.name,
          );
          if (!content) continue;
          const p = JSON.parse(new TextDecoder().decode(content)) as z.infer<typeof ProposalSchema>;
          if (args.status && p.status !== args.status) continue;
          if (args.subject && !p.subject.startsWith(args.subject)) continue;
          results.push(p);
        }

        const summary = {
          count: results.length,
          proposals: results,
          queriedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource("proposal", `list-${Date.now()}`, {
          id: `list`,
          kind: "_list",
          subject: args.subject ?? "*",
          value: summary,
          evidence: [],
          confidence: 1,
          proposedBy: "system",
          proposedAt: new Date().toISOString(),
          status: "proposed",
        });

        context.logger.info(
          "Listed {count} proposals (status={status}, subject={subject})",
          { count: results.length, status: args.status ?? "all", subject: args.subject ?? "*" },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
