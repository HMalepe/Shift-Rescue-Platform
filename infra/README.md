# infra

Terraform for Locum Planner: VPC, RDS Postgres 16, ElastiCache Redis 7, the
documents bucket and its KMS key, ECS Fargate for the API and worker, and the
§0.1 infrastructure alarms.

## What has actually been verified, and what has not

Being precise about this matters more than usual, because Terraform that has
never been applied looks identical to Terraform that has.

**Verified here:**

- `terraform validate` passes against the real `hashicorp/aws` 5.100 provider
  schema. That checks every resource type, every attribute name and every type
  — a misspelled argument or a string where a list belongs fails.
- `terraform fmt -check -recursive` is clean.
- The Budgets tag filter was evaluated rather than reasoned about, because
  `validate` cannot catch a string that is well-formed and wrong. See the
  comment on `aws_budgets_budget.monthly`.

**Not verified:**

- **No `terraform plan` has ever run.** A plan needs credentials, and §15 lists
  AWS as externally blocked. Everything that only a plan or an apply would
  catch is unproven: quota limits, whether `af-south-1` offers a given instance
  class, IAM policies that are syntactically fine and functionally wrong, and
  every ordering problem between resources.
- **Nothing has been applied.** No resource described here exists.

Treat this as a reviewed design that compiles, not as infrastructure.

## Running it here

The provider registry is unreachable from this environment, so `terraform init`
needs a filesystem mirror. Fetch the provider from `releases.hashicorp.com`
(which is reachable) and point Terraform at it:

```sh
mkdir -p ~/.terraform-mirror/registry.terraform.io/hashicorp/{aws,random}
curl -O --output-dir ~/.terraform-mirror/registry.terraform.io/hashicorp/aws \
  https://releases.hashicorp.com/terraform-provider-aws/5.100.0/terraform-provider-aws_5.100.0_linux_amd64.zip
curl -O --output-dir ~/.terraform-mirror/registry.terraform.io/hashicorp/random \
  https://releases.hashicorp.com/terraform-provider-random/3.6.3/terraform-provider-random_3.6.3_linux_amd64.zip

cat > ~/.terraformrc <<'EOF'
provider_installation {
  filesystem_mirror {
    path    = "/root/.terraform-mirror"
    include = ["registry.terraform.io/hashicorp/*"]
  }
  direct { exclude = ["registry.terraform.io/hashicorp/*"] }
}
EOF

make infra-validate
```

With normal registry access, `terraform init` alone is enough.

## Decisions worth knowing before changing anything

**`af-south-1` is validated, not defaulted.** Personal information under POPIA
can leave South Africa only under §72 conditions that mean legal work per
destination — one of the five §13 Day-0 legal items. Changing the region is a
decision with a legal dependency, so it fails rather than warns.

**One NAT gateway.** A NAT per AZ removes a real failure mode (an AZ outage
stops outbound calls to Twilio and Payfast) and roughly doubles a large line
item. Single NAT is the launch choice; the mitigation is that both callers are
retrying queues, so a confirmation is delayed rather than lost.

**Exactly one worker, not autoscaled.** `FOR UPDATE SKIP LOCKED` makes more
workers safe for correctness, but the batch size — not the task count — is what
paces the 07:00 backlog against Twilio's rate limits, and §11.6's spend cap is
per day rather than per worker. Scale `DRAIN_BATCH_SIZE`, not `desired_count`.

**Pinned versions.** Postgres 16.13 and Redis 7.1 match `docker-compose.yml`
and `scripts/local-pg.sh`. The specific thing this protects is PostGIS:
`ST_DWithin` on `geography` plans differently across majors, and the §0.3
proximity budget was measured against 3.4.

**The bucket and the S3 adapter agree on purpose.**
`packages/integrations/src/s3.ts` names SSE-KMS on every object *and* this
bucket defaults to it. That redundancy is deliberate — bucket default
encryption lives here, where an edit removes it with no code change, and
objects already written keep whatever they had.

**Retention is duplicated and unenforced.** `document_retention_days` must
match `RETENTION_POLICY` in `packages/core/src/privacy/retention.ts`. A test
asserts that policy against every table in the schema; nothing asserts it
against this bucket. If you change one, change the other.

## Before this can be applied

All §13 Day-0, none of them a code problem:

1. An AWS account with a bootstrapped state bucket and lock table.
2. A registered domain and an ACM certificate in `af-south-1` — `certificate_arn`.
3. Twilio account and approved WhatsApp sender — populates `twilio-auth-token`.
4. Payfast merchant account — populates `payfast-passphrase`, `payfast-merchant-key`.
5. An alert sink URL — populates `alert-webhook-url`, without which
   `assertProductionReady` refuses to boot production.

`terraform output secrets_to_populate` lists the ones created empty.
