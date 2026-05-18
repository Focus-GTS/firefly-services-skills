---
name: photoshop-api-composition
description: Build complex multi-layer compositions with the Adobe Photoshop API — the multi-stage orchestration pattern (a typical state machine has 15-20 functions), layer ordering and blending, multi-template assembly, output rendering at multiple aspect ratios from one composition, and the integration pattern that feeds Firefly-generated content into a PSD pipeline. Use whenever the user needs more than simple smart-object replacement — combining Firefly outputs with template PSDs, chaining multiple Photoshop operations, building campaign assemblers, or orchestrating end-to-end pipelines that produce final renderable assets. Encodes the production state-machine pattern used in enterprise generative campaign pipelines.
license: Apache-2.0
compatibility: Requires `creative_sdk` scope and Photoshop API entitlement. Multi-stage compositions typically run on AWS Step Functions / GCP Cloud Workflows / Azure Durable Functions. Stateful job graph required.
allowed-tools: Bash(curl:*) Bash(jq:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: photoshop-api
---

# Photoshop API — Multi-Layer Composition

The orchestration pattern for production-grade campaign assembly. When the asset pipeline involves Firefly-generated content + template PSDs + multiple stages of editing + multiple output aspect ratios, you need a stateful workflow engine that coordinates many Photoshop API + Firefly calls in the right order.

This is the architectural pattern that scales a generative pipeline from one hand-built key-art to enterprise-grade campaign runs (tens of thousands of API calls).

## When to Use This Skill

Use this skill when:
- A single asset request requires more than one Photoshop API call
- Firefly-generated content (from `firefly-generate-image-v3-async` or `firefly-expand-fill`) feeds into a PSD pipeline
- One source must produce many aspect-ratio variants
- The workflow has decision points (e.g., "if image has people, use template A, else template B")
- The user mentions "state machine", "step functions", "workflow", "pipeline", "orchestrator", "campaign assembler"

Do **NOT** use this skill when:
- Single-step smart-object replacement is enough — use `photoshop-api-actions` directly
- The pipeline is purely Firefly generation without any compositing — use `firefly-generate-image-v3-async` + `firefly-services-rate-limits`

## The 15-20 Function State Machine

A production key-art and title-compositing pipeline runs as a state machine. Each function does one thing and one thing only — composable, independently retryable, observable.

```
START
  │
  ├── validate-request                 (input schema, asset URLs reachable)
  ├── load-campaign-config              (template id, brand assets, copy)
  ├── load-template-manifest            (PSD layer structure, cached)
  ├── route-by-content-type             (people present? logo only? etc.)
  │
  ├── detect-subject                    (Photoshop API: select_subject)
  ├── crop-and-fit                      (AutoCrop: detect-subject + composition)
  ├── upload-source-to-firefly          (storage ref)
  ├── generate-expanded-background      (firefly-expand: hero image → full bg)
  ├── poll-firefly-job                  (async, with retry)
  ├── download-firefly-output           (re-host in our bucket)
  │
  ├── composite-psd                     (Photoshop API: smart-object replacement)
  ├── apply-brand-action                (Photoshop API: actions/play .atn)
  ├── overlay-title-text                (Photoshop API: text-layer replacement)
  ├── poll-psd-job                      (async)
  ├── download-rendered-output          (jpeg/png)
  │
  ├── render-variant-aspects            (fan-out for each aspect ratio)
  │   ├── render-1920x1080              (Photoshop API: image/jpeg output)
  │   ├── render-1080x1920              (idem)
  │   └── render-1080x1080              (idem)
  │
  ├── persist-final-assets              (S3 multipart upload, DynamoDB record)
  ├── notify-customer                   (webhook or SNS)
  └── audit-log                         (Catalyst event ingest)
END
```

Each function:
- Is idempotent (re-running with the same input produces the same output)
- Returns a typed result that the next function consumes
- Logs structured events for observability
- Throws on terminal failure (no swallowed errors)

This composes into a state machine. AWS Step Functions, GCP Workflows, or Azure Durable Functions all support this shape.

## Step 1 — Pick the Orchestration Engine

| Cloud | Engine | When |
|---|---|---|
| AWS | Step Functions (Standard) | Long-running workflows, full audit trail |
| AWS | Step Functions (Express) | High-volume short-running ones |
| GCP | Cloud Workflows | Equivalent to Step Functions |
| Azure | Durable Functions | Equivalent, function-fused |
| Self-host | Temporal | Multi-cloud, more flexible, more ops burden |

For a typical 15-20 function pipeline, **AWS Step Functions (Standard)** is the right default. Express tier is for high-volume short jobs (think tens of thousands per day, sub-5-minute total duration) — not the typical asset pipeline.

## Step 2 — Function Boundaries

Each function should map to exactly one of:

| Function type | Example |
|---|---|
| External API call | Submit Firefly generate, poll Firefly status |
| Pure transformation | Calculate target dimensions from input |
| I/O | Read/write S3, query DynamoDB |
| Decision | Route to template A or B based on content tags |
| Side-effect | Send webhook, write audit log |

**Anti-pattern: kitchen-sink Lambdas.** A Lambda that does "submit job AND poll AND download AND persist" is hard to retry, hard to observe, and hard to evolve. Decompose.

## Step 3 — Composition Workflow (in Step Functions JSON)

Simplified excerpt from a production state machine:

```json
{
  "Comment": "Key-art assembly pipeline",
  "StartAt": "ValidateRequest",
  "States": {
    "ValidateRequest": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:validate-request",
      "Next": "LoadTemplate"
    },
    "LoadTemplate": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:load-template-manifest",
      "Next": "DetectSubject"
    },
    "DetectSubject": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:photoshop-detect-subject",
      "ResultPath": "$.detectedSubject",
      "Retry": [{
        "ErrorEquals": ["States.TaskFailed"],
        "IntervalSeconds": 2,
        "MaxAttempts": 3,
        "BackoffRate": 2.0
      }],
      "Next": "GenerateExpandedBackground"
    },
    "GenerateExpandedBackground": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke.waitForTaskToken",
      "Parameters": {
        "FunctionName": "firefly-expand-submit",
        "Payload": {
          "input.$": "$",
          "taskToken.$": "$$.Task.Token"
        }
      },
      "Next": "CompositePsd",
      "TimeoutSeconds": 300
    },
    "CompositePsd": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:photoshop-composite",
      "Next": "RenderAspectVariants"
    },
    "RenderAspectVariants": {
      "Type": "Map",
      "ItemsPath": "$.targetAspects",
      "Iterator": {
        "StartAt": "RenderOne",
        "States": {
          "RenderOne": {
            "Type": "Task",
            "Resource": "arn:aws:lambda:...:photoshop-render",
            "End": true
          }
        }
      },
      "Next": "Persist"
    },
    "Persist": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...:persist-and-notify",
      "End": true
    }
  }
}
```

Key Step Functions patterns:

| Pattern | Use |
|---|---|
| `waitForTaskToken` | Long-running async jobs (Firefly/Photoshop) — pause the state machine, resume on completion via SendTaskSuccess |
| `Map` | Fan-out parallel work (multi-aspect rendering) |
| `Retry` per state | Exponential backoff on transient failures |
| `Catch` per state | Route terminal failures to a DLQ-like state |

## Step 4 — The Async Submit/Poll Pattern in Step Functions

Firefly and Photoshop API operations are async. The standard pattern is `waitForTaskToken`:

1. Step Functions submits the job and passes `taskToken` to the Lambda
2. Lambda submits to Firefly/Photoshop, stores `{ jobId, taskToken }` in DynamoDB
3. Lambda returns immediately; Step Functions pauses
4. A separate poller Lambda (scheduled every 5s) reads pending jobs from DynamoDB
5. For each job: poll the Adobe statusUrl; on completion, call `SendTaskSuccess(taskToken, result)`
6. Step Functions resumes with the result

This pattern decouples submission from polling and avoids burning Step Functions cost on idle waits.

### Alternative: webhook callback (preferred when available)

If the endpoint supports webhooks (`notify.webhookUrl`), use those instead of polling. The pattern:

1. Step Functions submits the job with `notify.webhookUrl = "<api gateway URL>"`
2. Adobe calls the webhook on completion
3. API Gateway → Lambda → `SendTaskSuccess(taskToken, result)`
4. Step Functions resumes

Webhooks eliminate the polling Lambda entirely. Use them whenever the endpoint supports them.

## Step 5 — Multi-Aspect Rendering (Map State)

A single composition typically needs to render at multiple aspect ratios. The Step Functions `Map` state handles this:

```json
"RenderAspectVariants": {
  "Type": "Map",
  "ItemsPath": "$.targetAspects",
  "MaxConcurrency": 5,
  "Iterator": {
    "StartAt": "RenderOne",
    "States": {
      "RenderOne": {
        "Type": "Task",
        "Resource": "arn:aws:lambda:...:photoshop-render",
        "Parameters": {
          "compositionUrl.$": "$.compositionUrl",
          "aspect.$": "$$.Map.Item.Value"
        },
        "End": true
      }
    }
  }
}
```

`MaxConcurrency: 5` is the rate-limit guard — even though Step Functions can fan-out to thousands, Photoshop API rate limits cap actual throughput. Tune to your provisioned RPM.

## Step 6 — Observability

For a 15-20 function pipeline, structured logging is non-negotiable. Every function should emit:

| Field | Source |
|---|---|
| `traceId` | Step Functions execution ARN |
| `state` | Step Functions state name |
| `customer` | From input payload |
| `campaignId` | From input payload |
| `apiCall.endpoint` | Which Adobe endpoint was hit |
| `apiCall.duration_ms` | Wall-clock |
| `apiCall.status` | HTTP status |
| `apiCall.rateLimitRemaining` | From `X-RateLimit-Remaining` header |
| `outcome` | `succeeded` / `failed` / `retried` |

Dashboards to build:

- Pipeline success rate per template per customer
- p50 / p95 end-to-end duration
- Per-state failure rates (which step breaks most often)
- Adobe-side `X-RateLimit-Remaining` distribution

## Validate

A composition pipeline is production-ready when:

1. Each function is single-responsibility and idempotent
2. Async submissions use `waitForTaskToken` or webhook callbacks — no inline polling in Lambdas
3. Retry policies are explicit per state, not implicit
4. Multi-aspect rendering uses `Map` with `MaxConcurrency` matched to provisioned RPM
5. Every state machine execution emits structured logs with `traceId`
6. Failed runs land in a separate "review" S3 prefix with the full state-machine snapshot

## Troubleshooting & Edge Cases

- **State machine stuck "running" for hours:** `waitForTaskToken` never received `SendTaskSuccess`. The poller Lambda is broken, or the webhook was never reached. Add `TimeoutSeconds` per state and explicit failure transitions.
- **Half-rendered outputs in S3:** A function crashed mid-write. Use multipart upload + atomic rename pattern (write to `s3://bucket/_temp/job-id/` first, then rename to final path on success).
- **Concurrent jobs interfere:** Two jobs reading/writing the same key. Use `jobId` in every storage key.
- **Step Functions cost too high:** Standard tier bills per state transition. Squash trivial states (single-line transforms) into the preceding Task.
- **Templates drift between environments:** Manifest cache holds stale layer structure. Re-fetch on every template update; tag templates with content-hash.

## Chaining with Other Skills

- `photoshop-api-actions` — Each Task in the state machine is one of these calls
- `firefly-generate-image-v3-async` — Generates inputs to the composition stage
- `firefly-expand-fill` — Provides expanded backgrounds and patched regions
- `firefly-services-storage-refs` — Storage URL generation at each stage
- `firefly-services-rate-limits` — `MaxConcurrency` calibration

## References

- [AWS Step Functions — Wait for Callback with Task Token](https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html#connect-wait-token)
- [Photoshop API Documentation](https://developer.adobe.com/firefly-services/docs/photoshop/)
- [AWS Step Functions Map State](https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-map-state.html)
