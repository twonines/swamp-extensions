/**
 * SDK-backed helpers for the @twonines/fact-store-aurora-bootstrap provisioner.
 *
 * Each `ensure*` helper is idempotent:
 *   - If a resource matching the identifier does not exist, create it.
 *   - If it exists and matches the expected shape on the fields we care about,
 *     adopt it and return its identifiers without mutating.
 *   - If it exists but drifts on a field we care about, throw a descriptive
 *     error rather than silently reconcile. Reconciling drift is not the
 *     bootstrap's job — that's for ongoing lifecycle management via the
 *     first-party types.
 *
 * @module
 */

// deno-lint-ignore-file no-import-prefix
import {
  CreateDBClusterCommand,
  CreateDBInstanceCommand,
  CreateDBSubnetGroupCommand,
  DescribeDBClustersCommand,
  type DescribeDBClustersCommandOutput,
  DescribeDBInstancesCommand,
  DescribeDBSubnetGroupsCommand,
  RDSClient,
} from "npm:@aws-sdk/client-rds@3.1024.0";
import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  type EC2Client,
} from "npm:@aws-sdk/client-ec2@3.1024.0";
import {
  AttachRolePolicyCommand,
  CreatePolicyCommand,
  CreateRoleCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetRoleCommand,
  type IAMClient,
  ListAttachedRolePoliciesCommand,
} from "npm:@aws-sdk/client-iam@3.1024.0";
import {
  GetCallerIdentityCommand,
  type STSClient,
} from "npm:@aws-sdk/client-sts@3.1024.0";
import {
  GetSecretValueCommand,
  type SecretsManagerClient,
} from "npm:@aws-sdk/client-secrets-manager@3.1024.0";
import { Signer } from "npm:@aws-sdk/rds-signer@3.1024.0";
import postgres from "npm:postgres@3.4.5";

/**
 * Structured logger surface used by every provisioner helper. Provided by
 * the swamp method execution context — helpers accept it as an argument
 * rather than importing a concrete logger, so they remain trivially
 * testable with a fake.
 */
export interface Logger {
  info: (msg: string, props?: Record<string, unknown>) => void;
  warning: (msg: string, props?: Record<string, unknown>) => void;
  error: (msg: string, props?: Record<string, unknown>) => void;
}

/**
 * Runtime shape of the provisioner's globalArguments — the union of
 * caller-supplied AWS coordinates (account/region/VPC/subnets/ingress),
 * resource identifiers (all with sensible defaults), cluster sizing
 * (Serverless v2 ACU min/max, backup retention, engine version), and a
 * tags map applied to every newly-created resource. All fields also
 * validated by the Zod `GlobalArgsSchema` in `mod.ts`.
 */
export interface GlobalArgs {
  account_id: string;
  region: string;
  vpc_id: string;
  subnet_ids: string[];
  ingress_cidr: string;
  workload_role_trust_principal: string;
  master_username: string;
  cluster_identifier: string;
  instance_identifier: string;
  subnet_group_name: string;
  security_group_name: string;
  managed_policy_name: string;
  workload_role_name: string;
  engine_version: string;
  min_acu: number;
  max_acu: number;
  publicly_accessible: boolean;
  backup_retention_days: number;
  tags: Record<string, string>;
}

/**
 * Convert a Key->Value tag map into the AWS SDK's `[{ Key, Value }, ...]`
 * array shape used by RDS and IAM. Returns undefined for empty maps so
 * callers can conditionally include the Tags parameter.
 */
export function tagList(
  tags: Record<string, string>,
): Array<{ Key: string; Value: string }> | undefined {
  const entries = Object.entries(tags);
  if (entries.length === 0) return undefined;
  return entries.map(([Key, Value]) => ({ Key, Value }));
}

/**
 * Throw if the caller's AWS identity is in a different account than the one
 * the workflow inputs claim. Guards against pointing a lab bootstrap at prod
 * (or vice versa) due to a stale AWS profile.
 */
export async function verifyCallerIdentity(
  sts: STSClient,
  expectedAccountId: string,
  logger: Logger,
): Promise<string> {
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  const actual = identity.Account ?? "unknown";
  if (actual !== expectedAccountId) {
    throw new Error(
      `AWS caller identity mismatch: workflow input account_id=${expectedAccountId} ` +
        `but sts:GetCallerIdentity reports account=${actual} (arn=${identity.Arn}). ` +
        `Refusing to provision — verify the current AWS profile targets the correct account.`,
    );
  }
  logger.info("Caller identity verified", {
    account: actual,
    arn: identity.Arn,
  });
  return actual;
}

