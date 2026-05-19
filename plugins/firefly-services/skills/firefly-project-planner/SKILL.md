---
name: firefly-project-planner
description: Interactive project-planning assistant for Adobe Firefly Services engagements. Use this skill when the user is scoping a new Firefly Services project, doing FDE engagement intake, planning a campaign-automation rollout, mapping skills to a customer's use case, deciding which capabilities a project needs and in what order, or asking "where do I start" / "how should I plan this" / "what skills do I need" / "scope a Firefly project" / "plan a Firefly engagement" / "Firefly project plan" / "design a Firefly pipeline" / "Firefly engagement intake". The planner asks a small set of clarifying questions about the use case, industry, volume, and deployment target, then returns a structured project plan that points to specific skills in this repository in the right reading order. It is a higher-level entry point above the firefly-skills-catalog skill — use the catalog for raw browsing; use this planner for guided scoping.
license: Apache-2.0
compatibility: Lives alongside the firefly-skills-catalog meta-skill. Both reference the planning-track definitions in config/planning-tracks.yml and the skills in plugins/firefly-services/skills/. Refresh the planner only when the planning-tracks change.
metadata:
  version: "1.0.0"
  category: meta
  visibility: public
---

# Firefly Project Planner

The interactive entry point for anyone planning a Firefly Services engagement. If a user knows roughly what they want to build but doesn't know which skills to read in which order, this skill walks them through 4 clarifying questions and outputs a structured project plan with specific skill recommendations.

This skill is paired with `firefly-skills-catalog` — the catalog is the *reference*, the planner is the *guided experience*.

## When to use this skill

Use this skill when:
- The user is scoping a new Firefly Services project and wants a structured starting plan
- An FDE consultant is doing engagement intake at a new customer and needs a 90-day roadmap
- A customer engineering lead is asking "where do we start" with Firefly Services
- The user wants a curated subset of skills (not the full catalog) relevant to their specific use case
- The user mentions "scope", "plan", "design", "roadmap", "engagement intake", "where do I start", or "what should I read first"

Do **NOT** use this skill when:
- The user already knows the specific skill they need — invoke it directly
- The user wants to browse every skill — use `firefly-skills-catalog`
- The user is in the middle of an active task and needs immediate operational guidance — use the specific skill that matches the task

## Step 1 — Ask the four scoping questions

Before recommending anything, ask the user these four questions. **Do not skip them.** Specificity in the answers determines the quality of the plan.

### Q1 — Primary use case

> *"What are you trying to build? Pick the closest match:*
>
> 1. *Generative campaign assembly* — produce many marketing assets from prompts + templates
> 2. *Asset variation at scale* — produce many derivatives of approved hero assets
> 3. *Brand-aligned asset generation* — generate assets that match a specific brand style
> 4. *Photo / image processing pipeline* — process customer-supplied images through Firefly + Photoshop + Lightroom
> 5. *Video generation* — short generative video clips
> 6. *GenStudio extension* — extend GenStudio for Performance Marketing with custom capabilities
> 7. *Other / mixed* — describe in one sentence"*

### Q2 — Volume / scale

> *"What's the expected production volume per month, once running?*
>
> - Light (<1,000 API calls/month)
> - Medium (1,000 – 100,000)
> - Heavy (100K – 10M)
> - Very heavy (>10M)
> - Unknown / still scoping"*

### Q3 — Audience / industry

> *"Which industry / customer type, and which best describes the team?*
>
> - Industry: media & entertainment / financial services / retail & ecommerce / healthcare / consumer products / technology / other
> - Team maturity: net-new to Firefly Services / has experimented but no production / has production but wants to scale / has production at scale already"*

### Q4 — Deployment target

> *"Where will this run?*
>
> - Customer's existing cloud (AWS / Azure / GCP) — which one?
> - A SaaS the customer already operates
> - Adobe Experience Manager / Adobe Experience Platform
> - Standalone Adobe App Builder project
> - Other / unsure"*

## Step 2 — Match answers to planning tracks

The planning tracks are defined in `config/planning-tracks.yml` in this repo. Each track maps a real intent to an ordered sequence of skills. After receiving the user's answers to Step 1, match to one or more tracks:

