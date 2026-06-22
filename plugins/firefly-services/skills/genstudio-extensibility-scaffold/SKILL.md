---
name: genstudio-extensibility-scaffold
description: Scaffold a custom extension for Adobe GenStudio for Performance Marketing using App Builder — project setup, brand-config bindings, content-fragment integration, the extension manifest, the events the extension subscribes to, and the deploy/test loop. Use whenever the user mentions "GenStudio", "GenStudio extension", "GS4PM", "App Builder", "Adobe Experience Cloud extension", "extend GenStudio", "custom panel in GenStudio", "GenStudio plugin", or wants to integrate a custom workflow into the GenStudio experience. Encodes the early-mover pattern for the GenStudio ecosystem, including the bindings that are documented but rarely shown end-to-end.
license: Apache-2.0
compatibility: Requires Adobe Developer Console access, App Builder entitlement, and `aio-cli` v10+. GenStudio for Performance Marketing is a separately-sold Adobe Experience Cloud product. Extensions deploy into the customer's App Builder runtime (`adobeio-runtime`) and surface inside the customer's GenStudio tenant.
allowed-tools: Bash(aio:*) Bash(npm:*) Bash(node:*) Bash(curl:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: genstudio
---

# GenStudio Extensibility Scaffold

The first-mover blueprint for extending Adobe GenStudio for Performance Marketing. GenStudio ships with a core experience; the App Builder extension layer is how a customer adapts it to their specific brand-governance, asset-routing, or campaign-orchestration workflow. The path exists, the pieces are documented in separate places, but no public reference stitches them together — until this skill.

This is a flag-plant: the extension pattern that customers will need over the next 18 months, written down before the rest of the ecosystem catches up.

## When to Use This Skill

Use this skill when:
- The customer has GenStudio for Performance Marketing and needs custom workflow integration
- The user mentions "App Builder", "aio runtime", "Adobe Experience Cloud extension", "GenStudio extension"
- A custom panel, action, or data binding is required inside GenStudio
- Brand-config from an external system (PIM, DAM, brand registry) needs to flow into GenStudio
- Generated assets need to route through a custom approval or syndication system

Do **NOT** use this skill when:
- The customer is on Firefly Services API without GenStudio — that is the direct-API path; see `firefly-services-bootstrap`
- The need is a one-time data export — use the Adobe Asset Hub APIs directly
- The customer does not have App Builder entitlement — confirm SKU first

## What "Extending GenStudio" Means

GenStudio for Performance Marketing is the Experience Cloud product that wraps Firefly Services + brand config + asset workflows + AEM Assets integration into a single marketer-facing UI. Extending it means adding capabilities that sit *inside* that UI without forking it.

Three extension shapes:

| Shape | What it does | Where it surfaces |
|---|---|---|
| **UI extension** | Custom panel, modal, or right-rail surface | Inside the GenStudio shell |
| **Action extension** | Custom action invoked from a context menu or button | GenStudio toolbar / asset menu |
| **Webhook extension** | Reacts to events (asset created, brand updated, campaign scheduled) | Background — no UI |

Most production extensions combine all three: a UI panel that surfaces external data, a custom action that triggers a workflow, and a webhook that reacts to GenStudio events.

## Step 1 — Prerequisites

Before scaffolding:

```bash
# Install Adobe I/O CLI
npm install -g @adobe/aio-cli

# Verify version (need 9.x+)
aio --version

# Login to Adobe IMS
aio login
```

Confirm App Builder entitlement on the customer's IMS org:

```bash
aio console org list
aio console org select <org-name>
aio console project list
```

If `aio console project list` returns no projects with the App Builder template, the org does not have App Builder entitlement. Confirm with the customer's Adobe account team before continuing.

## Step 2 — Scaffold the App Builder Project

```bash
# Create a working directory
mkdir genstudio-brand-extension && cd genstudio-brand-extension

# Bootstrap an App Builder project
aio app init genstudio-brand-extension

# When prompted:
#   - Organization: <customer's IMS org>
#   - Project: create new
#   - Workspace: Stage (start here; production added later)
#   - Component templates: select
#       [x] DX Experience Cloud SPA
#       [x] Action Generator
#       [x] Web Assets
```

The scaffold produces:

```
genstudio-brand-extension/
├── app.config.yaml              # Extension manifest — the most important file
├── package.json                 # Node deps; @adobe/aio-sdk pinned
├── src/
│   ├── dx-excshell-1/           # UI extension entry point
│   │   ├── web-src/             # React app
│   │   └── ext.config.yaml
│   └── actions/                 # Server-side actions (runtime)
│       ├── brand-sync/index.js
│       └── asset-route/index.js
├── test/                        # Unit + integration tests
└── e2e/                         # End-to-end against a real workspace
```

## Step 3 — The Extension Manifest (`app.config.yaml`)

This file is the source of truth for what the extension does and where it surfaces. The shape:

```yaml
extensions:
  dx/excshell/1:
    $include: src/dx-excshell-1/ext.config.yaml
    operations:
      view:
        - type: web
          impl: index.html
    actions:
      brand-sync:
        function: src/actions/brand-sync/index.js
        web: 'yes'
        runtime: nodejs:22
        inputs:
          LOG_LEVEL: debug
          BRAND_REGISTRY_URL: $BRAND_REGISTRY_URL
        annotations:
          require-adobe-auth: true
          final: true
      asset-route:
        function: src/actions/asset-route/index.js
        web: 'yes'
        runtime: nodejs:22
        annotations:
          require-adobe-auth: true
          final: true
    events:
      registrations:
        genstudio-brand-events:
          description: React to brand-config updates
          events_of_interest:
            - provider_metadata: dx_experience_events
              event_codes:
                - aem.assets.asset.metadata_updated
                - genstudio.brand.config.updated
          runtime_action: brand-sync
```

Key fields:

| Field | Purpose |
|---|---|
| `extensions['dx/excshell/1']` | Declares this is an Experience Shell UI extension |
| `operations.view` | The web entry point — the React app that mounts inside GenStudio |
| `actions` | Server-side functions deployed to Adobe I/O Runtime |
| `annotations.require-adobe-auth` | Forces every invocation through IMS auth (always `true`) |
| `events.registrations` | What Adobe events the extension subscribes to |

## Step 4 — Brand-Config Bindings

The most common reason to extend GenStudio is to bind external brand data into the experience. The pattern:

```
External brand registry (PIM / DAM / custom DB)
       ↓
GenStudio extension webhook (brand-sync action)
       ↓
GenStudio brand-config API (write the bindings)
       ↓
GenStudio UI surfaces the brand config when users generate
```

The brand-sync action runs server-side, reads from the external registry, and writes the brand parameters that GenStudio will pass to Firefly on generation.

Action skeleton:

```js
// src/actions/brand-sync/index.js
const { Core } = require('@adobe/aio-sdk');
const fetch = require('node-fetch');

async function main(params) {
  const logger = Core.Logger('brand-sync', { level: params.LOG_LEVEL });
  try {
    const brandRegistryUrl = params.BRAND_REGISTRY_URL;
    const customerId = params.customerId;

    // 1. Pull latest brand config from external registry
    const externalConfig = await fetch(
      `${brandRegistryUrl}/customers/${customerId}/brand`,
      { headers: { 'Authorization': `Bearer ${params.REGISTRY_TOKEN}` } }
    ).then(r => r.json());

    // 2. Transform into GenStudio brand-config shape
    const genstudioBinding = {
      brandName: externalConfig.name,
      primaryColors: externalConfig.palette.primary,
      bannedTerms: externalConfig.denyList,
      approvedCustomModelIds: externalConfig.firefly.customModels,
      toneGuidelines: externalConfig.voice.guidelines,
    };

    // 3. Push to GenStudio
    const result = await fetch(
      `${params.GENSTUDIO_API_BASE}/brands/${customerId}/config`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${params.__ow_headers.authorization}`,
          'Content-Type': 'application/json',
          'x-api-key': params.GENSTUDIO_CLIENT_ID,
        },
        body: JSON.stringify(genstudioBinding),
      }
    );

    if (!result.ok) throw new Error(`GenStudio bind failed: ${result.status}`);

    logger.info('Brand config synced', { customerId });
    return { statusCode: 200, body: { synced: true, customerId } };
  } catch (err) {
    logger.error('Brand sync failed', err);
    return { statusCode: 500, body: { error: err.message } };
  }
}