/**
 * Create the DB subnet group if absent; adopt if present and matching.
 * Returns the subnet group name (same as globalArgs.subnet_group_name).
 */
export async function ensureSubnetGroup(
  rds: RDSClient,
  g: GlobalArgs,
  logger: Logger,
): Promise<string> {
  try {
    const existing = await rds.send(
      new DescribeDBSubnetGroupsCommand({
        DBSubnetGroupName: g.subnet_group_name,
      }),
    );
    const group = existing.DBSubnetGroups?.[0];
    if (group) {
      // Verify VPC and subnet membership match. Drift → hard error.
      if (group.VpcId !== g.vpc_id) {
        throw new Error(
          `DB subnet group ${g.subnet_group_name} exists but is in VPC ` +
            `${group.VpcId}, expected ${g.vpc_id}. Refusing to reconcile.`,
        );
      }
      const foundSubnets = new Set(
        (group.Subnets ?? []).map((s) => s.SubnetIdentifier ?? ""),
      );
      const missing = g.subnet_ids.filter((s) => !foundSubnets.has(s));
      if (missing.length > 0) {
        throw new Error(
          `DB subnet group ${g.subnet_group_name} exists but is missing ` +
            `subnets: ${missing.join(", ")}. Refusing to reconcile.`,
        );
      }
      logger.info("DB subnet group adopted (already exists)", {
        name: g.subnet_group_name,
        vpc: g.vpc_id,
      });
      return g.subnet_group_name;
    }
  } catch (err) {
    // "DBSubnetGroupNotFoundFault" means we need to create — anything else is
    // a real error the caller should see.
    const name = (err as { name?: string }).name;
    if (name !== "DBSubnetGroupNotFoundFault") {
      throw err;
    }
  }

  logger.info("Creating DB subnet group", {
    name: g.subnet_group_name,
    vpc: g.vpc_id,
    subnets: g.subnet_ids,
  });
  await rds.send(
    new CreateDBSubnetGroupCommand({
      DBSubnetGroupName: g.subnet_group_name,
      DBSubnetGroupDescription:
        `Subnet group for @twonines/fact-store Aurora cluster (${g.cluster_identifier})`,
      SubnetIds: g.subnet_ids,
      Tags: tagList(g.tags),
    }),
  );
  return g.subnet_group_name;
}

/**
 * Create the security group + ingress rule if absent; adopt if present and
 * matching. Returns the security group ID (sg-...).
 */
export async function ensureSecurityGroup(
  ec2: EC2Client,
  g: GlobalArgs,
  logger: Logger,
): Promise<string> {
  const existing = await ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: "group-name", Values: [g.security_group_name] },
        { Name: "vpc-id", Values: [g.vpc_id] },
      ],
    }),
  );
  const found = existing.SecurityGroups?.[0];
  if (found?.GroupId) {
    // Verify our expected ingress rule is present.
    const hasRule = (found.IpPermissions ?? []).some((p) =>
      p.IpProtocol === "tcp" &&
      p.FromPort === 5432 &&
      p.ToPort === 5432 &&
      (p.IpRanges ?? []).some((r) => r.CidrIp === g.ingress_cidr)
    );
    if (!hasRule) {
      logger.info("Adding missing ingress rule to existing security group", {
        groupId: found.GroupId,
        cidr: g.ingress_cidr,
      });
      await ec2.send(
        new AuthorizeSecurityGroupIngressCommand({
          GroupId: found.GroupId,
          IpPermissions: [
            {
              IpProtocol: "tcp",
              FromPort: 5432,
              ToPort: 5432,
              IpRanges: [
                {
                  CidrIp: g.ingress_cidr,
                  Description: "fact-store Aurora Postgres ingress",
                },
              ],
            },
          ],
        }),
      );
    }
    logger.info("Security group adopted (already exists)", {
      groupId: found.GroupId,
      name: g.security_group_name,
    });
    return found.GroupId;
  }

  logger.info("Creating security group", {
    name: g.security_group_name,
    vpc: g.vpc_id,
  });
  const tagSpecs = tagList(g.tags);
  const created = await ec2.send(
    new CreateSecurityGroupCommand({
      GroupName: g.security_group_name,
      Description:
        `Aurora Postgres access for @twonines/fact-store (${g.cluster_identifier})`,
      VpcId: g.vpc_id,
      TagSpecifications: tagSpecs
        ? [{ ResourceType: "security-group", Tags: tagSpecs }]
        : undefined,
    }),
  );
  const groupId = created.GroupId;
  if (!groupId) {
    throw new Error(
      `CreateSecurityGroup returned no GroupId for ${g.security_group_name}`,
    );
  }

  await ec2.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [
        {
          IpProtocol: "tcp",
          FromPort: 5432,
          ToPort: 5432,
          IpRanges: [
            {
              CidrIp: g.ingress_cidr,
              Description: "fact-store Aurora Postgres ingress",
            },
          ],
        },
      ],
    }),
  );
  logger.info("Security group + ingress rule created", { groupId });
  return groupId;
}

