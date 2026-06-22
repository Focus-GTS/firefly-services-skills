---
name: firefly-brand-guardrails
description: Enforce brand compliance on generative output — custom-model lock-in, prompt and output content filtering, asset tagging for downstream policy, and the human-review queue pattern for regulated or brand-sensitive workloads. Use whenever the user mentions "brand compliance", "brand safety", "regulated industry", "review queue", "approval workflow", "content moderation", "brand guardrails", "legal review", "compliance hold", or generates assets for financial services, pharma, automotive, public sector, or any customer with a brand-review process. Encodes the production guardrail pattern that turns "Firefly generates whatever it wants" into "every asset that ships passes a documented compliance gate."
license: Apache-2.0
compatibility: Pairs with `firefly-custom-models` (model-level lock-in) and `firefly-batch-pipeline` (where the review queue plugs in). Review-queue UI can be hand-rolled or built on a workflow tool (Adobe Workfront, Asana, Jira). Tagging works on any object store (S3, GCS, Blob).
allowed-tools: Bash(curl:*) Bash(jq:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: production-architecture
---

# Firefly Brand Guardrails

The compliance layer for production generative pipelines. Base Firefly is commercially-safe at the model level — IP-safe training data, output filtering for harmful content. But "commercially safe" is not the same as "on brand." Brand guardrails are the customer-specific layer that sits between Firefly and the customer's published assets.

This skill encodes the pattern that converts a generative pipeline from "marketing previews the output" to "every shipped asset has a documented approval lineage that survives legal audit."

## When to Use This Skill

Use this skill when:
- The customer is in a regulated industry (financial services, pharma, automotive, public sector, healthcare)
- Marketing legal will need to approve assets before they ship
- The brand has explicit do/don't rules (no competitor products visible, no specific colors, no minors, no specific weather/locations)
- The user mentions "brand safety", "review queue", "approval workflow", "compliance hold", "legal sign-off"
- Output will be published externally (ad campaigns, social, broadcast) — never just "internal preview"
- The customer has had a brand-incident in the past and wants belt-and-suspenders

Do **NOT** use this skill when:
- The output is for internal ideation or storyboards only — base Firefly is fine
- The customer has no brand-review process and explicitly does not want one — don't impose process they won't follow

## The Four-Layer Guardrail Stack

Brand guardrails are not a single feature. They are four layers, each filtering at a different stage:

```
Layer 1: Model-level lock-in        (custom models, deny base model entirely)
            ↓
Layer 2: Prompt-side filtering      (deny-list, prompt rewriting, banned terms)
            ↓
Layer 3: Output-side filtering      (visual classifiers, content tags, moderation API)
            ↓
Layer 4: Human review queue         (sampling for spot-check, blocking for high-risk)
```

A regulated-industry pipeline runs all four. A brand-sensitive but not regulated pipeline often runs 1, 2, and 4, skipping 3 for cost reasons.

## Step 1 — Layer 1: Model-Level Lock-In

The strongest guardrail is restricting which model can run at all. For brand-critical workflows, the pipeline does not call the base Firefly model — it only calls custom models trained on approved brand assets.

| Approach | Pattern |
|---|---|
| Hard lock | Pipeline code refuses to submit any generation that does not include a `customModelId` from an allowlist |
| Soft lock | Base model allowed for internal previews; custom model required for any output that goes to S3 with `intent=published` |
| Per-campaign lock | Campaign config specifies the exact `customModelId`; pipeline rejects mismatches |

Implementation sketch:

```js
const ALLOWED_MODELS = new Set([
  'brand-light-icon-style-v3',
  'brand-dark-icon-style-v3',
  'brand-product-subject-v2',
]);

function validateGenerationRequest(req) {
  if (req.intent === 'published' && !ALLOWED_MODELS.has(req.customModelId)) {
    throw new GuardrailViolation(
      `Published generations must use an approved custom model. Got: ${req.customModelId ?? 'none'}`
    );
  }
  if (req.intent === 'published') {
    req.headers['x-model-version'] = 'image3_custom'; // required for custom models
  }
}
```

See `firefly-custom-models` for the full custom-model lifecycle.

## Step 2 — Layer 2: Prompt-Side Filtering

Two patterns: deny-list and rewriting.

### Deny-list

A list of banned terms (competitor names, prohibited categories, brand-conflict phrases). Pipeline rejects prompts containing any term on the list.

| List type | Examples (generic) |
|---|---|
| Competitor terms | Competitor product names, competitor tagline phrases |
| Regulated content | Drug brand names, medical claim language, financial promise language |
| Brand voice | Slang, jargon, or tone that conflicts with brand guidelines |
| Subject restrictions | "minor", "child" (if brand prohibits), "weapon" (if brand prohibits) |

Match deny-list terms case-insensitively, with simple stem rules. Aggressive regex matches over-filter — be specific. Maintain the list in version control, not in code, so legal can update without a deploy.

### Prompt rewriting

For terms that should be substituted rather than rejected, run a rewriting pass:

| Input fragment | Rewritten |
|---|---|
| "modern office" | "modern office with brand-compliant interior elements" |
| "person at desk" | "professional, age 25-55, business-casual attire, at desk" |

Rewriting is a Lambda that runs before the Firefly call. Keep it deterministic — same input always produces the same output. Log both the original and rewritten prompt for audit.

## Step 3 — Layer 3: Output-Side Filtering

Firefly's built-in content filtering blocks the obvious (CSAM, gore, explicit content). Brand filtering is the layer on top.

Three options, in order of cost:

| Option | Cost | Accuracy | When |
|---|---|---|---|
| Tag-only (defer to humans) | $0 | N/A | Always — at minimum, tag for downstream policy |
| Computer-vision classifier (off-the-shelf) | Low | 70-85% | Regulated industries; high-volume |
| Custom classifier trained on brand examples | Medium | 90%+ | Brand-critical workflows with budget |

### Tag-only pattern

For every generated asset, attach metadata at persistence time:

```json
{
  "modelId": "brand-light-icon-style-v3",
  "promptHash": "sha256:...",
  "outputDimensions": "1920x1080",
  "generatedAt": "2026-05-19T14:21:08Z",
  "complianceTags": {
    "containsPerson": null,
    "containsCompetitorBranding": null,
    "containsRegulatedSubject": null
  },
  "humanReview": "pending"
}
```

`complianceTags` starts as null. A reviewer (or classifier) fills them in. The pipeline holds publication until they are non-null and pass policy.

### Classifier pattern

For volume workloads, run a classifier between Firefly success and S3 persistence:

```
Firefly success → download output → classifier → tag results → persist + queue for review
```

Use a hosted classifier (AWS Rekognition, GCP Vision AI, Azure Computer Vision) for off-the-shelf coverage. Custom classifiers (trained on Sagemaker / Vertex AI / Azure ML) for brand-specific concepts (e.g., "is the brand logo present and correctly placed").

## Step 4 — Layer 4: Human Review Queue

The terminal guardrail. Even with the previous three layers, some percentage of assets land in a review queue before they can ship.

### Three review modes

| Mode | Volume to review | When |
|---|---|---|
| 100% | Every asset | Highest-risk: regulated industries, brand launches, executive-visible campaigns |
| Sampling (e.g., 10%) | Random + flagged-by-classifier | Steady-state brand-sensitive workloads |
| Flagged-only | Only assets the classifier flagged | High-volume after the pipeline has earned trust |

A typical FDE engagement starts at 100%, tightens to sampling once the team trusts the pipeline (usually 4-8 weeks in), then drops to flagged-only after a quarter of clean operation.

### Queue architecture

```
Pipeline output (status=succeeded, humanReview=pending)
       ↓
SNS topic: needs-review
       ↓
Review UI (custom-built or Workfront / Asana / Jira)
       ↓
Reviewer marks: approved | rejected | escalate
       ↓
       ├── approved  → S3 tag humanReview=approved; release for publication
       ├── rejected  → S3 tag humanReview=rejected; move to /rejected/ prefix; notify originator
       └── escalate  → second-level reviewer (legal / brand director); notification + SLA timer
```

| Concern | Pattern |
|---|---|
| SLA | Track review queue depth and per-asset wait time; alarm if p95 wait > customer-agreed SLA |
| Reviewer load | Round-robin assignment with caps per reviewer per day; prevent reviewer burnout |
| Audit trail | Every review decision logged with reviewer ID, timestamp, and reason if rejected |
| Recall | If a reviewer mistakenly approves something, a "recall" action retroactively rejects and pulls the asset |

### Rejection-reason taxonomy

Reviewers should not free-text reject. Maintain a fixed taxonomy:

| Code | Meaning | Pipeline action |
|---|---|---|
| `R-COMPETITOR` | Competitor branding visible | Block; retrain custom model if recurring |
| `R-OFF-BRAND-COLOR` | Color palette wrong | Adjust prompt or retrain |
| `R-OFF-BRAND-COMPOSITION` | Composition violates brand guidelines | Adjust template |
| `R-SUBJECT-INAPPROPRIATE` | Subject matter outside brand voice | Adjust prompt; add deny-term |
| `R-QUALITY` | Visual quality below standard | Regenerate (different seed); see `firefly-cost-optimization` |
| `R-LEGAL-CLAIM` | Implies medical / financial / safety claim | Block; flag for legal review |

The taxonomy feeds back into the deny-list and the custom model retraining cycle. A workflow without this feedback loop will repeat the same rejections forever.

## Step 5 — Wiring into the Batch Pipeline

In the `firefly-batch-pipeline` Step Functions state machine, the review gate is a state after persistence:

```
... → PersistAssets → TagForReview → WaitForHumanReview → PublishOrReject
```

`WaitForHumanReview` uses `waitForTaskToken` — the state pauses until the review UI calls `SendTaskSuccess` (or `SendTaskFailure` if rejected). Wait timeout = customer-agreed SLA + buffer. Past the timeout, escalate.

| Concern | Pattern |
|---|---|
| Pipeline blocking on slow review | Track per-campaign queue depth; alarm and add reviewer capacity |
| Customer paid for generation that was rejected | Cost reconciliation includes rejection rate (see `firefly-cost-optimization`) |
| Reviewers want to compare against approved examples | Build a "reference grid" UI showing 4-6 approved examples next to the candidate |

## Validate

The guardrail stack is production-ready when:

1. The pipeline refuses to submit `intent=published` generations without an approved `customModelId`
2. The deny-list lives in version control and legal can update it without an engineering deploy
3. Every output asset carries `complianceTags` and `humanReview` metadata
4. A review queue exists with a documented reviewer SLA and an alarm if p95 wait time exceeds it
5. Rejection reasons follow a fixed taxonomy that feeds back into deny-lists and retraining
6. Audit trail per asset includes: prompt, model, seed, reviewer, decision, timestamp, reason code

## Troubleshooting & Edge Cases

- **Reviewers approve too quickly without looking:** Audit shows >100 approvals/hour per reviewer. Cap throughput; require at least 30 seconds per asset; introduce calibration checks (planted rejections to verify reviewers are looking).
- **High rejection rate (>20%):** The pipeline is producing too much off-brand output. Trace back: is the custom model stale? Is the deny-list catching enough? Retrain or expand filtering.
- **Legal flags a category mid-campaign:** Add the category to the deny-list immediately; retroactively scan in-flight and queued jobs; pull published assets if needed.
- **Reviewer disagrees with classifier:** Track the disagreement rate. If the classifier is wrong >10% of the time, retrain. If the reviewer is inconsistent with peers, calibration session.
- **Custom model output drifts after Adobe base update:** The base model under the custom layer changed. Retrain (see `firefly-custom-models` §7).
- **Customer wants to bypass review for "small" campaigns:** Bypass is fine for internal-only `intent`. For any `intent=published`, no bypass — that is the whole point of the gate.
- **Asset approved but later flagged externally (e.g., social media incident):** Recall workflow pulls the asset, marks `humanReview=recalled`, alerts brand team, and logs the case for taxonomy expansion.

## Chaining with Other Skills

- `firefly-custom-models` — Layer 1 lock-in depends on a healthy custom-model library
- `firefly-batch-pipeline` — Where the review gate plugs into the production state machine
- `firefly-cost-optimization` — Rejection rate is a primary cost-burn driver
- `firefly-services-storage-refs` — Where the compliance metadata gets attached
- `firefly-services-troubleshoot` — When 422s spike, the deny-list or model needs attention

## References

- [Firefly API — Commercially safe generative AI](https://www.adobe.com/products/firefly/enterprise.html)
- [Firefly Custom Models Overview](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/custom-models/)
- [AWS Rekognition — Content moderation](https://docs.aws.amazon.com/rekognition/latest/dg/moderation.html)
- [AWS Step Functions — Wait for Callback with Task Token](https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html#connect-wait-token)
