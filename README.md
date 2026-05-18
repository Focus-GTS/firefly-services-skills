# Firefly Services Skills

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Production-grade Claude Code skills for Adobe Firefly Services, distilled from real enterprise FDE engagements.

Built by [FocusGTS](https://focusgts.com) — a forward-deployed engineering partner working on Adobe's Firefly platform. Not affiliated with or endorsed by Adobe.

---

## What's in here

This repository hosts the `firefly-services` plugin — 13 skills that cover the FDE-grade lifecycle for Adobe Firefly Services:

### Foundation skills

| Skill | Purpose |
|---|---|
| [`firefly-services-bootstrap`](plugins/firefly-services/skills/firefly-services-bootstrap/SKILL.md) | Wire up a new Firefly Services project from zero — console, credentials, SDK, first call |
| [`firefly-services-auth`](plugins/firefly-services/skills/firefly-services-auth/SKILL.md) | OAuth Server-to-Server tokens, refresh-before-expiry, JWT-to-OAuth migration |
| [`firefly-services-troubleshoot`](plugins/firefly-services/skills/firefly-services-troubleshoot/SKILL.md) | Triage tree for 401 / 403 / 429 / 4xx / 5xx and 30+ specific failure modes |
| [`firefly-services-rate-limits`](plugins/firefly-services/skills/firefly-services-rate-limits/SKILL.md) | Token-bucket limiting, exponential backoff, queue-fronted architecture for batch workloads |
| [`firefly-services-storage-refs`](plugins/firefly-services/skills/firefly-services-storage-refs/SKILL.md) | Upload endpoint vs pre-signed URLs, mask generation, output destinations, expiry gotchas |

### Generative skills

| Skill | Purpose |
|---|---|
| [`firefly-generate-image-v3-async`](plugins/firefly-services/skills/firefly-generate-image-v3-async/SKILL.md) | V3 async generation — submit, poll, webhook callbacks, style + structure references |
| [`firefly-custom-models`](plugins/firefly-services/skills/firefly-custom-models/SKILL.md) | Train, manage, and invoke custom models for brand-aligned generation |
| [`firefly-expand-fill`](plugins/firefly-services/skills/firefly-expand-fill/SKILL.md) | Generative Expand (canvas extension) and Generative Fill (region replacement) |
| [`firefly-generate-similar`](plugins/firefly-services/skills/firefly-generate-similar/SKILL.md) | Variation generation from a source — the campaign-multiplication workflow |
| [`firefly-video-model`](plugins/firefly-services/skills/firefly-video-model/SKILL.md) | Text-to-video and image-to-video with the commercially-safe Firefly Video Model |

### Photoshop & Lightroom skills

| Skill | Purpose |
|---|---|
| [`photoshop-api-actions`](plugins/firefly-services/skills/photoshop-api-actions/SKILL.md) | Smart-object replacement, action playback, text-layer editing, document manifests |
| [`photoshop-api-composition`](plugins/firefly-services/skills/photoshop-api-composition/SKILL.md) | Multi-stage orchestration — the 15-20 function state-machine pattern |
| [`lightroom-api-batch`](plugins/firefly-services/skills/lightroom-api-batch/SKILL.md) | Preset application, auto-tone, batch normalization across image sets |

---

## Installation

### Claude Code (plugin marketplace)

```bash
/plugin marketplace add focusgts/firefly-services-skills
/plugin install firefly-services@firefly-services-skills
```

### Manual install

Clone this repo and copy the plugin into your local Claude Code skills directory:

```bash
git clone https://github.com/focusgts/firefly-services-skills.git
cp -R firefly-services-skills/plugins/firefly-services ~/.claude/skills/
```

---

## How to use

Each skill is designed to be triggered by natural language. Examples:

| You say | Skill that fires |
|---|---|
| "Set up Firefly Services for our new project" | `firefly-services-bootstrap` |
| "I'm getting a 401 from the Firefly API" | `firefly-services-troubleshoot` |
| "Help me build a batch image generation pipeline" | `firefly-services-rate-limits` + `firefly-generate-image-v3-async` |
| "Train a custom model for our brand iconography" | `firefly-custom-models` |
| "How do I extend an image's canvas?" | `firefly-expand-fill` |
| "Replace this PSD's smart object with a generated image" | `photoshop-api-actions` |
| "Apply this Lightroom preset to 200 photos" | `lightroom-api-batch` |

Triggers and failure modes are encoded in each skill's `description` frontmatter. Claude Code uses these descriptions to route to the right skill automatically.

---

## What this is not

These skills are **playbooks**, not an SDK. They tell Claude *how to think about* a Firefly Services task — when to use which endpoint, what gotchas to avoid, what the production patterns look like.

For the actual SDK, install:

```bash
npm install @adobe/firefly-apis @adobe/photoshop-apis @adobe/lightroom-apis @adobe/firefly-services-common-apis
```

The skills here reference the SDK throughout. They're designed to work together.

---

## Provenance

Every skill in this repository is derived from real production work on Adobe Firefly Services. Specifically:

- **Auth, rate-limit, and storage patterns** were hardened during high-volume generative campaign engagements
- **Custom model patterns** were validated against enterprise iconography and brand-asset workflows
- **PSD composition orchestration** is the architecture shape used in production for multi-stage template-driven asset pipelines
- **Lightroom batch patterns** were validated against enterprise photography workflows that produce hundreds of normalized assets per day

These are not theoretical. They're the patterns that survived contact with production.

---

## Contributing

Issues and PRs welcome. Please open an issue before submitting a substantive PR so we can align on direction.

- Bug reports: please include the exact endpoint, error response, and what you expected
- New skills: file an issue with the proposed `name`, `description`, and the gap it fills
- Improvements: please reference the line(s) in the affected SKILL.md

---

## License

Apache License 2.0. See [LICENSE](LICENSE).

Copyright © 2026 FocusGTS.

---

## Acknowledgements

- The 50+ FocusGTS forward-deployed engineers whose tacit knowledge made these skills possible
- Adobe's Firefly Services product, engineering, and FDE program teams
- Anthropic for the Claude Code platform that hosts these skills
