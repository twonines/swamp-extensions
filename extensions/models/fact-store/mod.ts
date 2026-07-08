/**
 * Stores, validates, and serves organizational facts for AI agent
 * consumption. Facts are relational truths about infrastructure,
 * repositories, services, teams, and their connections. Supports a
 * propose→review→activate lifecycle with adversarial validation
 * (ferret/mole pattern).
 *
 * @module
 */
// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SubjectRefSchema = z.object({
  refType: z.string().describe(
    "Entity type: repository, aws_account, k8s_cluster, service, team, etc.",
  ),
  identityKind: z.string().describe(
    "Identity format: gitlab_path, account_id, cluster_name, etc.",
  ),
  identityValue: z.string().describe("The identity value itself"),
});

// Evidence tier — see AUTHORITY_TIERS.md for the full framework, principles,
// and adversarial questions. Higher tiers (lower numeric values) override
// lower-tier sources for the same claim.
const AuthorityBasisSchema = z.enum([
  "live_system_verification", // Tier 0 — queried running system at a moment
  "file_is_the_mechanism", // Tier 1 — a system enforces behavior by reading this file
  "file_content_observation", // Tier 2 — file references external state that could be stale
  "human_claim_in_file", // Tier 3a — a human's claim recorded in a file
  "human_claim_in_ticket", // Tier 3b — a human's claim recorded in a ticket/record
  "agent_inference", // Tier 4 — logical conclusion from indirect evidence
]).describe(
  "Evidence tier (see AUTHORITY_TIERS.md). One of: live_system_verification, file_is_the_mechanism, file_content_observation, human_claim_in_file, human_claim_in_ticket, agent_inference.",
);

const FactSchema = z.object({
  id: z.string(),
  kind: z.string(),
  scope: z.string(),
  subjectRef: SubjectRefSchema,
  value: z.unknown(),
  authorityBasis: AuthorityBasisSchema,
  status: z.enum(["active", "superseded", "retired"]),
  proposedBy: z.string(),
  activatedBy: z.string().optional(),
  createdAt: z.string(),
  activatedAt: z.string().optional(),
});

const ProposalSchema = z.object({
  id: z.string(),
  kind: z.string(),
  scope: z.string(),
  subjectRef: SubjectRefSchema,
  value: z.unknown(),
  authorityBasis: AuthorityBasisSchema,
  status: z.enum(["proposed", "activated", "rejected", "withdrawn"]),
  proposedBy: z.string(),
  evidence: z.array(z.string()).optional(),
  rejectionReason: z.string().optional(),
  createdAt: z.string(),
  reviewedAt: z.string().optional(),
  reviewedBy: z.string().optional(),
});

const ConstraintSchema = z.object({
  id: z.string(),
  kind: z.string(),
  scope: z.string(),
  rule: z.string(),
  rationale: z.string().optional(),
  appliesTo: z.array(z.string()).optional(),
  status: z.enum(["active", "retired"]),
  createdAt: z.string(),
});

const TruthPacketSchema = z.object({
  constraints: z.array(ConstraintSchema),
  facts: z.array(FactSchema),
  assembledAt: z.string(),
  query: z.object({
    scope: z.string().optional(),
    hints: z.array(z.string()).optional(),
    kinds: z.array(z.string()).optional(),
  }),
  truncated: z.boolean().describe(
    "True when facts or constraints were capped by the query limit",
  ),
  totalFactsMatched: z.number().describe(
    "Number of facts matching the query before the limit was applied",
  ),
  totalConstraintsMatched: z.number().describe(
    "Number of constraints matching the query before the limit was applied",
  ),
});

const ProposalListSchema = z.object({
  proposals: z.array(ProposalSchema),
  total: z.number().describe(
    "Number of proposals matching the filter before the limit was applied",
  ),
  truncated: z.boolean().describe(
    "True when proposals were capped by the limit",
  ),
  filter: z.object({ status: z.string() }),
});

const FactListSchema = z.object({
  facts: z.array(FactSchema),
  total: z.number().describe(
    "Number of facts matching the filter before the limit was applied",
  ),
  truncated: z.boolean().describe(
    "True when facts were capped by the limit",
  ),
});