/**
 * Structural output returned by `ensureCluster` — the small handful of
 * post-creation cluster identifiers downstream helpers (instance, managed
 * policy, workload role) and the workflow's configure step need to
 * reference. `master_user_secret_arn` is populated when the cluster was
 * created with `ManageMasterUserPassword: true` (the default for clusters
 * this bootstrap creates); undefined for adopted clusters created by some
 * other mechanism.
 */
export interface ClusterOutputs {
  cluster_arn: string;
  cluster_endpoint: string;
  cluster_port: number;
  cluster_resource_id: string;
  master_user_secret_arn: string | undefined;
}

/**
 * Create the Aurora Serverless v2 cluster if absent; adopt if present.
 * Waits for status to reach `available` before returning.
 */
export async function ensureCluster(
  rds: RDSClient,
  g: GlobalArgs,
  subnetGroupName: string,
  securityGroupId: string,
  logger: Logger,
): Promise<ClusterOutputs> {
  let existing: DescribeDBClustersCommandOutput | undefined;
  try {
    existing = await rds.send(
      new DescribeDBClustersCommand({
        DBClusterIdentifier: g.cluster_identifier,
      }),
    );
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== "DBClusterNotFoundFault") {
      throw err;
    }
  }

  const found = existing?.DBClusters?.[0];
  if (!found) {
    logger.info("Creating Aurora DB cluster", {
      identifier: g.cluster_identifier,
      engine: `aurora-postgresql-${g.engine_version}`,
      acu: `${g.min_acu}-${g.max_acu}`,
    });
    await rds.send(
      new CreateDBClusterCommand({
        DBClusterIdentifier: g.cluster_identifier,
        Engine: "aurora-postgresql",
        EngineVersion: g.engine_version,
        MasterUsername: g.master_username,
        // Cluster is intended for IAM-only auth (see EnableIAMDatabaseAuthentication
        // below). The RDS CreateDBCluster API still requires that ONE of
        // MasterUserPassword / ManageMasterUserPassword is set, so we set
        // ManageMasterUserPassword=true and let AWS generate + store a random
        // password in Secrets Manager. That password is never used by this
        // bootstrap or its consumers; all authentication happens via IAM.
        ManageMasterUserPassword: true,
        EnableIAMDatabaseAuthentication: true,
        DBSubnetGroupName: subnetGroupName,
        VpcSecurityGroupIds: [securityGroupId],
        ServerlessV2ScalingConfiguration: {
          MinCapacity: g.min_acu,
          MaxCapacity: g.max_acu,
        },
        StorageEncrypted: true,
        BackupRetentionPeriod: g.backup_retention_days,
        Tags: tagList(g.tags),
      }),
    );
  } else {
    // Drift checks on fields that materially affect operation.
    if (found.Engine !== "aurora-postgresql") {
      throw new Error(
        `Cluster ${g.cluster_identifier} exists but engine is ` +
          `${found.Engine}, expected aurora-postgresql. Refusing to reconcile.`,
      );
    }
    if (found.MasterUsername !== g.master_username) {
      throw new Error(
        `Cluster ${g.cluster_identifier} exists but MasterUsername is ` +
          `${found.MasterUsername}, expected ${g.master_username}.`,
      );
    }
    if (!found.IAMDatabaseAuthenticationEnabled) {
      throw new Error(
        `Cluster ${g.cluster_identifier} exists but IAM DB auth is not ` +
          `enabled. This bootstrap requires IAM-only auth.`,
      );
    }
    logger.info("Aurora DB cluster adopted (already exists)", {
      identifier: g.cluster_identifier,
      status: found.Status,
    });
  }

  // Poll until available.
  const startedAt = Date.now();
  const timeoutMs = 15 * 60 * 1000; // 15 minutes — cluster creation is slow
  let pollNum = 0;
  while (true) {
    pollNum += 1;
    const desc = await rds.send(
      new DescribeDBClustersCommand({
        DBClusterIdentifier: g.cluster_identifier,
      }),
    );
    const cluster = desc.DBClusters?.[0];
    if (!cluster) {
      throw new Error(
        `Cluster ${g.cluster_identifier} disappeared during polling`,
      );
    }
    if (cluster.Status === "available") {
      const endpoint = cluster.Endpoint;
      const arn = cluster.DBClusterArn;
      const resourceId = cluster.DbClusterResourceId;
      const port = cluster.Port ?? 5432;
      if (!endpoint || !arn || !resourceId) {
        throw new Error(
          `Cluster ${g.cluster_identifier} reports available but is missing ` +
            `Endpoint/ARN/DbClusterResourceId — cannot proceed.`,
        );
      }
      logger.info("Aurora DB cluster available", {
        identifier: g.cluster_identifier,
        endpoint,
        resourceId,
        elapsedMs: Date.now() - startedAt,
      });
      return {
        cluster_arn: arn,
        cluster_endpoint: endpoint,
        cluster_port: port,
        cluster_resource_id: resourceId,
        master_user_secret_arn: cluster.MasterUserSecret?.SecretArn,
      };
    }
    if (cluster.Status === "failed") {
      throw new Error(
        `Cluster ${g.cluster_identifier} entered 'failed' status during ` +
          `provisioning`,
      );
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `Cluster ${g.cluster_identifier} did not become available within ` +
          `${timeoutMs / 1000}s (last status: ${cluster.Status})`,
      );
    }
    // Backoff: 2s, 4s, 8s, capped at 30s.
    const delayMs = Math.min(2000 * Math.pow(2, pollNum - 1), 30_000);
    logger.info("Cluster still provisioning, waiting", {
      status: cluster.Status,
      pollNum,
      delayMs,
    });
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/**
 * Structural output returned by `ensureInstance` — the writer instance
 * identifier (matches globalArgs.instance_identifier) and its ARN.
 */