exports.main = main;
```

Trigger this action on a webhook from the external registry, or on a schedule (`aio app deploy` with a cron annotation), or via the events registration in `app.config.yaml`.

## Step 5 — UI Extension Surface

The UI extension is a React app that mounts inside the GenStudio shell. The Experience Shell SDK provides the integration:

```jsx
// src/dx-excshell-1/web-src/src/App.jsx
import React, { useEffect, useState } from 'react';
import { Provider, defaultTheme } from '@adobe/react-spectrum';
import { register } from '@adobe/uix-guest';

export default function App() {
  const [guestConnection, setGuestConnection] = useState(null);
  const [campaignContext, setCampaignContext] = useState(null);

  useEffect(() => {
    (async () => {
      const conn = await register({
        id: 'genstudio-brand-extension',
        methods: {
          brandPanel: {
            getCustomBindings: async () => {
              const context = await conn.host.api.campaign.getCurrent();
              return loadBindingsForCampaign(context.id);
            },
          },
        },
      });
      setGuestConnection(conn);

      const ctx = await conn.host.api.campaign.getCurrent();
      setCampaignContext(ctx);
    })();
  }, []);

  return (
    <Provider theme={defaultTheme}>
      {campaignContext && (
        <BrandBindingsPanel campaign={campaignContext} connection={guestConnection} />
      )}
    </Provider>
  );
}
```

Key UIX patterns:

| Pattern | Purpose |
|---|---|
| `@adobe/uix-guest` `register()` | Connect to the GenStudio host; expose extension methods |
| `conn.host.api.*` | Call back into GenStudio (get current campaign, list assets, etc.) |
| `@adobe/react-spectrum` | Required design system — extensions must use Spectrum for visual coherence |

The Experience Shell host calls the extension's exposed methods when the user interacts with the extension's surface (panel open, action click). The extension can call back into the host to read campaign state, brand config, or asset metadata.

## Step 6 — Local Development Loop

```bash
# Run locally, proxied into the staging workspace
aio app run

