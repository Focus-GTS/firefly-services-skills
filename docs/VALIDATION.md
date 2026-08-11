# Skill validation record

**Last full pass: 2026-08-10 through 2026-08-11.** Method: three stages — (1) static validation of every technical claim in all 19 skills against the OpenAPI specs bundled in the official Adobe SDKs (`@adobe/firefly-apis`, `@adobe/photoshop-apis`, `@adobe/lightroom-apis` v2.0.1) and the live-validated tool implementations of [`@focusgts/firefly-services-mcp`](https://github.com/Focus-GTS/firefly-services-mcp); (2) repair of the 68 drift items found — 60 fixes applied, each re-verified against its cited source before editing; the remaining 8 were either refuted on re-verification or deferred to live confirmation in stage 3; (3) **live proof against the production Adobe Firefly Services API** — 60+ serialized calls exercising the skills' claims end-to-end, including deliberate error probes. Where live behavior contradicted the specs, the live behavior won and the skills were corrected again.

## Verdicts

| Skill | Status | Live evidence highlights |
|---|---|---|
| `firefly-services-bootstrap` | ✅ Proven | Scope behaviors live-tested (incl. IMS accepting unrecognized scope names rather than rejecting them); `aio` CLI command surface verified against the real CLI; token round-trip confirmed |
| `firefly-services-auth` | ✅ Proven | SDK `ServerToServerTokenProvider` executed three ways — throws without `autoRefresh`, works with it, returns the cached token after forced expiry (all as documented); `invalid_client`, HEAD→405 confirmed |
| `firefly-services-troubleshoot` | ✅ Proven | Full error map captured live: 401 `401013` (bad token), 403 `403000` (missing API key), 400 `bad_request` + `validation_errors[]` (schema), 422 `prompt_unsafe` / `validation_error` (safety/reference); status-URL pattern confirmed |
| `firefly-services-storage-refs` | ✅ Proven | generate-similar old shape 400-rejected / fixed shape 200; a GCS pre-signed URL rejected by the Firefly endpoint (422, "could not be reached"), consistent with GCS not being among the documented supported hosts; upload endpoint round-trip; PS/LR `storage: "external"` asymmetry consistent with June MCP validation |
| `firefly-services-rate-limits` | ✅ Proven | 8-call burst: zero 429s, no rate-limit headers observed — limits were not surfaced via headers at this volume, consistent with org-specific enforcement; guidance updated to 429-reactive backoff |
| `firefly-generate-image-v3-async` | ✅ Proven | `generate-async` 202 with jobId/statusUrl/cancelUrl, polled to `succeeded`; seeds-must-equal-numVariations, size, and strength rules captured with exact live error bodies; valid-size list captured verbatim |
| `firefly-expand-fill` | ✅ Proven | `expand-async` and `fill-async` exist (202); wrong mask shape 422-rejected, fixed shape correct; placement alignment+inset accepted |
| `firefly-generate-similar` | ✅ Proven | Fixed request shape 200 (default output 2048×2048 from a 1024 source); UUID validation on uploadId captured |
| `firefly-video-model` | ✅ Proven | Image-to-video with `image.conditions[]` + `x-model-version: video1_standard` submitted, polled, **succeeded with video URL**; size flexibility live-tested (1080×1080 accepted and completed) |
| `firefly-cost-optimization` | ✅ Proven (claim corrected) | Seed determinism refuted by live hash comparison — skill now teaches archive-the-artifact; immediate output-URL fetch confirmed |
| `firefly-skills-catalog` | ✅ Validated (static + its own CI) | Meta-skill; no API claims. Regenerates via scheduled GitHub Action |
| `firefly-project-planner` | ✅ Validated (static) | Meta-skill; no API claims; all cross-references verified |
| `photoshop-api-actions` | ✅ Proven | Fixture suite run 2026-08-11: `.atn` playback with and without `actionName` both `succeeded`; text **content** replacement via bare `text.content` (no `characterStyles`) `succeeded`; `characterStyles` properties rejected by the current schema — `Additional property fontName is not allowed` and `Additional property fontSize is not allowed` both captured (skill corrected: character-level styling belongs in the template PSD); `quality` range violation captured; mixed smart-object+text rejected at submission (400 `input is required`). Boundary: duplicate-layer-name behavior not exercised (no fixture) |
| `photoshop-api-composition` | ✅ Proven | Three-stage chain executed end-to-end over GCS signed URLs: document manifest (layer enumeration confirmed) → smart-object replace → Lightroom auto-tone on the rendered output — all `succeeded`. V1 `sensei/mask` probe returned 502 — endpoint no longer serving (consistent with its documented supersession by the V2 masking endpoints); async `notify` accepted at submission |
| `lightroom-api-batch` | ✅ Proven | Auto-tone with dual JPEG+DNG outputs in one job — both `succeeded` (skill corrected: multi-output supported); `applyPreset` with hand-authored XMP `succeeded`; endpoint input-shape asymmetry documented; TIFF-output rejection confirmed. Boundary: raw-file (.CR2/.NEF) ingestion not exercised (no raw fixture) |
| `firefly-custom-models` | ⏸ Held (entitlement) | `GET /v3/custom-models` confirmed live (skill corrected); generation proof requires a trained custom model, which is not present in the validation environment |
| `firefly-brand-guardrails` | ⏸ Held (entitlement) | Layer-1 proof depends on custom-model access |
| `firefly-batch-pipeline` | ⏸ Held (infrastructure) | Architecture pattern; full proof requires deploying the AWS reference stack |
| `genstudio-extensibility-scaffold` | ⏸ Held (environment) | Requires an App Builder environment |

**Marketplace submission policy:** only ✅ skills are submitted. ⏸ skills stay in this repository until they can be fully proven.

Raw evidence (request/response logs with status codes, bodies, and headers) is retained internally; identifiers and org-specific values are not published here.
