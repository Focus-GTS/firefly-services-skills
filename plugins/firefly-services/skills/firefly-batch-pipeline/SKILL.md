---
name: firefly-batch-pipeline
description: The end-to-end production reference architecture for high-volume generative campaign workloads on Adobe Firefly Services — SQS-fronted intake, Lambda worker pool with per-credential token-bucket pacing, Step Functions orchestration for multi-stage PSD composition, DynamoDB job state, S3 result persistence, DLQ replay, and webhook-driven customer notification. Use whenever the user mentions "batch pipeline", "campaign at scale", "thousands of images per day", "generative pipeline", "campaign assembler", "asset factory", "production-grade pipeline", or designs a system that combines Firefly generation with Photoshop composition at volume. Stitches `firefly-services-rate-limits` and `photoshop-api-composition` into a single deployable blueprint.
license: Apache-2.0
compatibility: AWS reference architecture (SQS + Lambda + Step Functions + DynamoDB + S3 + EventBridge). Equivalent shapes on GCP (Pub/Sub + Cloud Functions + Cloud Workflows + Firestore + GCS) and Azure (Service Bus + Functions + Durable Functions + CosmosDB + Blob Storage). Requires `firefly_enterprise` scope plus Photoshop API entitlement.
allowed-tools: Bash(curl:*) Bash(jq:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: production-architecture
---

# Firefly Batch Pipeline — End-to-End Reference

The complete deployable blueprint for production-scale generative campaign workloads. This skill stitches together the rate-limit layer (`firefly-services-rate-limits`) and the multi-stage composition layer (`photoshop-api-composition`) into a single architecture that an FDE engagement can stand up in two-to-three weeks and run for years.

This is the shape that moves a generative pipeline from "demo that works once" to "platform that produces tens of thousands of assets per campaign run, on schedule, with audit trail." Every component below exists for a specific failure mode that has bitten a real engagement. Skip any one of them and you will rediscover the same failure mode.

## When to Use This Skill

Use this skill when:
- The customer is planning a generative campaign that will produce hundreds of unique assets per day or more
- The pipeline combines Firefly generation with Photoshop composition (PSD templates, smart objects, multi-aspect rendering)
- The user mentions "asset factory", "campaign assembler", "batch pipeline", "platform", or "production-grade"
- A pilot pipeline has shipped and the customer needs the architecture that scales it 10-100x
- The architecture review is happening up front, before the engineering team writes a Lambda

Do **NOT** use this skill when:
- The workload is interactive one-shot generation — direct SDK calls are fine
- The workload is pure Firefly generation with no composition — `firefly-services-rate-limits` alone is enough
- The workload is pure PSD composition with no generation — `photoshop-api-composition` alone is enough
- The customer has not yet provisioned a rate-limit increase — start there (see `firefly-services-rate-limits` §1)

## The Reference Architecture

```
                          ┌─────────────────────────────┐
                          │  Customer-facing intake     │
                          │  (API Gateway + auth)       │
                          └──────────────┬──────────────┘
                                         │
                                  validate + enqueue
                                         │
                                         ▼
                          ┌─────────────────────────────┐
                          │  SQS Standard — Job intake  │
                          │  visibilityTimeout = 6×p95  │
                          └──────────────┬──────────────┘
                                         │
                                         ▼
                          ┌─────────────────────────────┐
                          │  Lambda: dispatcher         │
                          │  - dedupe (idempotency key) │
                          │  - load campaign config     │
                          │  - start Step Functions     │
                          └──────────────┬──────────────┘
                                         │
                                         ▼
                ┌────────────────────────────────────────────┐
                │  Step Functions — Asset assembly           │
                │  (the 15-20 function state machine; see    │
                │   photoshop-api-composition)               │
                │                                            │
                │  Each Firefly / Photoshop API task:        │
                │   1. Acquire token from per-credential     │
                │      TokenBucket (DynamoDB-backed)         │
                │   2. Submit async job                      │
                │   3. waitForTaskToken                      │
                │   4. Webhook → SendTaskSuccess             │
                └──────────────┬─────────────────────────────┘
                               │
                       ┌───────┴────────┐
                       ▼                ▼
              ┌─────────────┐   ┌─────────────┐
              │  S3 results │   │  DynamoDB   │
              │  + tagging  │   │  job ledger │
              └──────┬──────┘   └──────┬──────┘
                     │                 │
                     └────────┬────────┘
                              ▼
              ┌──────────────────────────────┐
              │  EventBridge → notification  │
              │  (webhook, SNS, or polling)  │
              └──────────────────────────────┘

         Failure paths:
           - SQS → DLQ (maxReceiveCount = 3) → classified replay
           - Step Functions Catch → "review" S3 prefix + alarm
           - 429 storm → CloudWatch alarm → auto-throttle TokenBucket
```

Every arrow above corresponds to a specific failure mode covered later. Read this diagram, then read the failure-mode table at the end.

## Step 1 — Job Intake & Idempotency

The intake API does not call Firefly. It validates, persists the job request, and enqueues. This separation is what lets the rest of the pipeline absorb a Firefly outage without taking down the customer-facing endpoint.

| Concern | Pattern |
|---|---|
| Authentication | API Gateway + Cognito / OIDC; never expose Firefly credentials to the caller |
| Validation | JSON schema validation against the campaign config; reject malformed requests at the edge |
| Idempotency | Caller-supplied `idempotencyKey` (UUID); dispatcher dedupes via DynamoDB conditional write |
| Backpressure | SQS queue depth alarm at N × provisioned RPM (typically 10×); shed load at the API tier if exceeded |
| Cost containment | Per-customer monthly quota tracked in DynamoDB; reject when exceeded |

The idempotency key is non-negotiable. Without it, retries from upstream systems will produce duplicate generations and double-bill the customer.

## Step 2 — The Per-Credential Token Bucket (Shared State)

A single Lambda instance running a local TokenBucket is not enough. Lambda autoscales — a burst of concurrent invocations will each think they have a full bucket and collectively blow through the rate limit.

For a queue-fronted architecture, the TokenBucket must be **shared state**. Two viable implementations:

| Approach | Storage | When to use |
|---|---|---|
| DynamoDB atomic counter | `UpdateItem` with `ConditionExpression` | Up to ~100 RPM provisioned; simplest |
| Redis (ElastiCache) `INCR` with TTL | In-memory | High RPM (>500); lowest latency |

DynamoDB pattern (sketch):

```js
async function acquireToken(credentialId, ratePerMin) {
  const now = Date.now();
  const windowStart = Math.floor(now / 60_000) * 60_000;
  const result = await ddb.update({
    TableName: 'firefly-rate-limit',
    Key: { credentialId, windowStart },
    UpdateExpression: 'ADD #c :one SET #ttl = :exp',
    ConditionExpression: '#c < :limit OR attribute_not_exists(#c)',
    ExpressionAttributeNames: { '#c': 'count', '#ttl': 'ttl' },
    ExpressionAttributeValues: {
      ':one': 1,
      ':limit': Math.floor(ratePerMin * 0.8),  // 80% headroom
      ':exp': Math.floor((windowStart + 120_000) / 1000),
    },
    ReturnValues: 'UPDATED_NEW',
  }).promise().catch(err => {
    if (err.code === 'ConditionalCheckFailedException') return null;
    throw err;
  });
  return result !== null;
}
```

Worker loop: `while (!await acquireToken(...)) await sleep(jitter())`. The 80% headroom and jitter come straight from `firefly-services-rate-limits` — this just lifts that pattern into shared state.

## Step 3 — Step Functions Orchestration (Per Job)

For any job that requires more than a single Firefly call, the worker dispatches into a Step Functions execution. The state machine encodes the entire asset-assembly graph — typically 15-20 functions, following the pattern in `photoshop-api-composition`.

Key adaptations for batch operation:

| State machine concern | Batch-pipeline answer |
|---|---|
| One execution per asset | Yes — easier to retry, isolate, observe |
| Map state for aspect-ratio fan-out | `MaxConcurrency` matched to `provisionedRPM / 60 / fan-out-factor` |
| Long-running async submissions | `waitForTaskToken` + webhook callback (no polling Lambdas at this scale) |
| Catch terminal failures | Route to "review" S3 prefix with full execution snapshot |
| Cost | Standard tier; Express only if total per-execution duration < 5 minutes |

For the full state-machine pattern, see `photoshop-api-composition` §3.

## Step 4 — Job State Ledger (DynamoDB)

Every job has a row in a DynamoDB table. The schema:

| Attribute | Purpose |
|---|---|
| `jobId` (PK) | UUID, idempotent |
| `customerId` (SK) | Tenant isolation, partition affinity |
| `campaignId` | Group jobs into a campaign |
| `status` | `queued` / `running` / `succeeded` / `failed` / `dlq` / `review` |
| `executionArn` | Step Functions execution for forensics |
| `inputManifest` | The full input (prompt, references, template id, etc.) |
| `outputs` | Array of S3 URIs once complete |
| `costEstimate` | Pre-run estimate (see `firefly-cost-optimization`) |
| `costActual` | Post-run reconciliation |
| `createdAt`, `updatedAt` | ISO-8601 |
| `ttl` | 90 days for completed jobs; longer for audit |

A `customerId-campaignId` GSI lets the customer-facing UI list "all jobs in campaign X" without scanning.

## Step 5 — DLQ Classification & Replay

The DLQ exists. The question is what to do when messages land there. From `firefly-services-rate-limits` §5, the classification rules:

| Failure | Action |
|---|---|
| 5xx (transient) | Replay after Adobe status page clears |
| 422 (content rejection) | Do not replay — surface to customer with prompt-revision guidance |
| 403 (entitlement) | Do not replay — alert ops; credential rotation required |
| 404 (custom model retired) | Do not replay — surface to customer; suggest retraining |
| 400312 (storage ref expired) | Replay only after regenerating fresh references |
| Step Functions task timeout | Replay; the webhook was likely lost |

The replay tool reads the DLQ message, looks up the failure reason in the job ledger, and replays only the recoverable classes. Bulk-replay without classification is the single most expensive operations mistake in this architecture — it burns quota on requests that will never succeed and leaves the unrecoverable failures untouched.

## Step 6 — Result Persistence & Tagging

Outputs land in S3. The key layout matters:

```
s3://<bucket>/<customerId>/<campaignId>/<jobId>/<aspect>/<filename>.jpg
```

Tagging (S3 object tags) carries:

| Tag | Use |
|---|---|
| `customer` | Per-customer cost allocation |
| `campaign` | Per-campaign lifecycle policy |
| `generated-by` | `firefly-v3-base`, `firefly-v3-custom`, etc. |
| `model-id` | Custom model UUID, if applicable |
| `human-reviewed` | `pending`, `approved`, `rejected` (see `firefly-brand-guardrails`) |

Lifecycle policy: move to Glacier Instant Retrieval after 90 days, expire after 1 year unless `legal-hold=true`.

## Step 7 — Notification (Webhooks > Polling)

When the Step Functions execution completes, EventBridge fires a rule that calls the customer's webhook. If the customer cannot receive webhooks, they poll the job ledger via the intake API (rate-limited, cached responses).

Webhook payload shape:

```json
{
  "jobId": "...",
  "campaignId": "...",
  "status": "succeeded",
  "outputs": [
    {"aspect": "1920x1080", "url": "https://..."},
    {"aspect": "1080x1920", "url": "https://..."}
  ],
  "completedAt": "2026-05-19T14:32:11Z"
}
```

Signed with HMAC-SHA256 using a shared secret. Customers verify the signature before processing.

## Step 8 — Observability — What to Build Day One

For a batch pipeline, observability is not optional. Minimum dashboards:

| Dashboard | Metric |
|---|---|
| Pipeline throughput | Jobs / minute by status, broken out by customer |
| End-to-end latency | p50 / p95 / p99 from intake to webhook |
| Rate-limit headroom | `X-RateLimit-Remaining` distribution per credential |
| DLQ depth | Current depth + arrival rate, alert at >0 sustained |
| Cost burn | Estimated $ per hour, per customer, per campaign |
| Custom model success rate | Generation success rate per `customModelId` |
| Step Functions per-state failure rate | Which state breaks most often |

Alarms that must page someone:

- DLQ depth > 0 for 15 minutes
- 429 rate > 1% for 5 minutes
- End-to-end p95 > 2× baseline for 15 minutes
- Step Functions execution failure rate > 5% for 5 minutes
- Cost burn > 150% of forecast for 1 hour

## Validate

The batch pipeline is production-ready when:

1. The intake API never calls Firefly directly — always queue first
2. Idempotency keys are required and enforced via conditional DynamoDB writes
3. The TokenBucket is shared state (DynamoDB or Redis), not per-Lambda
4. Every Firefly / Photoshop call goes through Step Functions with explicit Retry and Catch
5. The DLQ has a documented, classified replay procedure
6. S3 outputs are tagged with `customer`, `campaign`, `model-id`, and `human-reviewed`
7. The 6 alarms above are wired and tested
8. Cost burn is tracked per customer, per campaign, with alerts at 150% of forecast

## Troubleshooting & Edge Cases

- **Step Functions executions piling up "running":** `waitForTaskToken` never received `SendTaskSuccess`. Either the webhook receiver is broken, or the Adobe-side job genuinely failed silently. Add `TimeoutSeconds` per state with an explicit failure transition.
- **DLQ filling with 422s:** Customer is feeding bad prompts. Don't replay — surface to the customer's UI with a clear "this prompt was rejected" message.
- **Throughput much lower than provisioned RPM:** TokenBucket headroom too tight, or Step Functions cold-start overhead is dominating. Profile a single execution end-to-end before tuning the bucket.
- **Cost burn 3× forecast:** See `firefly-cost-optimization` — almost always retry storms, duplicate generations from missing idempotency, or uncached prompts.
- **One customer's jobs starve out others:** No tenant fairness in the queue. Either move to per-customer FIFO queues or implement weighted round-robin in the dispatcher.
- **Webhook receiver flaps:** Add a retry budget on EventBridge with exponential backoff. If a customer's webhook is down for >1 hour, switch their delivery to polling and alert their CS team.
- **DynamoDB rate-limit table hot-partitioned:** A single high-volume credential is hammering one partition. Sharded counter pattern: append a random suffix `(0..N-1)` to the partition key, then SUM across shards on read.

## Chaining with Other Skills

- `firefly-services-rate-limits` — Provides the TokenBucket, backoff, and DLQ classification patterns
- `photoshop-api-composition` — Provides the per-job state-machine pattern that runs inside Step Functions
- `firefly-services-auth` — Token caching, especially important when worker concurrency is high
- `firefly-services-storage-refs` — Storage URL hygiene at every stage
- `firefly-cost-optimization` — Cost dashboard wiring and the 3× burn debugging playbook
- `firefly-brand-guardrails` — Where the `human-reviewed` tag and review queue plug into the pipeline
- `firefly-services-troubleshoot` — When a specific failure mode needs deep-dive

## References

- [AWS Step Functions — Wait for Callback with Task Token](https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html#connect-wait-token)
- [AWS SQS message-driven processing patterns](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-message-driven-processing.html)
- [DynamoDB sharded counters](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-sharding.html)
- [Firefly API Technical Usage Notes](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/usage-notes/)
- [Photoshop API Documentation](https://developer.adobe.com/firefly-services/docs/photoshop/)
