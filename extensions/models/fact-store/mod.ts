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
import sqlite3InitModule from "npm:@sqlite.org/sqlite-wasm@3.53.0-build1";

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
  version: "2026.07.08.2",
  description:
    "Stores, validates, and serves organizational facts for AI agent consumption. " +
    "Supports a propose→review→activate lifecycle with adversarial validation (ferret/mole pattern).",
  globalArguments: z.object({
    embedUrl: z.string().url().optional().describe(
      "OpenAI-compatible embeddings endpoint (required for export method).",
    ),
    embedToken: z.string().meta({ sensitive: true }).optional().describe(
      "Bearer token for the embeddings API (required for export method).",
    ),
    embedModel: z.string().optional().describe(
      "Embedding model ID (default: text-embedding-3-small).",
    ),
    embedDim: z.number().optional().describe(
      "Vector dimension (default: 1536).",
    ),
    outputPath: z.string().optional().describe(
      "Path for the exported SQLite db (default: ~/.jitter/facts.db).",
    ),
  }),
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
    "export-state": {
      description: "Result of the last fact export to SQLite",
      schema: z.object({
        exportedAt: z.string(),
        outputPath: z.string(),
        embedModel: z.string(),
        embedDim: z.number(),
        factCount: z.number(),
        constraintCount: z.number(),
        outputBytes: z.number(),
        sha256: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 5,
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

    export: {
      description:
        "Export all active facts and constraints to a local SQLite database " +
        "with FTS5 full-text indexes and vector embeddings for hybrid search. " +
        "Writes to outputPath (default ~/.jitter/facts.db). Run after " +
        "activating new facts to refresh the jitter consumer db.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: Ctx,
      ) => {
        const g = context.globalArgs as {
          embedUrl?: string;
          embedToken?: string;
          embedModel?: string;
          embedDim?: number;
          outputPath?: string;
        };
        if (!g.embedUrl || !g.embedToken) {
          throw new Error(
            "Export requires embedUrl and embedToken in globalArguments.",
          );
        }
        const embedModel = g.embedModel ?? "text-embedding-3-small";
        const embedDim = g.embedDim ?? 1536;
        const outputPath = expandPath(g.outputPath ?? "~/.jitter/facts.db");

        context.logger.info("Exporting facts to {path}", { path: outputPath });

        // Load all active facts
        const allData = await context.dataRepository.findAllForModel(
          context.modelType,
          context.modelId,
        );
        const factRecords = allData.filter(
          (d: { tags: Record<string, string> }) =>
            d.tags.specName === "fact" && d.tags.status === "active",
        );
        const constraintRecords = allData.filter(
          (d: { tags: Record<string, string> }) =>
            d.tags.specName === "constraint" && d.tags.status === "active",
        );

        const facts: ExportFact[] = [];
        for (const d of factRecords) {
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

        const constraints: ExportConstraint[] = [];
        for (const d of constraintRecords) {
          const content = await context.dataRepository.getContent(
            context.modelType,
            context.modelId,
            d.name,
          );
          if (content) {
            try {
              constraints.push(JSON.parse(new TextDecoder().decode(content)));
            } catch { /* skip */ }
          }
        }

        context.logger.info(
          "Loaded {facts} facts, {constraints} constraints",
          { facts: facts.length, constraints: constraints.length },
        );

        // Flatten to searchable text
        const factTexts = facts.map(flattenFactForExport);
        const constraintTexts = constraints.map(flattenConstraintForExport);
        const allTexts = [...factTexts, ...constraintTexts];

        // Embed
        let allEmbeddings: Float32Array[] = [];
        if (allTexts.length > 0) {
          allEmbeddings = await embedForExport(
            allTexts,
            g.embedUrl!,
            g.embedToken!,
            embedModel,
            embedDim,
            context.logger,
          );
        }
        const factEmbeddings = allEmbeddings.slice(0, factTexts.length);
        const constraintEmbeddings = allEmbeddings.slice(factTexts.length);

        // Build SQLite
        const dbBytes = await buildExportSqlite(
          facts,
          factTexts,
          factEmbeddings,
          constraints,
          constraintTexts,
          constraintEmbeddings,
          embedModel,
          embedDim,
          context.logger,
        );

        // Write to disk
        const dir = outputPath.slice(0, outputPath.lastIndexOf("/"));
        if (dir) {
          try {
            Deno.mkdirSync(dir, { recursive: true });
          } catch { /* exists */ }
        }
        Deno.writeFileSync(outputPath, dbBytes);

        const sha = await sha256Export(dbBytes);

        const result = {
          exportedAt: now(),
          outputPath,
          embedModel,
          embedDim,
          factCount: facts.length,
          constraintCount: constraints.length,
          outputBytes: dbBytes.byteLength,
          sha256: sha,
        };

        const handle = await context.writeResource(
          "export-state",
          "snapshot",
          result,
        );

        context.logger.info(
          "Export complete: {facts} facts, {constraints} constraints, {bytes} bytes",
          {
            facts: facts.length,
            constraints: constraints.length,
            bytes: dbBytes.byteLength,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------------

interface ExportFact {
  id: string;
  kind: string;
  scope: string;
  subjectRef: { refType: string; identityKind: string; identityValue: string };
  value: unknown;
  authorityBasis: string;
  proposedBy?: string;
  activatedBy?: string;
  createdAt?: string;
  activatedAt?: string;
  evidence?: string[];
}

interface ExportConstraint {
  id: string;
  kind: string;
  scope: string;
  rule: string;
  rationale?: string;
  appliesTo?: string[];
  createdAt?: string;
}

function flattenFactForExport(f: ExportFact): string {
  const parts: string[] = [];
  parts.push(`kind: ${f.kind}`);
  parts.push(
    `subject: ${f.subjectRef.refType} ${f.subjectRef.identityKind}=${f.subjectRef.identityValue}`,
  );
  parts.push(`scope: ${f.scope}`);
  const valStr = typeof f.value === "string"
    ? f.value
    : JSON.stringify(f.value ?? null);
  parts.push(`value: ${valStr}`);
  parts.push(`basis: ${f.authorityBasis}`);
  if (f.proposedBy) parts.push(`proposedBy: ${f.proposedBy}`);
  if (f.evidence && f.evidence.length > 0) {
    parts.push(`evidence: ${f.evidence.join(", ")}`);
  }
  return parts.join(" | ");
}

function flattenConstraintForExport(c: ExportConstraint): string {
  const parts: string[] = [];
  parts.push(`kind: ${c.kind}`);
  parts.push(`scope: ${c.scope}`);
  parts.push(`rule: ${c.rule}`);
  if (c.rationale) parts.push(`rationale: ${c.rationale}`);
  if (c.appliesTo && c.appliesTo.length > 0) {
    parts.push(`appliesTo: ${c.appliesTo.join(", ")}`);
  }
  return parts.join(" | ");
}

function tierForBasis(basis: string): number {
  switch (basis) {
    case "live_system_verification":
      return 0;
    case "file_is_the_mechanism":
      return 1;
    case "file_content_observation":
      return 2;
    case "human_claim_in_file":
    case "human_claim_in_ticket":
      return 3;
    case "agent_inference":
      return 4;
    default:
      return 4;
  }
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    const home = Deno.env.get("HOME");
    if (home) return `${home}/${p.slice(2)}`;
  }
  return p;
}

async function sha256Export(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function floatToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength).slice();
}

// ---------------------------------------------------------------------------
// Export: embedding
// ---------------------------------------------------------------------------

const EXPORT_BATCH_SIZE = 32;

async function embedForExport(
  texts: string[],
  url: string,
  token: string,
  model: string,
  dim: number,
  logger: { info: (m: string, f?: Record<string, unknown>) => void },
): Promise<Float32Array[]> {
  const out: Float32Array[] = new Array(texts.length);
  const endpoint = url.endsWith("/") ? `${url}embeddings` : `${url}/embeddings`;

  for (let i = 0; i < texts.length; i += EXPORT_BATCH_SIZE) {
    const batch = texts.slice(i, i + EXPORT_BATCH_SIZE);
    logger.info("Embedding batch {start}-{end} of {total}", {
      start: i,
      end: i + batch.length,
      total: texts.length,
    });

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: batch }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `Embedding API ${resp.status}: ${body.slice(0, 300)}`,
      );
    }

    const parsed = await resp.json() as {
      data: Array<{ embedding: number[]; index?: number }>;
    };

    for (const d of parsed.data) {
      const idx = (d.index ?? 0) + i;
      if (d.embedding.length !== dim) {
        throw new Error(
          `Embedding dim mismatch: got ${d.embedding.length}, expected ${dim}`,
        );
      }
      out[idx] = new Float32Array(d.embedding);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Export: SQLite construction
// ---------------------------------------------------------------------------

const EXPORT_SCHEMA_SQL = `
CREATE TABLE facts (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  subject_ref_type TEXT NOT NULL,
  subject_identity_kind TEXT NOT NULL,
  subject_identity_value TEXT NOT NULL,
  value_json TEXT NOT NULL,
  authority_basis TEXT NOT NULL,
  tier INTEGER NOT NULL,
  proposed_by TEXT,
  activated_by TEXT,
  created_at TEXT,
  activated_at TEXT,
  evidence_json TEXT NOT NULL,
  searchable_text TEXT NOT NULL,
  embedding BLOB
);
CREATE INDEX facts_kind ON facts(kind);
CREATE INDEX facts_subject ON facts(subject_identity_value);
CREATE INDEX facts_tier ON facts(tier);
CREATE VIRTUAL TABLE facts_fts USING fts5(searchable_text);

CREATE TABLE constraints (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  rule TEXT NOT NULL,
  rationale TEXT,
  applies_to_json TEXT NOT NULL,
  created_at TEXT,
  searchable_text TEXT NOT NULL,
  embedding BLOB
);
CREATE INDEX constraints_kind ON constraints(kind);
CREATE VIRTUAL TABLE constraints_fts USING fts5(searchable_text);

CREATE TABLE manifest (
  exported_at TEXT NOT NULL,
  embed_model TEXT NOT NULL,
  embed_dim INTEGER NOT NULL,
  fact_count INTEGER NOT NULL,
  constraint_count INTEGER NOT NULL,
  schema_version INTEGER NOT NULL
);
`;

const SQLITE_WASM_URL =
  "https://registry.npmjs.org/@sqlite.org/sqlite-wasm/-/sqlite-wasm-3.53.0-build1.tgz";

// deno-lint-ignore no-explicit-any
let cachedSqlite3Export: any = null;
let cachedWasmBytesExport: Uint8Array | null = null;

// deno-lint-ignore no-explicit-any
async function loadSqlite3Export(logger: any): Promise<any> {
  if (cachedSqlite3Export) return cachedSqlite3Export;
  if (!cachedWasmBytesExport) {
    logger.info("Loading sqlite3 WASM for export (first call)");
    const resp = await fetch(SQLITE_WASM_URL);
    if (!resp.ok) throw new Error(`WASM fetch failed: ${resp.status}`);
    const tarGz = new Uint8Array(await resp.arrayBuffer());
    cachedWasmBytesExport = await extractWasmFromTgz(tarGz);
  }
  cachedSqlite3Export = await sqlite3InitModule({
    wasmBinary: cachedWasmBytesExport,
  });
  return cachedSqlite3Export;
}

async function extractWasmFromTgz(tarGz: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(tarGz);
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    tar.set(c, offset);
    offset += c.byteLength;
  }
  const target = "package/dist/sqlite3.wasm";
  const decoder = new TextDecoder("utf-8");
  let pos = 0;
  while (pos + 512 <= tar.byteLength) {
    const header = tar.subarray(pos, pos + 512);
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
    const name = decoder.decode(header.subarray(0, nameEnd));
    if (!name) break;
    const sizeStr = decoder
      .decode(header.subarray(124, 136))
      .replace(/[\0 ]+$/g, "")
      .trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const dataStart = pos + 512;
    if (name === target) {
      return tar.subarray(dataStart, dataStart + size).slice();
    }
    pos = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`sqlite3.wasm not found in tarball`);
}

async function buildExportSqlite(
  facts: ExportFact[],
  factTexts: string[],
  factEmbeddings: Float32Array[],
  constraints: ExportConstraint[],
  constraintTexts: string[],
  constraintEmbeddings: Float32Array[],
  embedModel: string,
  embedDim: number,
  // deno-lint-ignore no-explicit-any
  logger: any,
): Promise<Uint8Array> {
  const sqlite3 = await loadSqlite3Export(logger);
  const db = new sqlite3.oo1.DB(":memory:", "ct");
  try {
    db.exec(EXPORT_SCHEMA_SQL);

    for (let i = 0; i < facts.length; i++) {
      const f = facts[i];
      const emb = factEmbeddings[i];
      db.exec({
        sql: `INSERT INTO facts (
                id, kind, scope, subject_ref_type, subject_identity_kind,
                subject_identity_value, value_json, authority_basis, tier,
                proposed_by, activated_by, created_at, activated_at,
                evidence_json, searchable_text, embedding
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bind: [
          f.id,
          f.kind,
          f.scope,
          f.subjectRef.refType,
          f.subjectRef.identityKind,
          f.subjectRef.identityValue,
          JSON.stringify(f.value ?? null),
          f.authorityBasis,
          tierForBasis(f.authorityBasis),
          f.proposedBy ?? null,
          f.activatedBy ?? null,
          f.createdAt ?? null,
          f.activatedAt ?? null,
          JSON.stringify(f.evidence ?? []),
          factTexts[i],
          emb ? floatToBlob(emb) : null,
        ],
      });
      db.exec({
        sql: `INSERT INTO facts_fts (rowid, searchable_text) VALUES (?, ?)`,
        bind: [i + 1, factTexts[i]],
      });
    }

    for (let i = 0; i < constraints.length; i++) {
      const c = constraints[i];
      const emb = constraintEmbeddings[i];
      db.exec({
        sql: `INSERT INTO constraints (
                id, kind, scope, rule, rationale, applies_to_json,
                created_at, searchable_text, embedding
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bind: [
          c.id,
          c.kind,
          c.scope,
          c.rule,
          c.rationale ?? null,
          JSON.stringify(c.appliesTo ?? []),
          c.createdAt ?? null,
          constraintTexts[i],
          emb ? floatToBlob(emb) : null,
        ],
      });
      db.exec({
        sql:
          `INSERT INTO constraints_fts (rowid, searchable_text) VALUES (?, ?)`,
        bind: [i + 1, constraintTexts[i]],
      });
    }

    db.exec({
      sql: `INSERT INTO manifest (
              exported_at, embed_model, embed_dim,
              fact_count, constraint_count, schema_version
            ) VALUES (?, ?, ?, ?, ?, ?)`,
      bind: [
        new Date().toISOString(),
        embedModel,
        embedDim,
        facts.length,
        constraints.length,
        1,
      ],
    });

    return sqlite3.capi.sqlite3_js_db_export(db) as Uint8Array;
  } finally {
    db.close();
  }
}