export interface InstanceOutputs {
  instance_arn: string;
  instance_identifier: string;
}

/**
 * Create the writer DB instance if absent; adopt if present.
 * Waits until the instance reaches `available`.
 */
export async function ensureInstance(
  rds: RDSClient,
  g: GlobalArgs,
  logger: Logger,
): Promise<InstanceOutputs> {
  let found;
  try {
    const desc = await rds.send(
      new DescribeDBInstancesCommand({
        DBInstanceIdentifier: g.instance_identifier,
      }),
    );
    found = desc.DBInstances?.[0];
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== "DBInstanceNotFoundFault") {
      throw err;
    }
  }

  if (!found) {
    logger.info("Creating writer DB instance", {
      identifier: g.instance_identifier,
      cluster: g.cluster_identifier,
      class: "db.serverless",
    });
    await rds.send(
      new CreateDBInstanceCommand({
        DBInstanceIdentifier: g.instance_identifier,
        DBClusterIdentifier: g.cluster_identifier,
        Engine: "aurora-postgresql",
        DBInstanceClass: "db.serverless",
        PubliclyAccessible: g.publicly_accessible,
        Tags: tagList(g.tags),
      }),
    );
  } else {
    if (found.DBClusterIdentifier !== g.cluster_identifier) {
      throw new Error(
        `Instance ${g.instance_identifier} exists but is in cluster ` +
          `${found.DBClusterIdentifier}, expected ${g.cluster_identifier}.`,
      );
    }
    if (found.Engine !== "aurora-postgresql") {
      throw new Error(
        `Instance ${g.instance_identifier} exists but Engine is ${found.Engine}.`,
      );
    }
    logger.info("Writer DB instance adopted (already exists)", {
      identifier: g.instance_identifier,
      status: found.DBInstanceStatus,
    });
  }

  // Poll until available.
  const startedAt = Date.now();
  const timeoutMs = 20 * 60 * 1000; // 20 min — instance creation can be slow
  let pollNum = 0;
  while (true) {
    pollNum += 1;
    const desc = await rds.send(
      new DescribeDBInstancesCommand({
        DBInstanceIdentifier: g.instance_identifier,
      }),
    );
    const inst = desc.DBInstances?.[0];
    if (!inst) {
      throw new Error(
        `Instance ${g.instance_identifier} disappeared during polling`,
      );
    }
    if (inst.DBInstanceStatus === "available") {
      const arn = inst.DBInstanceArn;
      if (!arn) {
        throw new Error(
          `Instance ${g.instance_identifier} is available but has no ARN`,
        );
      }
      logger.info("Writer DB instance available", {
        identifier: g.instance_identifier,
        elapsedMs: Date.now() - startedAt,
      });
      return { instance_arn: arn, instance_identifier: g.instance_identifier };
    }
    if (
      inst.DBInstanceStatus === "failed" ||
      inst.DBInstanceStatus === "incompatible-parameters" ||
      inst.DBInstanceStatus === "incompatible-restore"
    ) {
      throw new Error(
        `Instance ${g.instance_identifier} entered terminal failure status ` +
          `${inst.DBInstanceStatus}`,
      );
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `Instance ${g.instance_identifier} did not become available within ` +
          `${timeoutMs / 1000}s (last status: ${inst.DBInstanceStatus})`,
      );
    }
    const delayMs = Math.min(
      3000 * Math.pow(2, Math.min(pollNum - 1, 5)),
      30_000,
    );
    logger.info("Instance still provisioning, waiting", {
      status: inst.DBInstanceStatus,
      pollNum,
      delayMs,
    });
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/**
 * Build the IAM policy document JSON for `rds-db:connect` scoped to a
 * specific dbuser ARN. Kept as a helper so tests can assert exact shape.
 */
