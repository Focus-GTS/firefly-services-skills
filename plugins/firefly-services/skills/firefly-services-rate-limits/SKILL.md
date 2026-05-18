---
name: firefly-services-rate-limits
description: Production rate-limit strategy for Adobe Firefly Services — default 4 RPM per credential, requesting increases, exponential backoff with jitter, token-bucket clients, SQS-fronted queueing for batch workloads, dead-letter queue handling, and per-endpoint quota planning. Use whenever the user mentions "429", "rate limited", "Too Many Requests", "Firefly is slow", "batch processing", "queueing", "high volume", "campaign at scale", or designs a system that will exceed 4 RPM. Encodes the production pattern that takes a generative pipeline from blocked at the default RPM ceiling to enterprise-scale campaign throughput.
license: Apache-2.0
compatibility: Applies to all Firefly Services endpoints (`firefly-api.adobe.io`, `pscx.adobe.io`, `lr.adobe.io`). Queue patterns shown for AWS (SQS + Lambda) and equivalent on GCP (Pub/Sub + Cloud Functions) or Azure (Service Bus + Functions).
allowed-tools: Bash(curl:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: production-architecture
---

# Firefly Services Rate Limits

The production playbook for operating Firefly Services at scale. Default rate limits are intentionally low; the architecture below is the pattern used in production for any FDE engagement that exceeds a single-user workload — it scales a pipeline from blocked at the default ceiling to enterprise-grade campaign throughput.

## When to Use This Skill

Use this skill when:
- A 429 has been seen, or is anticipated for the workload size
- A campaign / batch / pipeline will issue more than ~50 calls in a burst
- The user mentions volume estimates beyond a casual demo
- Designing infrastructure that wraps Firefly Services
- Planning quota with the customer's Adobe account manager

Do **NOT** use this skill when:
- The workload is genuinely one-shot interactive — direct calls are fine
- A 429 is appearing despite low volume — start with `firefly-services-troubleshoot` §3

## Default Rate Limits — Know the Numbers

Firefly Services rate limits are per-credential, per-endpoint, with both per-second and per-minute components. Defaults at the time of writing:

| Endpoint family | Default per credential | Notes |
|---|---|---|
| Generate Image (V3 async) | ~4 RPM | Most common limit; first thing to hit |
| Generate Similar | ~4 RPM | Shares quota family with Generate |
| Generate Expand / Fill | ~4 RPM | Shares quota family with Generate |
| Generate Video | Lower (~1 RPM) | Heavier compute |
| Custom Model training | 1 concurrent job per org | Throughput is training-time bound, not RPM |
| Photoshop API | ~10 RPM | Higher than Firefly |
| Lightroom API | ~10 RPM | Higher than Firefly |
| Token endpoint (IMS) | Effectively unlimited | Cache aggressively anyway |

Numbers shift over time and can be raised per-customer via Adobe account management. Verify current limits in the [Technical Usage Notes](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/usage-notes/) and check the response headers — `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` are returned on most endpoints.

## The Production Strategy

A real workload that exceeds 50 calls follows this four-layer pattern:

```
Customer-facing API
  ↓ (synchronous, low-latency response: "your job is queued")
Job intake → SQS / Pub/Sub / Service Bus
  ↓ (async worker pool, concurrency-bounded)
Token-bucket limiter (per-credential)
  ↓ (paces calls within the rate envelope)
Firefly Services
  ↓
Result persistence + customer notification (webhook or polling)
```

Each layer exists for a specific reason — skipping any one of them is the #1 cause of weekend pager incidents.

## Step 1 — Request a Rate-Limit Increase

This is a non-technical step but it is the first one. Adobe will raise rate limits per-customer on request — you do not need to engineer around the default if the customer has volume to justify it.

| Action | Who |
|---|---|
| Open a support ticket with the customer's Adobe Enterprise account team | Customer's procurement / account owner |
| Provide projected volume: peak RPM, daily call count, business justification | FDE consultant |
| Adobe responds with a proposed limit; agree and implement | Adobe + Customer |

Typical raises: 4 RPM → 60 RPM is common for committed enterprise customers. Higher with specific justification. The lead time is usually 1-2 weeks.

Even with a raised limit, build the architecture below — the limit exists, just at a higher number.

## Step 2 — Token-Bucket Limiter (Client-Side)

The lowest layer is a per-credential token-bucket that paces outbound requests to ~80% of the provisioned limit. The 20% headroom absorbs jitter from concurrent workers and Adobe-side response time variance.

Node implementation:

```js
class TokenBucket {
  constructor({ ratePerMin, burst = ratePerMin }) {
    this.tokensPerMs = ratePerMin / 60_000;
    this.maxTokens = burst;
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  async take() {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const msPerToken = 1 / this.tokensPerMs;
      await sleep(msPerToken + Math.random() * 50); // jitter
    }
  }

  refill() {
    const now = Date.now();
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + (now - this.lastRefill) * this.tokensPerMs,
    );
    this.lastRefill = now;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
```

Use `ratePerMin = provisionedLimit * 0.8`. Set `burst` to roughly 2 seconds of capacity — enough to absorb microbursts without queue starvation.

For multi-tenant services with per-customer credentials, hold one limiter per `client_id`. Do **not** share limiters across credentials.

## Step 3 — Exponential Backoff with Jitter (Retry Path)

When a 429 still slips through despite client-side limiting, retry with exponential backoff plus full jitter. Full jitter (random uniform `[0, max]`) is the right choice — equal jitter still produces thundering herds under heavy load.

```js
async function callWithBackoff(fn, { maxAttempts = 5 } = {}) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status ?? err.status;
      if (status !== 429 && !(status >= 500 && status < 600)) throw err;
      if (attempt >= maxAttempts) throw err;
      const retryAfterSec = parseInt(err.response?.headers?.get('retry-after') ?? '0', 10);
      const baseMs = retryAfterSec
        ? retryAfterSec * 1000
        : Math.min(60_000, 1000 * 2 ** attempt);
      const jitterMs = Math.random() * baseMs;
      await sleep(jitterMs);
    }
  }
}
```

Honor `Retry-After` when present — Adobe knows the exact moment the quota refills.

Cap attempts at 5. Beyond that, surface the failure to the application — the request is going to dead-letter regardless.

## Step 4 — Queue-Fronted Architecture

For any workload above ~100 calls, place a durable queue in front of Firefly. This is non-negotiable. Without it, a transient Firefly slowdown becomes an application outage.

### AWS reference architecture

```
API Gateway / ALB                                                 (intake)
  ↓
Lambda: validate + enqueue                                        (synchronous)
  ↓
SQS Standard queue (main work)                                    (durable)
  ↓
Lambda: Firefly worker (concurrency-bounded)                      (paces calls)
  │   - Pulls 1 message at a time
  │   - Holds a per-credential TokenBucket
  │   - Calls Firefly with backoff
  │   - On success: writes result to S3 + DynamoDB
  │   - On terminal failure: forwards to DLQ
  ↓
Result: S3 (images) + DynamoDB (job state)                        (persistence)
  ↓
EventBridge → customer webhook OR client polling                  (notification)

Dead-letter queue (DLQ) attached to main SQS with maxReceiveCount=3
  ↓
Alarm + manual replay path
```

Key configuration:

| Component | Setting | Why |
|---|---|---|
| SQS visibility timeout | 6 × max Firefly response time | Worker holds the message until call completes |
| Lambda reserved concurrency | `floor(provisioned RPM / 60)` | Hard cap on concurrent calls |
| Lambda batch size | 1 | Per-message error isolation |
| SQS maxReceiveCount | 3 | Move to DLQ after 3 failed attempts |
| DLQ retention | 14 days | Manual replay window |

Equivalent patterns on GCP: Pub/Sub + Cloud Functions, with Cloud Run for the worker if Firefly response times exceed Cloud Functions limits. On Azure: Service Bus + Functions, premium plan for sustained throughput.

### Workload sizing example (representative)

| Use case | Estimated daily volume | Peak burst | Provisioned RPM | Architecture |
|---|---|---|---|---|
| Key art generation | low thousands of calls/day | hundreds in a 5-minute window | raised limit (negotiated per customer) | SQS + Lambda worker, concurrency 1 |
| Title compositing | low thousands of calls/day | hundreds in a 5-minute window | shares with above | Same queue, different topic |
| Campaign full-run | tens of thousands of calls across several hours | hundreds-to-thousands per hour | raised limit | Same architecture, multi-worker, runs over hours not seconds |

The peak campaign-run number (tens of thousands of calls in a single run) is the visible proof point that proves the system works at customer-presented scale. Hitting it takes months of architectural maturation; this skill is the shape that gets there.

## Step 5 — Dead-Letter Queue Handling

Every queue-fronted system has a DLQ. The patterns that matter:

| Failure type | Action |
|---|---|
| Adobe-side 5xx (transient) | Replay from DLQ after Adobe status page clears |
| Content-validation 422 (terminal) | Do not replay — the prompt or input was rejected; surface to customer |
| 403 (entitlement) | Do not replay — credentials are wrong; alert ops |
| Custom-model retired (404) | Do not replay — surface to customer; suggest re-training |
| Storage-reference expired (400312) | Replay only after regenerating fresh references |

The DLQ replay tool must classify the failure before replaying. Bulk-replay of a DLQ without classification will burn quota on requests that will never succeed.

## Step 6 — Observability — What to Log

For every Firefly call:

- `client_id` (which credential)
- Endpoint + method
- Request UUID / correlation ID
- Wall-clock latency
- HTTP status
- Response `X-RateLimit-Remaining` header
- Token cache hit/miss (was a new token fetched)
- Retry count if applicable

Dashboards to build:

- p50 / p95 / p99 latency per endpoint
- 429 rate per credential per hour
- DLQ depth and arrival rate
- Token cache hit ratio (should be >99%)

A 429 rate above 1% is the canary for an under-provisioned credential. A token cache hit ratio below 99% means refresh logic is broken.

## Validate

Rate-limit architecture is production-ready when:

1. The provisioned RPM is documented and a token-bucket limiter paces calls to 80% of it
2. Every Firefly call goes through exponential-backoff retry with `Retry-After` honoring
3. Any workload >100 calls is queue-fronted (not direct)
4. A DLQ exists with a documented replay procedure
5. The 429 rate metric is monitored and alerts at 1%
6. Observability captures `X-RateLimit-Remaining` so Adobe-side quota drift is visible

## Troubleshooting & Edge Cases

- **429s spiking after a code deploy:** Likely concurrent workers exceeding the limit. Check Lambda reserved concurrency or your worker pool size; reduce to match `provisionedRPM / 60`.
- **429s coming from a single credential while others are fine:** Per-credential limit. Either request a raise for that credential or split the workload across more credentials.
- **`Retry-After` header missing on 429:** Some legacy endpoints don't return it. Fall back to exponential backoff with cap.
- **Custom-model jobs queue but never run:** Custom-model training is concurrency 1 per org. Other jobs queue behind it; this is by design.
- **Photoshop / Lightroom calls failing at 10 RPM but Firefly is fine:** They have separate quotas. Treat as separate limiters.
- **Burst at start of day, then steady:** Cold cache. Pre-warm the token cache during deploy / startup.

## Chaining with Other Skills

- `firefly-services-auth` — Token caching is half of the rate-limit story
- `firefly-services-troubleshoot` — 429 deep-dive
- `firefly-generate-image-v3-async` — The async pattern is the right shape for high-volume

## References

- [Firefly API Technical Usage Notes — Rate limits](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/usage-notes/)
- [AWS SQS message-driven processing patterns](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-message-driven-processing.html)
- [AWS Architecture: Exponential Backoff and Jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
