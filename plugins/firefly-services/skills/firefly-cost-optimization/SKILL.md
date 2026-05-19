---
name: firefly-cost-optimization
description: The production playbook for understanding and controlling Adobe Firefly Services consumption — where API spend actually goes, what to cache, what to batch, seed reuse for deterministic regenerations, prompt deduplication, response caching, custom-model-vs-style-reference cost tradeoff, and the "why is consumption 3× higher than expected" debugging sequence. Use whenever the user mentions "cost", "consumption", "API spend", "budget", "billing surprise", "consumption is high", "credits burning fast", "FinOps", "cost overrun", or wants to understand the cost shape of a generative pipeline before deploying it. Encodes the FinOps pattern that keeps generative pipelines on budget at scale.
license: Apache-2.0
compatibility: Cost model assumes a per-generation consumption unit (Firefly Generative Credit). Numbers and ratios shift over time — verify current pricing in the customer's Adobe enterprise agreement. Patterns apply to any consumption-billed Firefly Services deployment.
allowed-tools: Bash(curl:*) Bash(jq:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: production-architecture
---

# Firefly Cost Optimization

The FinOps playbook for Firefly Services. Every FDE engagement eventually gets the question: "why is consumption 3× what we forecast?" The answer is almost always one of six causes, all of which are preventable with the patterns below.

This skill encodes how to think about Firefly cost: where it actually goes, what knobs reduce it, what the cost shape of each endpoint looks like, and the debugging sequence that resolves a consumption surprise in hours instead of weeks.

## When to Use This Skill

Use this skill when:
- The user mentions "cost", "consumption", "credits", "API spend", "billing", "budget"
- Consumption is running ahead of forecast and you need to debug why
- A new pipeline is about to ship and the customer wants a cost forecast
- The architect is choosing between two patterns and cost is the tiebreaker (custom model vs style reference, generate vs cache, base vs custom model)
- The customer is renewing their Firefly enterprise contract and needs consumption justification

Do **NOT** use this skill when:
- The workload is low-volume interactive (a designer using the app) — cost optimization is premature
- The customer's spend is on Firefly-the-app (creative cloud subscription), not Firefly Services API — different cost model

## Where Cost Actually Goes — The Five Buckets

API consumption breaks down into five buckets. Memorize the order — it tells you where to look first when consumption is high.

| Bucket | Typical share of spend | What drives it |
|---|---|---|
| 1. Base generation calls | 50-70% | One credit per output image; volume × variants |
| 2. Retry storms | 5-25% (variable) | Retries that should have been client-side fixes; the #1 surprise |
| 3. Custom model training | 5-15% | One-time per model; amortized across the model's lifetime |
| 4. Photoshop / Lightroom operations | 5-15% | Usually metered differently; check the enterprise agreement |
| 5. Storage and bandwidth | 1-5% | S3 / equivalent; usually a rounding error compared to generation |

Bucket 2 is the variable. A healthy pipeline runs at 5%. A pipeline with bad retry logic and duplicate-generation bugs runs at 25%. The gap is the gap between forecast and reality.

## Step 1 — Forecast Before You Build

Before any pipeline ships, forecast consumption. The formula:

```
monthly_credits = (
  active_campaigns_per_month *
  jobs_per_campaign *
  variants_per_job *
  aspects_per_variant
) * (1 + retry_overhead_pct) * (1 + rejection_overhead_pct)
```

| Variable | Healthy value | Surprise value |
|---|---|---|
| `variants_per_job` | 2-4 | 10+ (designers exploring without batching) |
| `aspects_per_variant` | 3-6 (per platform) | 12+ (rendering for every conceivable surface) |
| `retry_overhead_pct` | 5% | 30% (bad retry logic; see §3) |
| `rejection_overhead_pct` | 10% | 30% (low custom-model quality; see `firefly-brand-guardrails`) |

Multiply the surprise values across the formula and you arrive at the 3-5× overrun that real pipelines hit. The forecast is a contract: the build team signs up for it, the FinOps team alarms when actual exceeds it.

## Step 2 — Caching: The Highest-Leverage Lever

Three caches matter, in order of impact:

### Cache 1: Prompt deduplication (per-campaign)

In a single campaign run, the same prompt is often submitted multiple times — by different upstream systems, retry logic, or accidental duplicates. A prompt-deduplication cache keyed on `(promptHash, modelId, seed, parameters)` returns the prior output without calling Firefly.

```js
const cacheKey = sha256(JSON.stringify({
  prompt: req.prompt,
  customModelId: req.customModelId,
  seed: req.seed,
  size: req.size,
  contentClass: req.contentClass,
  styleReference: req.style?.imageReference?.source?.uploadId,
  structureReference: req.structure?.imageReference?.source?.uploadId,
}));

const cached = await ddb.get({ TableName: 'firefly-prompt-cache', Key: { cacheKey } });
if (cached.Item) return cached.Item.outputUrls;

const result = await firefly.generate(req);
await ddb.put({ TableName: 'firefly-prompt-cache', Item: {
  cacheKey, outputUrls: result.outputs.map(o => o.image.url), ttl: ...
}});
return result.outputs.map(o => o.image.url);
```

Cache TTL: align with the validity of the Firefly output URLs. Typically 24 hours, though re-hosting outputs in your own bucket lets you cache indefinitely.

Typical hit rate: 5-15% on a campaign run, climbing to 25%+ in batch-driven workflows where duplicate prompts are common.

### Cache 2: Token cache (per-credential)

The IMS token cache is covered in `firefly-services-auth`. It is not a cost lever directly, but a broken token cache means re-auth on every call, which can hammer rate limits and cause retry storms (which *are* a cost lever).

Token cache hit ratio < 99% means refresh logic is broken — fix before optimizing anything else.

### Cache 3: Asset cache (post-generation)

Outputs cached in your own S3 (instead of re-fetching from Adobe's temporary URLs) saves bandwidth and avoids URL-expiry retries. Always re-host generated assets immediately.

## Step 3 — Retry Storms: The #1 Cost Surprise

A retry storm happens when the pipeline retries calls that should not be retried. Patterns:

| Anti-pattern | Cost impact |
|---|---|
| Retry on 422 (content rejection) | Burns credits on guaranteed failures |
| Retry on 403 (entitlement) | Burns credits + alerts noise |
| Retry on 400312 (expired storage ref) without regenerating the ref | Same call fails again; infinite loop until DLQ |
| Unbounded retry attempts | One bad input runs forever |
| Missing idempotency key | Upstream retries cause duplicate generations |
| Step Functions retry + Lambda retry + SQS retry | 3 layers of retry = 27× the original calls |

The retry classification table from `firefly-services-rate-limits` §5 is the canonical reference. The cost-specific extension:

| Failure | Cost-optimal action |
|---|---|
| 429 | Retry with `Retry-After` honoring — these will succeed |
| 500-504 | Retry up to 3 times — typically succeed |
| 422 (content) | Never retry — surface to user; let them fix the prompt |
| 403 (entitlement) | Never retry — alert ops |
| 400312 (storage expired) | Regenerate ref *then* retry once |
| 404 (custom model retired) | Never retry — surface to user |
| Network timeout | Retry once with longer timeout |

Audit one week of DLQ contents. Any class that should not have been retried but was, multiplied by the average retry count, equals your retry-storm overhead.

## Step 4 — Seed Reuse for Deterministic Regeneration

The `seed` parameter on Generate Image lets you reproduce an exact output. For cost control, this matters in two scenarios:

| Scenario | Pattern |
|---|---|
| Design iteration ("almost right — generate again with this small tweak") | Pass the original seed; tweak only the prompt fragment that changed. Result is much closer to the original. |
| Reproducibility for legal/audit | Store the seed with every generated asset; can regenerate the exact same pixels months later if challenged |

Without seed reuse, "make it slightly different" requires generating multiple new variants and picking. With seed reuse, one targeted generation often suffices.

```json
{
  "prompt": "an icon of a key, brand-light style",
  "customModelId": "...",
  "seed": [42],
  "size": {"width": 1024, "height": 1024}
}
```

Store the seed alongside every output asset in DynamoDB. When designers want a variation, the UI surfaces "regenerate with tweak" using the original seed.

## Step 5 — Custom Model vs Style Reference: The Cost Tradeoff

Both produce on-brand output. The cost shapes are different.

| Lever | Up-front cost | Per-generation cost | Best for |
|---|---|---|---|
| Custom model | 1 model training (hours, low credits) | 1 credit per generation (same as base) | High-volume brand-consistent output; iconography; product subject |
| Style reference | $0 | 1 credit + bandwidth/storage for the reference | Low-volume / one-off brand-styled output; rapid prototyping |
| Structure reference | $0 | 1 credit + bandwidth/storage for the reference | Composition control independent of style |

Break-even math: a custom model amortizes once you exceed ~hundreds of generations against the same style. Below that, style references are cheaper. Above that, the model wins — and as a bonus, the model is faster (no reference upload per call) and more consistent than reference-only.

| Workflow shape | Recommendation |
|---|---|
| Designer exploring a new brand style | Style reference; don't train a model yet |
| Brand has landed; campaigns running | Train custom model; deprecate references |
| One-off creative test | Style reference; never train |
| Multi-customer SaaS with shared style | Custom model per customer (do not share) |

See `firefly-custom-models` for the full lifecycle.

## Step 6 — Right-Sizing Variants and Aspects

The variants and aspects multiply through every campaign. Be deliberate:

| Knob | Cost-optimal default | Surprise default |
|---|---|---|
| `numVariations` per generate call | 1, regenerate if not satisfied | 4 (the API default, burns 4× per request) |
| Aspect ratios per asset | 3 (one per major platform) | 8+ (every conceivable cut) |
| Resolution | 1024×1024 standard; upscale on demand | Always max resolution |
| Style + structure refs | Use when needed | Always set, even when not needed (slows generation but not cost) |

The single highest-impact change: default `numVariations` to 1. Designers can request more if they need them. Default 4 burns 4× the credits before anyone notices.

## Step 7 — The "Consumption is 3× Forecast" Debugging Sequence

When a customer reports overrun, work this sequence in order. Stop when you find the cause — usually one of the first three.

### 1. Check the retry rate

Query metrics for the past week:

| Metric | Healthy | Concerning |
|---|---|---|
| 429 rate | < 1% | > 5% |
| 5xx retry rate | < 2% | > 10% |
| DLQ depth (current) | 0 | > 0 sustained |
| Average retries per success | 1.05 | > 1.3 |

Above the "concerning" thresholds, retry storm is the answer. Audit DLQ classification (§3).

### 2. Check for duplicate generations

In the job ledger, GROUP BY `promptHash + customModelId + seed`. If the same key has multiple `succeeded` jobs, idempotency is broken upstream.

```sql
-- Athena over the job ledger
SELECT promptHash, customModelId, seed, COUNT(*) as duplicate_count
FROM firefly_job_ledger
WHERE status = 'succeeded' AND createdAt > now() - INTERVAL '7' DAY
GROUP BY promptHash, customModelId, seed
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC LIMIT 100;
```

Duplicates × credits-per-duplicate = duplicate-generation overhead. Fix by enforcing idempotency keys at intake (see `firefly-batch-pipeline` §1).

### 3. Check variant and aspect counts

Audit the actual `numVariations` and aspect-count distributions across recent jobs. If `numVariations >= 4` is the modal value, switch to default 1 and watch consumption drop.

### 4. Check rejection rate

If the human review queue (see `firefly-brand-guardrails`) is rejecting > 20% of output, the model or prompts are off-brand and the pipeline is regenerating to compensate. Retrain or tighten deny-lists.

### 5. Check for cache miss rate

Prompt deduplication cache hit rate should be in the 5-15% range. Below 5% means either the cache is broken (check TTLs and key construction), or the workload genuinely has no duplicates (which is fine).

### 6. Check for unused custom models

Models that were trained for an exploration and never retired still incur training charges. Audit the model registry quarterly; delete models that have not been called in 60 days.

## Step 8 — Cost Observability — Dashboards to Build

| Dashboard | Metric | Alert when |
|---|---|---|
| Per-campaign burn | Credits/hour, plotted against forecast | Actual > 150% of forecast for 1 hour |
| Per-credential burn | Credits/day per `client_id` | Top credential > 2× the next |
| Retry overhead | (Total calls − unique jobs × 1) / unique jobs | > 10% |
| Duplicate rate | Jobs / unique `(promptHash, modelId, seed)` | > 1.05 |
| Cache hit rate | Cache hits / total prompts | < 5% for 7 days (cache may be broken) |
| Rejection rate | Rejected reviews / total reviews | > 20% |
| Unused model count | Models with 0 calls in 60 days | > 5 |

Per-customer cost allocation uses S3 object tags (see `firefly-batch-pipeline` §6). Roll up to a daily / weekly / monthly customer invoice.

## Validate

The cost layer is production-ready when:

1. Every campaign has a documented monthly forecast and an alarm at 150% of forecast
2. The retry-rate and duplicate-rate metrics are dashboarded with alarms
3. Idempotency keys are enforced at intake (no duplicate generations from upstream retries)
4. Prompt-dedup cache exists with measured hit rate
5. The DLQ classification rules in §3 are wired (no retry on 422 / 403 / 404)
6. `numVariations` defaults to 1; designers opt in to more
7. Custom-model registry is audited quarterly; unused models are deleted
8. The 7 dashboards above exist

## Troubleshooting & Edge Cases

- **Forecast looks healthy but invoices are 2× expected:** The forecast omitted a category. Check Photoshop / Lightroom / Custom Model training charges — they bill separately and are often missed.
- **One credential burning 5× the others:** Either one customer is doing legitimate high-volume work, or one credential leaked and is being abused. Rotate and audit.
- **Cache hit rate dropped after a deploy:** Cache key construction broke — a new parameter changes the hash. Audit cache key vs request shape.
- **Retry overhead climbed without a code change:** Firefly-side incident is in progress. Check the Adobe status page; throttle the pipeline until it clears.
- **Custom-model generation is consistently slow + expensive:** The model is poorly trained; high seed-to-seed variance forces designers to regenerate. Retrain with better data.
- **Reviewers reject everything from a new template:** Template is off-brand. Pull from production; iterate; do not just "regenerate until it lands" — every regeneration burns credits.
- **Bandwidth charges from re-fetching Firefly outputs:** Outputs are at temporary URLs that expire. Re-host in your bucket immediately after generation success.

## Chaining with Other Skills

- `firefly-services-rate-limits` — Retry classification is the cost-burn cornerstone
- `firefly-batch-pipeline` — Idempotency, job ledger, and observability live there
- `firefly-brand-guardrails` — Rejection rate is a direct cost driver
- `firefly-custom-models` — Cost vs style-reference tradeoff
- `firefly-services-auth` — Token cache health affects retry rate
- `firefly-services-troubleshoot` — When a single failure mode dominates burn

## References

- [Firefly API Technical Usage Notes — Consumption](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/usage-notes/)
- [Firefly Custom Models Overview](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/custom-models/)
- [AWS Architecture: Exponential Backoff and Jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
- [FinOps Foundation — Cloud cost framework](https://www.finops.org/framework/)
