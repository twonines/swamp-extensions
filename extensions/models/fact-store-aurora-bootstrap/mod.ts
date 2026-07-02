/**
 * Provisioner model for @twonines/fact-store-aurora-bootstrap.
 *
 * Provisions an AWS Aurora Postgres Serverless v2 cluster suitable for
 * backing @twonines/fact-store via @webframp/postgres-datastore. Also
 * creates an IAM managed policy scoped to `rds-db:connect` on the cluster
 * and an IAM workload role that trusts a caller-supplied principal.
 *
 * The `provision` method is idempotent — re-running against an already
 * provisioned environment self-heals partial failures rather than
 * duplicating resources.
 *
 * @module
 */

import { z } from "zod";
import { RDSClient } from "@aws-sdk/client-rds";
import { EC2Client } from "@aws-sdk/client-ec2";
import { IAMClient } from "@aws-sdk/client-iam";
import { STSClient } from "@aws-sdk/client-sts";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  attachPolicyToRole,
  ensureCluster,
  ensureInstance,
  ensureManagedPolicy,
  ensureSecurityGroup,
  ensureSubnetGroup,
  ensureWorkloadRole,
  type GlobalArgs,
  grantRdsIam,
  verifyCallerIdentity,
} from "./_lib/impl.ts";

// ---------------------------------------------------------------------------
// Global argument schema (validated on model create, wire from workflow inputs)
// ---------------------------------------------------------------------------

const AccountIdSchema = z
  .string()
  .regex(/^\d{12}$/, "AWS account ID must be a 12-digit string");

const RegionSchema = z
  .string()
  .regex(
    /^[a-z]{2}-[a-z]+-\d$/,
    "AWS region must look like us-east-1, eu-west-2, etc.",
  );

const VpcIdSchema = z
  .string()
  .regex(/^vpc-[0-9a-f]{8,17}$/, "VPC ID must look like vpc-xxxxxxxx");

const SubnetIdSchema = z
  .string()
  .regex(/^subnet-[0-9a-f]{8,17}$/, "Subnet ID must look like subnet-xxxxxxxx");

const CidrSchema = z
  .string()
  .regex(
    /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/,
    "Ingress CIDR must be a valid IPv4 CIDR block",
  );

const ArnSchema = z
  .string()
  .regex(/^arn:aws:.+$/, "Trust principal must be an AWS ARN");

const IdentifierSchema = z
  .string()
  .regex(
    /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/,
    "Identifier must start with a letter, contain only letters/digits/hyphens, max 63 chars",
  );

export const GlobalArgsSchema = z.object({
  account_id: AccountIdSchema.describe(
    "Expected AWS account ID. Provisioner verifies caller identity matches before mutating.",
  ),
  region: RegionSchema.describe("AWS region for all resources"),
  vpc_id: VpcIdSchema.describe("Existing VPC to place the DB subnet group in"),
  subnet_ids: z
    .array(SubnetIdSchema)
    .min(2, "RDS DB subnet group requires at least 2 subnets in different AZs")
    .describe("Subnet IDs (at least 2 across distinct AZs)"),
  ingress_cidr: CidrSchema.describe(
    "IPv4 CIDR allowed to reach the cluster on 5432 via the security group",
  ),
  workload_role_trust_principal: ArnSchema.describe(
    "ARN allowed to sts:AssumeRole into the fact-store workload role " +
      "(e.g., an AWS SSO permission set role ARN or an IAM role/user ARN)",
  ),
  master_username: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/)
    .default("fact_store_admin")
    .describe(
      "Postgres master username (also the IAM DB auth identity). This user is " +
        "granted rds-db:connect by the managed policy this bootstrap creates.",
    ),
  cluster_identifier: IdentifierSchema.default("fact-store-db-cluster")
    .describe(
      "RDS DB cluster identifier",
    ),
  instance_identifier: IdentifierSchema.default(
    "fact-store-db-instance-1",
  ).describe("RDS DB instance identifier (writer)"),
  subnet_group_name: IdentifierSchema.default(
    "fact-store-db-subnets",
  ).describe("RDS DB subnet group name"),
  security_group_name: IdentifierSchema.default(
    "fact-store-db-sg",
  ).describe("EC2 security group name"),
  managed_policy_name: IdentifierSchema.default(
    "fact-store-db-connect-policy",
  ).describe("IAM managed policy name (rds-db:connect scoped to the cluster)"),
  workload_role_name: IdentifierSchema.default(
    "fact-store-workload",
  ).describe("IAM role name for the fact-store workload"),
  engine_version: z
    .string()
    .default("16.6")
    .describe("Aurora Postgres engine version"),
  min_acu: z
    .number()
    .min(0.5)
    .max(128)
    .default(0.5)
    .describe("Serverless v2 minimum ACU"),
  max_acu: z
    .number()
    .min(0.5)
    .max(128)
    .default(2)
    .describe("Serverless v2 maximum ACU"),
  publicly_accessible: z
    .boolean()
    .default(false)
    .describe(
      "Whether the writer instance has a public endpoint. Only set true in " +
        "throwaway lab environments — never in prod.",
    ),
  backup_retention_days: z
    .number()
    .int()
    .min(1)
    .max(35)
    .default(1)
    .describe("BackupRetentionPeriod in days"),
  tags: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      "Optional map of Key -> Value tags applied to every newly-created " +
        "AWS resource (subnet group, security group, cluster, instance, " +
        "managed policy, workload role). Existing (adopted) resources are " +
        "not modified.",
    ),
});

