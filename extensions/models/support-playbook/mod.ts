// deno-lint-ignore-file no-import-prefix
/**
 * Shared routing rules for support-request workflows.
 *
 * A rule records who owns a kind of ticket and what your team does about it
 * (for example: "Device names belong to the device owner"). Rules live
 * in the swamp datastore, so every person who runs the workflows reads the same
 * rules. A workflow reads them with
 * `data.latest("support-playbook", "rules").attributes.rules`.
 *
 * @module
 */
import { z } from "npm:zod@4";

const RuleSchema = z.object({
  id: z.string().min(1).describe("Stable key. Adding the same id replaces it."),
  rule: z.string().min(1).describe("What to do, or not do, for this ticket"),
  why: z.string().describe("The ticket or fact that the rule comes from"),
  addedAt: z.string(),
});

const RulesSchema = z.object({
  rules: z.array(RuleSchema),
  updatedAt: z.string(),
});

type Rule = z.infer<typeof RuleSchema>;

/** Add new rules and replace rules with the same id. Keep the order of ids. */
export function upsertRules(existing: Rule[], incoming: Rule[]): Rule[] {
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()];
}

/** Model that stores the routing rules. The method `add_rules` adds or replaces rules. */
export const model = {
  type: "@twonines/support-playbook",
  version: "2026.10.30.1",
  globalArguments: z.object({}),
  resources: {
    rules: {
      description: "All routing rules for support requests",
      schema: RulesSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    add_rules: {
      description:
        "Add routing rules, or replace rules that have the same id. Reads the stored rules, merges, and writes one new version.",
      arguments: z.object({
        rules: z.array(
          z.object({
            id: z.string().min(1),
            rule: z.string().min(1),
            why: z.string().default(""),
          }),
        ).min(1),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: { rules: any[] }, context: any) => {
        // readResource returns null on the first run. Any read error stops the
        // method, so a failed read never overwrites the stored rules.
        const existing: Rule[] = (await context.readResource("rules"))?.rules ??
          [];
        const now = new Date().toISOString();
        const merged = upsertRules(
          existing,
          args.rules.map((r) => ({ ...r, addedAt: now })),
        );
        const handle = await context.writeResource("rules", "rules", {
          rules: merged,
          updatedAt: now,
        });
        context.logger.info("Stored rules", { total: merged.length });
        return { dataHandles: [handle] };
      },
    },
  },
};
