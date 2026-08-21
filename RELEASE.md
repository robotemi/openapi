# Release

How to publish the Temi Partner API docs site (Redoc on Vercel).

## Source of truth

| Artifact | Source |
|----------|--------|
| API contract / Redoc content | `temi-partner.openapi.yaml` |
| Static docs site | Built from this repository and hosted on Vercel |
| Postman Collection / scripts | Postman (derived from the YAML; not the formal contract) |

When changing the API or docs, **edit `temi-partner.openapi.yaml` first**, then publish the docs site. Sync Postman afterward if needed.

## URLs

| Environment | URL |
|-------------|-----|
| Production (custom domain) | https://openapi-docs.robotemi.com |
| Production (Vercel default) | https://temi-openapi-docs.vercel.app |

## Prerequisites

- Node.js (18+ recommended)
- [Vercel CLI](https://vercel.com/docs/cli) installed and authenticated
- This repository linked to the Vercel project that serves the docs site

## Local preview

```bash
npm install
npm run dev          # live Redoc preview of the YAML
# or
npm run build && npm run preview   # preview the same static output as production
```

## Production release

```bash
npm install
npm run build
vercel deploy --prod --yes
```

Vercel runs `npm run build` per `vercel.json` and publishes `public/` (including the Redoc `index.html`).

After deploy, open https://openapi-docs.robotemi.com and verify:

- [ ] Title and `info.version` are correct
- [ ] Changed paths / schemas / descriptions appear
- [ ] Logo, favicon, and Run in Postman button work
- [ ] Custom domain HTTPS is OK


## Postman (optional, after publish)

OpenAPI is the contract source. Postman may hold tests, pre/post scripts, and other items YAML cannot express.

1. Re-import / update the Public Collection from the latest `temi-partner.openapi.yaml`
2. Confirm the **Run in Postman** button still targets that Public Collection (in YAML `info.description`)
3. Maintain environments (e.g. `baseUrl`, Production) in Postman

Do not treat Postman-only field edits as formal API changes; write those back to the YAML first.

## Rollback

In the Vercel project dashboard, open a previous Production deployment and promote it to Production.

Or restore a known-good file state locally and run `vercel deploy --prod --yes` again.