# This starts:
#   - Webpack dev server for the UI (https://localhost:9080)
#   - Local emulation of actions (via @adobe/aio-app-runtime)
#   - A registration of the local URL with the staging workspace
```

To test inside GenStudio:

1. Open the customer's staging GenStudio tenant
2. Navigate to a campaign that triggers the extension surface
3. The extension loads from `https://localhost:9080` (via the IMS-authed iframe)
4. Edit, save, hot-reload

Common gotcha: the staging workspace has a CSP that forbids `localhost` by default. Add a development override in the workspace settings, or deploy to a dev-runtime URL instead.

## Step 7 — Deployment

```bash
# Deploy to the staging workspace
aio app deploy

# Once verified, promote to production
aio app use --workspace Production
aio app deploy
```

Deployed extensions surface immediately in GenStudio for users with permissions in that workspace. There is no app-store review for first-party customer extensions — only Adobe Exchange listings require review.

| Concern | Pattern |
|---|---|
| Environment separation | One workspace per env (Stage, Prod); never share |
| Secrets | `$VAR` references in `app.config.yaml`; values stored in `.env` (gitignored) and synced via `aio app deploy --env` |
| Versioning | Bump `package.json` version on each deploy; tag git for traceability |
| Rollback | `aio app deploy --version <previous>` to roll back to a prior tagged version |