export function buildConnectPolicyDocument(
  region: string,
  accountId: string,
  clusterResourceId: string,
  masterUsername: string,
): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["rds-db:connect"],
        Resource:
          `arn:aws:rds-db:${region}:${accountId}:dbuser:${clusterResourceId}/${masterUsername}`,
      },
    ],
  });
}

/**
 * Create the rds-db:connect managed policy if absent; adopt if present.
 * On drift (existing policy document doesn't reference the expected dbuser
 * ARN), throws — this bootstrap does not silently reconcile IAM.
 */
export async function ensureManagedPolicy(
  iam: IAMClient,
  accountId: string,
  g: GlobalArgs,
  clusterResourceId: string,
  logger: Logger,
): Promise<string> {
  const expectedArn =
    `arn:aws:iam::${accountId}:policy/${g.managed_policy_name}`;
  const expectedDbuserArn =
    `arn:aws:rds-db:${g.region}:${accountId}:dbuser:${clusterResourceId}/${g.master_username}`;

  let existing;
  try {
    const got = await iam.send(
      new GetPolicyCommand({ PolicyArn: expectedArn }),
    );
    existing = got.Policy;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== "NoSuchEntityException") {
      throw err;
    }
  }

  if (existing) {
    // Verify the current default policy version's document contains the
    // expected dbuser ARN. If not, drift error.
    const versionId = existing.DefaultVersionId;
    if (!versionId) {
      throw new Error(
        `Managed policy ${expectedArn} exists but has no DefaultVersionId`,
      );
    }
    const version = await iam.send(
      new GetPolicyVersionCommand({
        PolicyArn: expectedArn,
        VersionId: versionId,
      }),
    );
    const docRaw = version.PolicyVersion?.Document;
    if (!docRaw) {
      throw new Error(
        `Managed policy ${expectedArn} version ${versionId} has no document`,
      );
    }
    const docStr = decodeURIComponent(docRaw);
    if (!docStr.includes(expectedDbuserArn)) {
      throw new Error(
        `Managed policy ${expectedArn} exists but does not include the ` +
          `expected dbuser ARN ${expectedDbuserArn}. Refusing to reconcile ` +
          `an IAM drift automatically — manage this policy via the ` +
          `first-party @swamp/aws/iam/managed-policy type after bootstrap.`,
      );
    }
    logger.info("Managed policy adopted (already exists)", {
      arn: expectedArn,
    });
    return expectedArn;
  }

  const document = buildConnectPolicyDocument(
    g.region,
    accountId,
    clusterResourceId,
    g.master_username,
  );

  logger.info("Creating managed policy", {
    name: g.managed_policy_name,
    dbuser: expectedDbuserArn,
  });
  const created = await iam.send(
    new CreatePolicyCommand({
      PolicyName: g.managed_policy_name,
      Description:
        `Grants rds-db:connect on the @twonines/fact-store Aurora cluster ` +
        `(${g.cluster_identifier}) for user ${g.master_username}`,
      PolicyDocument: document,
      Tags: tagList(g.tags),
    }),
  );
  const arn = created.Policy?.Arn;
  if (!arn) {
    throw new Error(
      `CreatePolicy returned no ARN for ${g.managed_policy_name}`,
    );
  }
  return arn;
}

