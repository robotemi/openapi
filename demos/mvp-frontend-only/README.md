# mvp-frontend-only

Client-only demo of the [temi OpenAPI](https://openapi-docs.robotemi.com). No build step, no backend.

The Organization Access Token is typed in the browser and sent only as `x-api-key` to `api.robotemi.com` or `integration.dev.temi.cloud`. It is kept in memory for this page load only — not written to `sessionStorage` or `localStorage`.

## What it does

1. **Verify** — `GET /verify`
2. **List robots** — `GET /robots` when the token has `read:org:info`; otherwise serials from `/verify` if `robotScope` is `selected`
3. **Load permitted resources** — one click per robot; calls only the GET endpoints whose scope is on the token:
   - `GET /robots/{serial}` — `read:robot:status`
   - `GET /robots/{serial}/locations` — `read:robot:locations`
   - `GET /robots/{serial}/contacts` — `read:robot:contact`

Endpoint-to-scope mapping lives in `js/config.js`. JSON is rendered by `js/json-view.js` (same-origin, no third-party script).

## Local

Serve the directory over HTTP (ES modules do not load from `file://`):

```bash
cd demos/mvp-frontend-only
npx --yes serve .
```

Open the printed URL, paste an OAT, click **Verify**.

## Deploy (GitHub Pages)

This folder is a complete Pages app. Copy it to the root of any repo, or publish this subdirectory.

### Copy to your own repo

1. Copy the contents of this folder to the repository root.
2. Settings → Pages → **Deploy from a branch** → `main` (or `master`) / `/ (root)`.
3. Site URL: `https://<user>.github.io/<repo>/`

### Official publish from this monorepo

The workflow [`.github/workflows/pages-mvp-frontend.yml`](../../.github/workflows/pages-mvp-frontend.yml) uploads this directory as the Pages artifact.

One-time repo setup: Settings → Pages → **Source: GitHub Actions**. After the first run on `master`, the site is `https://robotemi.github.io/openapi/`.

## Token safety

- Do not commit tokens or `.env` files.
- Do not add analytics, error reporters, or other third-party beacons that could see the token.
- **Clear token** wipes the input and in-memory client for this page load.