| User's primary use case (Q1) | Best-fit track(s) |
|---|---|
| Generative campaign assembly | `build-campaign-assembly-pipeline`, `brand-compliance-stack` |
| Asset variation at scale | `variation-and-expansion-workflow`, `scale-to-batch-volume` |
| Brand-aligned asset generation | `train-and-deploy-custom-model`, `brand-compliance-stack` |
| Photo / image processing pipeline | `photoshop-composition-workflow`, `lightroom-batch-normalize` |
| Video generation | `video-generation-workflow` |
| GenStudio extension | `genstudio-extensibility` |
| Other / mixed | Multiple — read the user's description carefully and pick 2-3 tracks |

Then layer additional tracks based on Q2 (volume):

| Volume (Q2) | Add these tracks |
|---|---|
| Heavy or Very heavy | Always add `scale-to-batch-volume`, `cost-and-finops`, `troubleshoot-production-issue` |
| Medium | Add `troubleshoot-production-issue` |
| Light | Add `from-zero-bootstrap` if team is new |

And by Q3 (team maturity):

| Maturity (Q3) | Add these tracks |
|---|---|
| Net-new to Firefly Services | Always add `from-zero-bootstrap`, `jwt-migration` (if legacy code) |
| Has production but wants to scale | Add `scale-to-batch-volume`, `cost-and-finops` |
| Has production at scale | Skip `from-zero-bootstrap`; assume current platform knowledge |

## Step 3 — Output the project plan

Render the plan as a structured response with three sections.

### Section 1 — Recommended skills, in reading order

A consolidated, deduplicated reading list combining all matched tracks. Group by phase:

- **Phase 1 — Foundation** (first 1-2 weeks): bootstrapping, auth, storage refs, first working call
- **Phase 2 — Build** (weeks 2-6): the use-case-specific skills (generation, composition, processing)
- **Phase 3 — Scale** (weeks 6-12+): rate limits, batch pipeline, cost optimization, brand guardrails, troubleshooting

### Section 2 — Architecture decisions to make in the first sprint

Three to five concrete decisions the team should make in week 1, based on the user's answers:

- **Auth pattern**: OAuth Server-to-Server (always — JWT is dead)
- **Credential isolation**: per-customer vs per-environment
- **Storage backend**: where source assets live, where outputs go (S3 / Azure Blob / GCS / Dropbox)
- **Rate-limit posture**: default quota vs request raise vs queue-fronted architecture
- **Brand-guardrail layer**: custom models, content filtering, human review, asset tagging — at what stage

Each decision points to the specific skill that covers it in detail.

### Section 3 — Open questions for the customer

Things the team needs to verify with the customer before architecture is finalized:

- IMS org has Firefly Services entitlement provisioned (often a separate SKU from base Adobe products)
- Production rate-limit allowance negotiated with Adobe account team
- Storage bucket and pre-signed URL conventions agreed with customer InfoSec
- Custom model training data ownership and licensing terms
- Brand guidelines / approval workflow integration touchpoints

## Step 4 — Save the plan

If the user is doing engagement intake, offer to save the plan as a markdown document in the customer's workspace. The output of this skill is meant to be a living document — the team revisits it as the project progresses.

## Validate

A project plan is well-formed when:

1. The recommended skill list is **deduplicated** (no skill listed twice across tracks)
2. The skills are **ordered by phase** (foundation → build → scale)
3. Every recommendation **traces back to a specific user answer** (don't recommend `firefly-video-model` if Q1 wasn't video)
4. The architecture decisions are **concrete enough to act on this week** (no vague "consider...")
5. The open questions are **customer-actionable** (the customer can answer them; the FDE consultant shouldn't have to)

## Chaining with other skills

After the planner runs, the recommended next steps are typically:

- `firefly-skills-catalog` — for the user to browse the full catalog if they want to go beyond the plan
- `firefly-services-bootstrap` — almost always the first action item for a new project
- The specific use-case skill identified by Q1

## References

- `config/planning-tracks.yml` — the planning-track definitions this skill uses
- `firefly-skills-catalog` — full machine-generated index of every skill
- `scripts/catalog/build-catalog.ts` — the generator that keeps the catalog and planner in sync with the rest of the repo