/**
 * Build the IAM assume-role trust policy for the workload role.
 */
export function buildTrustPolicyDocument(trustPrincipal: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: trustPrincipal },
        Action: "sts:AssumeRole",
      },
    ],
  });
}

/**
 * Create the workload IAM role if absent; adopt if present. Verifies the
 * trust policy contains the expected principal on adoption.
 */
export async function ensureWorkloadRole(
  iam: IAMClient,
  g: GlobalArgs,
  logger: Logger,
): Promise<string> {
  let existing;
  try {
    const got = await iam.send(
      new GetRoleCommand({ RoleName: g.workload_role_name }),
    );
    existing = got.Role;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== "NoSuchEntityException") {
      throw err;
    }
  }

  if (existing) {
    // AWS returns the trust policy URL-encoded in AssumeRolePolicyDocument
    const trustRaw = existing.AssumeRolePolicyDocument ?? "";
    const trustStr = decodeURIComponent(trustRaw);
    if (!trustStr.includes(g.workload_role_trust_principal)) {
      throw new Error(
        `Role ${g.workload_role_name} exists but its trust policy does not ` +
          `include the expected principal ${g.workload_role_trust_principal}. ` +
          `Refusing to reconcile.`,
      );
    }
    const arn = existing.Arn;
    if (!arn) {
      throw new Error(`Role ${g.workload_role_name} exists but has no ARN`);
    }
    logger.info("Workload role adopted (already exists)", {
      arn,
      trustPrincipal: g.workload_role_trust_principal,
    });
    return arn;
  }

  const trustDoc = buildTrustPolicyDocument(g.workload_role_trust_principal);

  logger.info("Creating workload role", {
    name: g.workload_role_name,
    trustPrincipal: g.workload_role_trust_principal,
  });
  const created = await iam.send(
    new CreateRoleCommand({
      RoleName: g.workload_role_name,
      Description:
        `Workload role for @twonines/fact-store operations against Aurora ` +
        `cluster ${g.cluster_identifier}`,
      AssumeRolePolicyDocument: trustDoc,
      MaxSessionDuration: 3600,
      Tags: tagList(g.tags),
    }),
  );
  const arn = created.Role?.Arn;
  if (!arn) {
    throw new Error(`CreateRole returned no ARN for ${g.workload_role_name}`);
  }
  return arn;
}

/**
 * Attach the managed policy to the workload role. Idempotent — no-op if
 * already attached.
 */
export async function attachPolicyToRole(
  iam: IAMClient,
  roleName: string,
  policyArn: string,
  logger: Logger,
): Promise<void> {
  const attached = await iam.send(
    new ListAttachedRolePoliciesCommand({ RoleName: roleName }),
  );
  const already = (attached.AttachedPolicies ?? []).some(
    (p) => p.PolicyArn === policyArn,
  );
  if (already) {
    logger.info("Policy already attached to role", { roleName, policyArn });
    return;
  }
  logger.info("Attaching policy to role", { roleName, policyArn });
  await iam.send(
    new AttachRolePolicyCommand({
      RoleName: roleName,
      PolicyArn: policyArn,
    }),
  );
}