const CoverageGapSchema = z.object({
  repo: z.string().describe("Repository path"),
  gapType: z.string().describe(
    "Type of gap: no_facts, single_dimension, dangling_reference, no_index",
  ),
  detail: z.string().describe("Human-readable explanation of the gap"),
  suggestedQueries: z.array(z.string()).describe(
    "Hypothesis-driven search queries to fill this gap",
  ),
});

const CoverageGapsOutputSchema = z.object({
  gaps: z.array(CoverageGapSchema),
  summary: z.object({
    totalReposDiscovered: z.number(),
    reposWithFacts: z.number(),
    reposWithoutFacts: z.number(),
    reposWithIndex: z.number(),
    singleDimensionRepos: z.number(),
    danglingReferences: z.number(),
  }),
  generatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function factInstanceName(kind: string, identityValue: string): string {
  return `fact--${kind}--${encodeURIComponent(identityValue)}`;
}

function proposalInstanceName(id: string): string {
  return `proposal--${id}`;
}

function constraintInstanceName(id: string): string {
  return `constraint--${id}`;
}

// deno-lint-ignore no-explicit-any
type Ctx = any;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Model definition for `@twonines/fact-store`. Exposes the propose /
 * review / activate lifecycle over three primary resource specs (fact,
 * proposal, constraint) plus three read-side projections (truth-packet,
 * proposal-list, fact-list). Consumed by the bundled agent skills
 * `propose-facts` (ferret) and `review-proposals` (mole), and by any
 * agent calling `query` to assemble a truth packet before acting.
 */
export const model = {
  type: "@twonines/fact-store",
  version: "2026.07.08.1",
  description:
    "Stores, validates, and serves organizational facts for AI agent consumption. " +
    "Supports a propose→review→activate lifecycle with adversarial validation (ferret/mole pattern).",
  globalArguments: z.object({}),
  resources: {
    fact: {
      description: "An accepted, active truth claim about an entity",
      schema: FactSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    proposal: {
      description: "A candidate fact awaiting review",
      schema: ProposalSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    constraint: {
      description: "A human-curated behavioral rule",
      schema: ConstraintSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
    "truth-packet": {
      description: "Assembled context for agent consumption",
      schema: TruthPacketSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    "proposal-list": {
      description: "Filtered list of proposals",
      schema: ProposalListSchema,
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
    "fact-list": {
      description: "Filtered list of facts",
      schema: FactListSchema,
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
    "coverage-gaps": {
      description: "Analysis of knowledge gaps for curiosity-driven discovery",
      schema: CoverageGapsOutputSchema,
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    propose: {
      description:
        "Submit a candidate fact for adversarial review. Called by discovery agents (ferret).",
      arguments: z.object({
        kind: z.string().describe(
          "Fact kind (e.g. repository_deploys_to_account)",
        ),
        scope: z.string().default("global").describe(
          "Scope: global or narrower",
        ),
        subjectRef: SubjectRefSchema,
        value: z.unknown().describe(
          "The fact value (string, boolean, array, or object)",
        ),
        authorityBasis: AuthorityBasisSchema,
        proposedBy: z.string().describe("Agent or human identifier"),
        evidence: z.array(z.string()).optional().describe(
          "References to scan data or other sources",
        ),
      }),
      execute: async (
        args: {
          kind: string;
          scope: string;
          subjectRef: z.infer<typeof SubjectRefSchema>;
          value: unknown;
          authorityBasis: z.infer<typeof AuthorityBasisSchema>;
          proposedBy: string;
          evidence?: string[];
        },
        context: Ctx,
      ) => {
        const id = uuid();
        const data: z.infer<typeof ProposalSchema> = {
          id,
          kind: args.kind,
          scope: args.scope,
          subjectRef: args.subjectRef,
          value: args.value,
          authorityBasis: args.authorityBasis,
          status: "proposed",
          proposedBy: args.proposedBy,
          evidence: args.evidence,
          createdAt: now(),
        };

        const handle = await context.writeResource(
          "proposal",
          proposalInstanceName(id),
          data,
          {
            tags: {
              status: "proposed",
              kind: args.kind,
              scope: args.scope,
              refType: args.subjectRef.refType,
              identityKind: args.subjectRef.identityKind,
              identityValue: args.subjectRef.identityValue,
              proposedBy: args.proposedBy,
            },
          },
        );
        context.logger.info("Proposal created", {
          id,
          kind: args.kind,
          subject: args.subjectRef.identityValue,
        });
        return { dataHandles: [handle] };
      },
    },

    activate: {
      description:
        "Promote a proposal to an active fact. Called by reviewer agents (mole).",
      arguments: z.object({
        proposalId: z.string().describe("ID of the proposal to activate"),
        reviewedBy: z.string().describe("Reviewer agent or human identifier"),
      }),
      execute: async (
        args: { proposalId: string; reviewedBy: string },
        context: Ctx,
      ) => {
        const proposal = await context.readResource(
          proposalInstanceName(args.proposalId),
        );
        if (!proposal) {
          throw new Error(`Proposal ${args.proposalId} not found`);
        }
        if (proposal.status !== "proposed") {
          throw new Error(
            `Proposal ${args.proposalId} is ${proposal.status}, cannot activate`,
          );
        }

        // Update proposal status
        const updatedProposal = {
          ...proposal,
          status: "activated",
          reviewedAt: now(),
          reviewedBy: args.reviewedBy,
        };
        await context.writeResource(
          "proposal",
          proposalInstanceName(args.proposalId),
          updatedProposal,
          {
            tags: {
              status: "activated",
              kind: proposal.kind,
              scope: proposal.scope,
              refType: proposal.subjectRef.refType,
              identityKind: proposal.subjectRef.identityKind,
              identityValue: proposal.subjectRef.identityValue,
              proposedBy: proposal.proposedBy,
            },
          },
        );

        // Create the fact
        const factId = uuid();
        const fact: z.infer<typeof FactSchema> = {
          id: factId,
          kind: proposal.kind,
          scope: proposal.scope,
          subjectRef: proposal.subjectRef,
          value: proposal.value,
          authorityBasis: proposal.authorityBasis,
          status: "active",
          proposedBy: proposal.proposedBy,
          activatedBy: args.reviewedBy,
          createdAt: proposal.createdAt,
          activatedAt: now(),
        };

        const handle = await context.writeResource(
          "fact",
          factInstanceName(proposal.kind, proposal.subjectRef.identityValue),
          fact,
          {
            tags: {
              status: "active",
              kind: proposal.kind,
              scope: proposal.scope,
              refType: proposal.subjectRef.refType,
              identityKind: proposal.subjectRef.identityKind,
              identityValue: proposal.subjectRef.identityValue,
              authorityBasis: proposal.authorityBasis,
            },
          },
        );

        context.logger.info("Fact activated", {
          factId,
          kind: proposal.kind,
          subject: proposal.subjectRef.identityValue,
        });
        return { dataHandles: [handle] };
      },
    },

    reject: {
      description:
        "Reject a proposal with feedback. Called by reviewer agents (mole).",
      arguments: z.object({
        proposalId: z.string().describe("ID of the proposal to reject"),
        reason: z.string().describe(
          "Why this proposal was rejected — actionable feedback",
        ),
        reviewedBy: z.string().describe("Reviewer agent or human identifier"),
      }),
      execute: async (
        args: { proposalId: string; reason: string; reviewedBy: string },
        context: Ctx,
      ) => {
        const proposal = await context.readResource(
          proposalInstanceName(args.proposalId),
        );
        if (!proposal) {
          throw new Error(`Proposal ${args.proposalId} not found`);
        }
        if (proposal.status !== "proposed") {
          throw new Error(
            `Proposal ${args.proposalId} is ${proposal.status}, cannot reject`,
          );
        }

        const updated = {
          ...proposal,
          status: "rejected",
          rejectionReason: args.reason,
          reviewedAt: now(),
          reviewedBy: args.reviewedBy,
        };

        const handle = await context.writeResource(
          "proposal",
          proposalInstanceName(args.proposalId),
          updated,
          {
            tags: {
              status: "rejected",
              kind: proposal.kind,
              scope: proposal.scope,
              refType: proposal.subjectRef.refType,
              identityKind: proposal.subjectRef.identityKind,
              identityValue: proposal.subjectRef.identityValue,
              proposedBy: proposal.proposedBy,
            },
          },
        );

        context.logger.info("Proposal rejected", {
          id: args.proposalId,
          reason: args.reason,
        });
        return { dataHandles: [handle] };
      },
    },

    withdraw: {
      description:
        "Retract a proposal. Called by the proposing agent after acknowledging rejection feedback.",
      arguments: z.object({
        proposalId: z.string().describe("ID of the proposal to withdraw"),
      }),
      execute: async (args: { proposalId: string }, context: Ctx) => {
        const proposal = await context.readResource(
          proposalInstanceName(args.proposalId),
        );
        if (!proposal) {
          throw new Error(`Proposal ${args.proposalId} not found`);
        }
        if (proposal.status !== "proposed" && proposal.status !== "rejected") {
          throw new Error(
            `Proposal ${args.proposalId} is ${proposal.status}, cannot withdraw`,
          );
        }

        const updated = { ...proposal, status: "withdrawn" };
        const handle = await context.writeResource(
          "proposal",
          proposalInstanceName(args.proposalId),
          updated,
          {
            tags: {
              status: "withdrawn",
              kind: proposal.kind,
              scope: proposal.scope,
              refType: proposal.subjectRef.refType,
              identityKind: proposal.subjectRef.identityKind,
              identityValue: proposal.subjectRef.identityValue,
              proposedBy: proposal.proposedBy,
            },
          },
        );

        context.logger.info("Proposal withdrawn", { id: args.proposalId });
        return { dataHandles: [handle] };
      },
    },

    query: {
      description:
        "Assemble a truth packet of relevant constraints and facts for a given scope/task. " +
        "Called by any agent before acting — the primary consumption interface.",
      arguments: z.object({
        scope: z.string().optional().describe(
          "Repo path, service name, or entity identity to scope results",
        ),
        hints: z.array(z.string()).optional().describe(
          "Task keywords for relevance matching",
        ),
        kinds: z.array(z.string()).optional().describe(
          "Filter to specific fact kinds",
        ),
        limit: z.number().default(50).describe("Maximum facts to return"),
      }),
      execute: async (
        args: {
          scope?: string;
          hints?: string[];
          kinds?: string[];
          limit: number;
        },
        context: Ctx,
      ) => {
        // Get all data for this model and filter by tags
        const allData = await context.dataRepository.findAllForModel(
          context.modelType,
          context.modelId,
        );

        // Filter facts: specName=fact, status=active, scope/identity match
        const matchedFacts = allData
          .filter((d: { tags: Record<string, string> }) => {
            const t = d.tags;
            if (t.specName !== "fact" || t.status !== "active") return false;
            if (args.scope) {
              if (t.identityValue !== args.scope && t.scope !== args.scope) {
                return false;
              }
            }
            if (args.kinds && args.kinds.length > 0) {
              if (!args.kinds.includes(t.kind)) return false;
            }
            return true;
          });
        const totalFactsMatched = matchedFacts.length;
        const facts = matchedFacts.slice(0, args.limit);

        // Read actual content for matched facts
        const factContents = [];
        for (const d of facts) {
          const content = await context.dataRepository.getContent(
            context.modelType,
            context.modelId,
            d.name,
          );
          if (content) {
            try {
              factContents.push(JSON.parse(new TextDecoder().decode(content)));
            } catch { /* skip unparseable */ }
          }
        }

        // Filter constraints: specName=constraint, status=active
        const matchedConstraints = allData
          .filter((d: { tags: Record<string, string> }) =>
            d.tags.specName === "constraint" && d.tags.status === "active"
          );
        const totalConstraintsMatched = matchedConstraints.length;
        const constraintData = matchedConstraints.slice(0, 100);

        const constraintContents = [];
        for (const d of constraintData) {
          const content = await context.dataRepository.getContent(
            context.modelType,
            context.modelId,
            d.name,
          );
          if (content) {
            try {
              constraintContents.push(
                JSON.parse(new TextDecoder().decode(content)),
              );
            } catch { /* skip */ }
          }
        }

        // Filter constraints by appliesTo hints if provided
        let filteredConstraints = constraintContents;
        if (args.hints && args.hints.length > 0) {
          const hintsLower = args.hints.map((h: string) => h.toLowerCase());
          filteredConstraints = constraintContents.filter(
            (c: z.infer<typeof ConstraintSchema>) => {
              if (!c.appliesTo || c.appliesTo.length === 0) return true;
              return c.appliesTo.some((a: string) =>
                hintsLower.some((h: string) =>
                  a.toLowerCase().includes(h) || h.includes(a.toLowerCase())
                )
              );
            },
          );
        }

        const packet: z.infer<typeof TruthPacketSchema> = {
          constraints: filteredConstraints,
          facts: factContents,
          assembledAt: now(),
          query: { scope: args.scope, hints: args.hints, kinds: args.kinds },
          truncated: totalFactsMatched > factContents.length ||
            totalConstraintsMatched > constraintData.length,
          totalFactsMatched,
          totalConstraintsMatched,
        };

        const handle = await context.writeResource(
          "truth-packet",
          `query--${(args.scope ?? "global").replaceAll("/", "--")}`,
          packet,
        );

        context.logger.info("Truth packet assembled", {
          facts: factContents.length,
          constraints: filteredConstraints.length,
        });
        return { dataHandles: [handle] };
      },
    },

    list_proposals: {
      description:
        "List proposals filtered by status. Used by mole to find work, by ferret to check rejections.",
      arguments: z.object({
        status: z.enum([
          "proposed",
          "rejected",
          "activated",
          "withdrawn",
          "all",
        ]).default("proposed"),
        limit: z.number().default(50),
      }),
      execute: async (
        args: { status: string; limit: number },
        context: Ctx,
      ) => {
        const allData = await context.dataRepository.findAllForModel(
          context.modelType,
          context.modelId,
        );

        const matches = allData
          .filter((d: { tags: Record<string, string> }) => {
            const t = d.tags;
            if (t.specName !== "proposal") return false;
            if (args.status !== "all" && t.status !== args.status) return false;
            return true;
          });
        const total = matches.length;
        const matched = matches.slice(0, args.limit);

        const proposals = [];
        for (const d of matched) {
          const content = await context.dataRepository.getContent(
            context.modelType,
            context.modelId,
            d.name,
          );
          if (content) {
            try {
              proposals.push(JSON.parse(new TextDecoder().decode(content)));
            } catch { /* skip */ }
          }
        }

        const result: z.infer<typeof ProposalListSchema> = {
          proposals,
          total,
          truncated: total > proposals.length,
          filter: { status: args.status },
        };

        const handle = await context.writeResource(
          "proposal-list",
          `list--${args.status}`,
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    list_facts: {
      description: "List active facts, optionally filtered by scope or kind.",
      arguments: z.object({
        scope: z.string().optional().describe("Filter by scope"),
        kind: z.string().optional().describe("Filter by fact kind"),
        identityValue: z.string().optional().describe(
          "Filter by subject identity",
        ),
        limit: z.number().default(100),
      }),
      execute: async (
        args: {
          scope?: string;
          kind?: string;
          identityValue?: string;
          limit: number;
        },
        context: Ctx,
      ) => {
        const allData = await context.dataRepository.findAllForModel(
          context.modelType,
          context.modelId,
        );

        const matches = allData
          .filter((d: { tags: Record<string, string> }) => {
            const t = d.tags;
            if (t.specName !== "fact" || t.status !== "active") return false;
            if (args.scope && t.scope !== args.scope) return false;
            if (args.kind && t.kind !== args.kind) return false;
            if (args.identityValue && t.identityValue !== args.identityValue) {
              return false;
            }
            return true;
          });
        const total = matches.length;
        const matched = matches.slice(0, args.limit);

        const facts = [];
        for (const d of matched) {
          const content = await context.dataRepository.getContent(
            context.modelType,
            context.modelId,
            d.name,
          );
          if (content) {
            try {
              facts.push(JSON.parse(new TextDecoder().decode(content)));
            } catch { /* skip */ }
          }
        }

        const result: z.infer<typeof FactListSchema> = {
          facts,
          total,
          truncated: total > facts.length,
        };

        const handle = await context.writeResource(
          "fact-list",
          `list--${args.kind ?? "all"}`,
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    add_constraint: {
      description:
        "Add a behavioral constraint (human-curated rule). Not derived from evidence — authored by people.",
      arguments: z.object({
        kind: z.string().describe(
          "Constraint kind: process, required_execution_path, naming_convention, security_boundary, deployment_rule",
        ),
        scope: z.string().default("global"),
        rule: z.string().describe("The constraint rule text"),
        rationale: z.string().optional().describe("Why this constraint exists"),
        appliesTo: z.array(z.string()).optional().describe(
          "Tags for matching: language names, tool names, repo patterns",
        ),
      }),
      execute: async (
        args: {
          kind: string;
          scope: string;
          rule: string;
          rationale?: string;
          appliesTo?: string[];
        },
        context: Ctx,
      ) => {
        const id = uuid();
        const data: z.infer<typeof ConstraintSchema> = {
          id,
          kind: args.kind,
          scope: args.scope,
          rule: args.rule,
          rationale: args.rationale,
          appliesTo: args.appliesTo,
          status: "active",
          createdAt: now(),
        };

        const handle = await context.writeResource(
          "constraint",
          constraintInstanceName(id),
          data,
          {
            tags: {
              status: "active",
              kind: args.kind,
              scope: args.scope,
            },
          },
        );

        context.logger.info("Constraint added", { id, kind: args.kind });
        return { dataHandles: [handle] };
      },
    },

    coverage_gaps: {
      description:
        "Analyze the fact store for knowledge gaps — repos with no facts, " +
        "single-dimension coverage, dangling references, and unindexed repos. " +
        "Returns suggested search queries for each gap. Used by ferret to " +
        "prioritize discovery work.",
      arguments: z.object({
        discoveredRepos: z.array(z.string()).optional().describe(
          "List of known repo paths. If omitted, analyzes only repos already in the fact store.",
        ),
        indexedRepos: z.array(z.string()).optional().describe(
          "List of repos that have been indexed (have a searchable db). Gaps flagged for unindexed repos.",
        ),
        limit: z.number().default(50).describe(
          "Max gaps to return, prioritized by impact.",
        ),
      }),
      execute: async (
        args: {
          discoveredRepos?: string[];
          indexedRepos?: string[];
          limit: number;
        },
        context: Ctx,
      ) => {
        context.logger.info("Analyzing coverage gaps");

        // Load all active facts
        const allData = await context.dataRepository.findAllForModel(
          context.modelType,
          context.modelId,
        );
        const factData = allData.filter(
          (d: { tags: Record<string, string> }) =>
            d.tags.specName === "fact" && d.tags.status === "active",
        );

        interface FactRecord {
          kind: string;
          scope: string;
          value: unknown;
          subjectRef: { identityValue: string };
        }

        const facts: FactRecord[] = [];
        for (const d of factData) {
          const content = await context.dataRepository.getContent(
            context.modelType,
            context.modelId,
            d.name,
          );
          if (content) {
            try {
              facts.push(JSON.parse(new TextDecoder().decode(content)));
            } catch { /* skip */ }
          }
        }

        // Build per-repo analysis
        const factsByRepo = new Map<string, FactRecord[]>();
        for (const f of facts) {
          const repo = f.scope;
          if (!factsByRepo.has(repo)) factsByRepo.set(repo, []);
          factsByRepo.get(repo)!.push(f);
        }

        const discovered = new Set(args.discoveredRepos ?? []);
        const indexed = new Set(args.indexedRepos ?? []);
        const gaps: z.infer<typeof CoverageGapSchema>[] = [];

        // 1. Repos discovered but with no facts
        for (const repo of discovered) {
          if (!factsByRepo.has(repo)) {
            const isIndexed = indexed.has(repo);
            gaps.push({
              repo,
              gapType: isIndexed ? "no_facts" : "no_index",
              detail: isIndexed
                ? `Repo is indexed but has zero facts. Discovery hasn't run against it yet.`
                : `Repo is discovered but not yet indexed. Index it first, then run discovery.`,
              suggestedQueries: isIndexed
                ? [
                  "what does this software do and who uses it",
                  "how does this deploy and to what environment",
                  "what external services or APIs does this integrate with",
                ]
                : [],
            });
          }
        }

        // 2. Repos with only one dimension of facts (all kinds share a pattern)
        for (const [repo, repoFacts] of factsByRepo) {
          if (repoFacts.length < 1) continue;
          const kinds = repoFacts.map((f) => f.kind);
          const allInfra = kinds.every((k) =>
            k.includes("deploy") || k.includes("provision") ||
            k.includes("manages") || k.includes("cluster") ||
            k.includes("infra") || k.includes("eks") ||
            k.includes("account") || k.includes("lambda") ||
            k.includes("runner") || k.includes("bastion")
          );
          if (allInfra && repoFacts.length >= 1) {
            gaps.push({
              repo,
              gapType: "single_dimension",
              detail:
                `All ${repoFacts.length} fact(s) are infrastructure/deployment. No domain, ownership, or architecture facts.`,
              suggestedQueries: [
                "what is the business purpose of this application",
                "what data model or database does this use",
                "who owns this and what team maintains it",
                "what architectural decisions or patterns does this follow",
              ],
            });
          }
        }

        // 3. Dangling references — values that mention repos with no facts
        for (const f of facts) {
          const valueStr = typeof f.value === "string"
            ? f.value
            : JSON.stringify(f.value);
          // Look for repo-path-like references in values
          const repoRefs = valueStr.match(
            /(?:sourceRepo|toolSourceRepo|ciTemplateProject|relatedRepos)['":\s]*['"]?([a-zA-Z0-9_-]+\/[a-zA-Z0-9_\/-]+)/g,
          );
          if (repoRefs) {
            for (const match of repoRefs) {
              const ref = match.replace(
                /.*?['"]?([a-zA-Z0-9_-]+\/[a-zA-Z0-9_\/-]+).*/,
                "$1",
              );
              if (ref && !factsByRepo.has(ref) && ref !== f.scope) {
                // Avoid duplicate gap entries for same repo
                if (
                  !gaps.some((g) =>
                    g.repo === ref && g.gapType === "dangling_reference"
                  )
                ) {
                  gaps.push({
                    repo: ref,
                    gapType: "dangling_reference",
                    detail:
                      `Referenced by fact in ${f.scope} (kind: ${f.kind}) but has no facts of its own.`,
                    suggestedQueries: [
                      "what tools or artifacts does this repository produce",
                      "what is the purpose of this project",
                      "what other repos consume output from this",
                    ],
                  });
                }
              }
            }
          }
        }

        // Sort: no_index last (can't act on them), dangling_reference first (high signal)
        const priority: Record<string, number> = {
          dangling_reference: 0,
          single_dimension: 1,
          no_facts: 2,
          no_index: 3,
        };
        gaps.sort((a, b) =>
          (priority[a.gapType] ?? 9) - (priority[b.gapType] ?? 9)
        );

        const limited = gaps.slice(0, args.limit);

        const output: z.infer<typeof CoverageGapsOutputSchema> = {
          gaps: limited,
          summary: {
            totalReposDiscovered: discovered.size,
            reposWithFacts: factsByRepo.size,
            reposWithoutFacts:
              [...discovered].filter((r) => !factsByRepo.has(r)).length,
            reposWithIndex: indexed.size,
            singleDimensionRepos:
              gaps.filter((g) => g.gapType === "single_dimension").length,
            danglingReferences:
              gaps.filter((g) => g.gapType === "dangling_reference").length,
          },
          generatedAt: now(),
        };

        const handle = await context.writeResource(
          "coverage-gaps",
          "latest-analysis",
          output,
        );

        context.logger.info("Coverage gaps: {total} gaps found", {
          total: limited.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
