# @twonines/fact-store-aurora-bootstrap

Swamp-native bootstrap for [@twonines/fact-store][fact-store] backed by AWS
Aurora Postgres Serverless v2 via [@webframp/postgres-datastore][pgds].

One `swamp workflow run` provisions the cluster and switches the current repo
to use it. All resources are idempotent — re-running against an already-
provisioned environment self-heals partial failures rather than duplicating.

[fact-store]: https://codeberg.org/twonines/swamp-extensions/src/branch/main/extensions/models/fact-store
[pgds]: https://swamp-club.com/manual/extensions/webframp/postgres-datastore

## What it provisions

- RDS DB subnet group across the caller-supplied subnets.
- EC2 security group allowing ingress on 5432 from a caller-supplied CIDR.
- Aurora Postgres Serverless v2 cluster (default: `aurora-postgresql 16.6`,
  0.5–2 ACU, IAM-auth-only).
- One writer DB instance (`db.serverless`).
- IAM managed policy scoped to `rds-db:connect` on the cluster's
  `<DbClusterResourceId>/<master_username>` dbuser ARN.
- IAM workload role that trusts a caller-supplied principal ARN (typically an
  AWS SSO permission set role ARN) and has the managed policy attached.

## What it configures

After provisioning, the workflow runs `swamp datastore setup extension
@webframp/postgres-datastore` against the current repo, using a freshly
generated RDS IAM auth token as the connection string password. The token
is short-lived (15 minutes) — for long-running workloads, plan to re-run
`swamp datastore setup` periodically until token refresh is built into the
datastore or handled by an auth-token daemon.

## Prerequisites

- AWS credentials in the default credential chain with permissions to:
  - `rds:CreateDBSubnetGroup`, `rds:CreateDBCluster`, `rds:CreateDBInstance`,
    `rds:DescribeDB*`
  - `ec2:CreateSecurityGroup`, `ec2:AuthorizeSecurityGroupIngress`,
    `ec2:DescribeSecurityGroups`, `ec2:DescribeVpcs`, `ec2:DescribeSubnets`
  - `iam:CreatePolicy`, `iam:CreateRole`, `iam:AttachRolePolicy`,
    `iam:GetPolicy`, `iam:GetRole`, `iam:ListAttachedRolePolicies`
- An existing VPC and at least two subnets in different AZs.
- The RDS global CA bundle (`global-bundle.pem`) downloaded to a local path
  — the workflow needs it for `sslmode=verify-ca`:
  ```bash
  curl -sSfL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    -o /tmp/rds-global-bundle.pem
  ```

## Running

```bash
swamp extension pull @twonines/fact-store-aurora-bootstrap

# Create the provisioner instance
swamp model create @twonines/fact-store-aurora-bootstrap/provisioner \
  fact-store-aurora-provisioner

# Wire globalArguments to workflow inputs
swamp model edit fact-store-aurora-provisioner
# Set each field to ${{ inputs.<name> }}, e.g.:
#   account_id: ${{ inputs.account_id }}
#   region:     ${{ inputs.region }}
#   ...

# Create the shell instance for the configure step
swamp model create command/shell fact-store-aurora-datastore-setup

# Run the workflow
swamp workflow run '@twonines/bootstrap-fact-store-aurora' \
  --input account_id=123456789012 \
  --input region=us-east-1 \
  --input vpc_id=vpc-0abc123def456ghij \
  --input 'subnet_ids=["subnet-aaa","subnet-bbb"]' \
  --input ingress_cidr=203.0.113.42/32 \
  --input workload_role_trust_principal='arn:aws:iam::123456789012:role/AWSReservedSSO_YourPermissionSet_abc123' \
  --input 'tags={"Owner":"team-x","Environment":"prd","CostCenter":"cc-42"}'
```

## Tagging

Every newly-created AWS resource (subnet group, security group, cluster, DB
instance, managed policy, workload role) receives the tags passed in the
`tags` input. Provide them as a JSON object on the command line as shown
above. Empty map (`{}`, the default) means no tags applied.

Adopted (already-existing) resources are **not** modified — the bootstrap
does not sync tag drift. To manage tags on an existing resource after
bootstrap, use the first-party `@swamp/aws/*` types or update tags out of
band.

## What ships in the tarball

- `mod.ts` — the provisioner model type
- `bootstrap.yaml` — the workflow definition
- This README

## Version compatibility

Depends on `@twonines/fact-store` and `@webframp/postgres-datastore`. The
provisioner uses AWS SDK v3 directly; it does not compose the
`@swamp/aws/*` types, so cluster/instance/subnet-group/security-group model
data written by the provisioner is not interchangeable with data written by
those first-party types (different schemas). This is intentional: bundling
multi-resource creation as one atomic operation is cleaner than orchestrating
five separate model methods with CEL wiring in a bootstrap flow.

## Idempotency

Every `ensure*` helper is safe to call against pre-existing resources:

- If a resource matching the identifier exists and matches the expected shape,
  it is adopted and no mutation is issued.
- If it exists but drifts from the expected shape, that is a hard error (the
  bootstrap will not silently reconcile; that's the job of the underlying
  first-party model types once you switch to managing them directly).
- If it does not exist, it is created.

## Non-goals

- **Ongoing lifecycle management.** This is a bootstrap — after the initial
  provision, manage the cluster via the first-party `@swamp/aws/rds/*` and
  `@swamp/aws/iam/*` types (or Terraform/CloudFormation) for updates, tag
  changes, etc.
- **Multi-writer / read-replica topologies.** Only a single writer instance
  is created.
- **Automated IAM token refresh.** Consumers must re-run
  `swamp datastore setup extension @webframp/postgres-datastore` or use a
  token daemon for long-running workloads.