/**
 * Grant the `rds_iam` role to the master user so IAM DB authentication
 * actually works.
 *
 * Background: `CreateDBCluster` with `EnableIAMDatabaseAuthentication=true`
 * enables the IAM auth backend on the cluster, but it does NOT grant the
 * `rds_iam` role to the master user — the master user remains a normal
 * password-auth user unless something explicitly grants `rds_iam`. AWS's
 * Cloud Control API for `AWS::RDS::DBCluster` handles this server-side when
 * you set `MasterUserAuthenticationType: iam-db-auth`; the direct RDS SDK
 * (which this bootstrap uses) does not, so we grant it here as part of
 * provisioning.
 *
 * Idempotent detection strategy: try to connect via IAM auth first (using
 * a freshly-generated auth token for the master user). If that succeeds,
 * `rds_iam` is already granted and we're done — skip. If IAM auth fails,
 * fall back to the master password (fetched from Secrets Manager) and
 * run the GRANT.
 *
 * The IAM-first probe avoids a real problem observed in practice: once
 * `rds_iam` is granted to a user in Aurora Postgres, that user's connections
 * are routed through PAM (IAM) authentication, and password auth stops
 * working. Attempting password auth on such a user produces a "PAM
 * authentication failed" error that is surfaced through postgres.js's
 * event/promise machinery in a way that can slip past a query-level
 * try/catch. Trying IAM auth first bypasses that hazard when the grant
 * is already in place.
 *
 * Requires: cluster in `available` status, writer instance in `available`
 * status (endpoint must be reachable), `MasterUserSecret` populated for
 * the password-fallback path. Adopted clusters without a MasterUserSecret
 * fall back to warning-and-skip.
 */
export async function grantRdsIam(
  sm: SecretsManagerClient,
  cluster: ClusterOutputs,
  region: string,
  masterUsername: string,
  logger: Logger,
): Promise<void> {
  // Fetch the RDS global CA bundle once for both auth attempts.
  const caResp = await fetch(
    "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
  );
  if (!caResp.ok) {
    throw new Error(
      `Failed to fetch RDS global CA bundle: HTTP ${caResp.status}`,
    );
  }
  const ca = await caResp.text();

  // --- Probe 1: try IAM auth. If it succeeds, rds_iam is already granted. ---
  const signer = new Signer({
    hostname: cluster.cluster_endpoint,
    port: cluster.cluster_port,
    username: masterUsername,
    region,
    // Signer defaults to the ambient AWS credentials the RDS client uses.
  });
  const iamToken = await signer.getAuthToken();

  logger.info("Probing IAM auth to detect existing rds_iam grant", {
    username: masterUsername,
    endpoint: cluster.cluster_endpoint,
  });
  const iamSql = postgres({
    host: cluster.cluster_endpoint,
    port: cluster.cluster_port,
    database: "postgres",
    username: masterUsername,
    password: iamToken,
    ssl: { ca },
  });
  let iamOk = false;
  try {
    await iamSql`SELECT 1`;
    iamOk = true;
  } catch (err) {
    const msg = (err as Error).message ?? "";
    logger.info(
      "IAM auth probe failed — assuming rds_iam not yet granted; will fall back to password auth",
      { probeError: msg },
    );
  } finally {
    await iamSql.end({ timeout: 5 });
  }

  if (iamOk) {
    logger.info(
      "IAM auth succeeded — rds_iam is already granted, no work to do",
      { username: masterUsername },
    );
    return;
  }

  // --- Fallback: password auth via Secrets Manager, then GRANT rds_iam. ---
  if (!cluster.master_user_secret_arn) {
    logger.warning(
      "Cluster has no MasterUserSecret and IAM auth probe failed. Skipping " +
        "rds_iam grant — the operator must grant it manually if IAM DB " +
        "auth is required.",
      { cluster: cluster.cluster_endpoint },
    );
    return;
  }

  const secret = await sm.send(
    new GetSecretValueCommand({ SecretId: cluster.master_user_secret_arn }),
  );
  if (!secret.SecretString) {
    throw new Error(
      `Secrets Manager returned empty SecretString for ` +
        `${cluster.master_user_secret_arn}`,
    );
  }
  const parsed = JSON.parse(secret.SecretString) as { password?: string };
  if (!parsed.password) {
    throw new Error(
      `Master user secret ${cluster.master_user_secret_arn} does not ` +
        `contain a password field`,
    );
  }

  logger.info("Connecting via master password to grant rds_iam", {
    username: masterUsername,
    endpoint: cluster.cluster_endpoint,
  });

  const pwSql = postgres({
    host: cluster.cluster_endpoint,
    port: cluster.cluster_port,
    database: "postgres",
    username: masterUsername,
    password: parsed.password,
    ssl: { ca },
  });
  try {
    await pwSql.unsafe(`GRANT rds_iam TO "${masterUsername}"`);
    logger.info("Granted rds_iam to master user", {
      username: masterUsername,
    });
  } finally {
    await pwSql.end({ timeout: 5 });
  }
}