// ---------------------------------------------------------------------------
// Output resource schema
// ---------------------------------------------------------------------------

export const StateSchema = z.object({
  account_id: z.string(),
  region: z.string(),
  cluster_identifier: z.string(),
  cluster_endpoint: z.string().describe("Writer endpoint hostname"),
  cluster_port: z.number(),
  cluster_arn: z.string(),
  cluster_resource_id: z
    .string()
    .describe(
      "DbClusterResourceId (cluster-XYZ) — this is the ID used in " +
        "rds-db:connect resource ARNs",
    ),
  master_user_secret_arn: z
    .string()
    .optional()
    .describe(
      "Secrets Manager ARN holding the cluster's master password " +
        "(populated when the cluster was created with " +
        "ManageMasterUserPassword=true; undefined for adopted clusters " +
        "created by some other mechanism).",
    ),
  instance_identifier: z.string(),
  instance_arn: z.string(),
  security_group_id: z.string(),
  subnet_group_name: z.string(),
  managed_policy_name: z.string(),
  managed_policy_arn: z.string(),
  workload_role_name: z.string(),
  workload_role_arn: z.string(),
  master_username: z.string(),
  provisioned_at: z.string().describe("ISO-8601 timestamp of provisioning"),
});

export type State = z.infer<typeof StateSchema>;

// deno-lint-ignore no-explicit-any
type Ctx = any;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export const model = {
  type: "@twonines/fact-store-aurora-bootstrap/provisioner",
  version: "2026.07.02.6",
  description:
    "Bootstrap provisioner for @twonines/fact-store on AWS Aurora Postgres Serverless v2. " +
    "Creates the cluster, writer instance, security group, subnet group, an rds-db:connect " +
    "managed policy scoped to the cluster, and an IAM workload role that trusts a caller-supplied principal.",
  globalArguments: GlobalArgsSchema,
  resources: {
    state: {
      description:
        "Aurora + IAM resources provisioned for the fact-store backing store",
      schema: StateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    provision: {
      description:
        "Create or verify the Aurora cluster, security group, subnet group, " +
        "managed policy, and workload IAM role. Idempotent — safe to re-run.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = context.globalArgs as GlobalArgs;
        const logger = context.logger;

        // Clients — one per AWS service.
        const sts = new STSClient({ region: g.region });
        const rds = new RDSClient({ region: g.region });
        const ec2 = new EC2Client({ region: g.region });
        const iam = new IAMClient({ region: g.region });
        const sm = new SecretsManagerClient({ region: g.region });

        // Safety guard: verify AWS caller identity matches the workflow's
        // declared account_id before mutating any resources.
        const accountId = await verifyCallerIdentity(sts, g.account_id, logger);

        // Provision network primitives first — cluster creation depends on both.
        const subnetGroupName = await ensureSubnetGroup(rds, g, logger);
        const securityGroupId = await ensureSecurityGroup(ec2, g, logger);

        // Cluster — this blocks until Status == "available" (30-90s for
        // Serverless v2 first-time creation).
        const cluster = await ensureCluster(
          rds,
          g,
          subnetGroupName,
          securityGroupId,
          logger,
        );

        // Writer instance — blocks until available (can take several minutes
        // for db.serverless on first creation).
        const instance = await ensureInstance(rds, g, logger);

        // Grant rds_iam to the master user. Required for IAM DB auth to
        // actually work — CreateDBCluster does not do this automatically.
        // Idempotent (Postgres GRANT is a no-op when already granted).
        await grantRdsIam(
          sm,
          cluster,
          g.region,
          g.master_username,
          logger,
        );

        // IAM managed policy scoped to `rds-db:connect` on the specific
        // dbuser ARN. Needs the cluster resource ID (not name) so it survives
        // cluster rename/recreate.
        const managedPolicyArn = await ensureManagedPolicy(
          iam,
          accountId,
          g,
          cluster.cluster_resource_id,
          logger,
        );

        // Workload role that trusts the caller-supplied principal. This is
        // the identity fact-store operations run under after `sts:AssumeRole`.
        const workloadRoleArn = await ensureWorkloadRole(iam, g, logger);

        // Attach the connect-policy to the workload role. Idempotent.
        await attachPolicyToRole(
          iam,
          g.workload_role_name,
          managedPolicyArn,
          logger,
        );

        const state: State = {
          account_id: accountId,
          region: g.region,
          cluster_identifier: g.cluster_identifier,
          cluster_endpoint: cluster.cluster_endpoint,
          cluster_port: cluster.cluster_port,
          cluster_arn: cluster.cluster_arn,
          cluster_resource_id: cluster.cluster_resource_id,
          master_user_secret_arn: cluster.master_user_secret_arn,
          instance_identifier: instance.instance_identifier,
          instance_arn: instance.instance_arn,
          security_group_id: securityGroupId,
          subnet_group_name: subnetGroupName,
          managed_policy_name: g.managed_policy_name,
          managed_policy_arn: managedPolicyArn,
          workload_role_name: g.workload_role_name,
          workload_role_arn: workloadRoleArn,
          master_username: g.master_username,
          provisioned_at: new Date().toISOString(),
        };

        const handle = await context.writeResource("state", "state", state);
        logger.info("fact-store Aurora bootstrap complete", {
          cluster_endpoint: state.cluster_endpoint,
          workload_role_arn: state.workload_role_arn,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