## Step 8 — Subscribing to GenStudio Events

The events registration in `app.config.yaml` subscribes the extension to events fired by GenStudio and AEM Assets. Common events:

| Event code | When it fires |
|---|---|
| `genstudio.brand.config.updated` | Brand config changed in the UI or via API |
| `genstudio.campaign.scheduled` | A campaign was scheduled to publish |
| `aem.assets.asset.created` | An asset was uploaded to AEM Assets |
| `aem.assets.asset.metadata_updated` | Asset metadata changed (tags, status, custom fields) |
| `genstudio.generation.completed` | A Firefly generation triggered from GenStudio finished |

Each event payload includes the IMS user context, the campaign / asset IDs, and timestamps. The runtime action receives the event, processes it, and (typically) writes back to the brand registry or asset store.

## Validate

The extension is production-ready when:

1. `app.config.yaml` declares all UI surfaces, actions, and event registrations explicitly
2. All actions have `require-adobe-auth: true` annotation
3. Secrets are referenced via `$VAR`, never inline
4. The Spectrum design system is used throughout the UI
5. The Stage workspace is the development target; Production deploys are tagged and rollback-able
6. Event subscriptions are documented with what each handler does
7. Local dev loop works without manual CSP overrides on Stage (use a dev-runtime URL)
8. Brand-config bindings round-trip: external registry → action → GenStudio → reflected in generation

## Troubleshooting & Edge Cases

- **Extension UI loads but methods return undefined:** The `register()` call did not complete before the host called the method. Await `register()` fully, then expose the connection via state.
- **`aio app deploy` succeeds but the extension does not appear:** Workspace permissions. The current user must have GenStudio admin permissions in that workspace to see new extensions. Check `aio console workspace list-users`.
- **Action returns 401 inside GenStudio:** `require-adobe-auth` is true but the request is missing the IMS token. Confirm the UI is calling the action via the UIX guest API (which forwards auth), not via raw `fetch`.
- **Webpack dev server CSP errors:** Stage workspace blocks `localhost`. Either add a dev CSP override, or deploy to a dev-runtime URL and use that as the source.
- **Event handler fires for every event instead of filtered ones:** `event_codes` array is matched as a prefix list. Be specific — `aem.assets.asset.created`, not `aem.assets.*`.
- **Spectrum theme looks wrong inside the GenStudio shell:** The host overrides theme in some surfaces. Pin to `defaultTheme` and accept the host scale; do not impose dark/light overrides.
- **Brand-sync action runs but bindings do not appear in GenStudio:** API call succeeded but the customer's GenStudio tenant caches brand config for ~5 minutes. Wait or invalidate via the admin API.

## Chaining with Other Skills

- `firefly-services-bootstrap` — App Builder credentials follow the same console + OAuth pattern
- `firefly-services-auth` — The token cache pattern applies to extension actions calling Firefly directly
- `firefly-brand-guardrails` — The brand-config bindings populated here are what guardrails read
- `firefly-batch-pipeline` — When the extension fires asset routing to a downstream pipeline
- `firefly-custom-models` — The `approvedCustomModelIds` field in brand bindings points here

## References

- [Adobe App Builder Documentation](https://developer.adobe.com/app-builder/docs/overview/)
- [Adobe I/O Runtime — Actions](https://developer.adobe.com/runtime/docs/guides/reference/actions/)
- [Adobe UIX — Guest SDK](https://github.com/adobe/uix)
- [Adobe React Spectrum](https://react-spectrum.adobe.com/)
- [Adobe I/O Events](https://developer.adobe.com/events/docs/)
- [GenStudio for Performance Marketing](https://business.adobe.com/products/genstudio/performance-marketing.html)
