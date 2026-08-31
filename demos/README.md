# Demos

This folder collects **first-party and third-party demos** of the [temi OpenAPI](../README.md).

Contributions are welcome. A demo can live here if it helps others learn, try, or extend the API — and if it never leaks an Organization Access Token (OAT).

## Token safety

An OAT is a secret. Demos in this repository must not collect, store, or transmit anyone else’s token.

Acceptable patterns include:

- **Client-only apps.** The token is entered by the user in the browser and is sent only to temi APIs. It must not leave the browser for any other destination (no analytics, logging, or third-party backends).
- **User-deployed serverless.** A small service the user can deploy themselves, with the token supplied at runtime as a parameter or environment variable. Do not bake tokens into source, config, or hosted defaults.

Do not:

- Commit real tokens, sample tokens that look real, or files that might contain them (`.env`, credentials, screenshots of dashboards).
- Ship a hosted backend that accepts an OAT on behalf of users.
- Log request headers or otherwise persist tokens.

Each demo should document how the caller supplies their own token.

## Catalog

Official static host: [https://robotemi.github.io/openapi/](https://robotemi.github.io/openapi/). A folder is published when it has no `vercel.json` and either:

- **No build:** root `index.html` and no `package.json` — the **whole folder** is copied (HTML, JS, README, assets).
- **npm build:** `package.json` plus `package-lock.json` (or `npm-shrinkwrap.json`). CI runs `rm -rf dist && npm ci --no-audit --no-fund && npm run build` and publishes only `dist/` (must contain `dist/index.html`). A source `index.html` is only needed if the bundler uses it (Vite does).

| Demo | Mode | Deploy |
|------|------|--------|
| [mvp-frontend-only](mvp-frontend-only/) | Client-only (browser → temi API) | [https://robotemi.github.io/openapi/mvp-frontend-only/](https://robotemi.github.io/openapi/mvp-frontend-only/) |

## Contributing

1. Add a self-contained directory under `demos/`.
2. Include a short `README.md` with purpose, setup, and how the OAT is provided.
3. Keep dependencies and scope small enough that someone else can run the demo without a private environment.
4. Client-only static demos (no build): add `index.html` at the folder root, omit `package.json` and `vercel.json`, and use a URL-safe folder name (`A–Z a–z 0–9 . _ -`). Merge to `master` and the Pages workflow copies the **entire folder** to `https://robotemi.github.io/openapi/<name>/`.
5. Client-only demos that use Vite/TypeScript: commit `package.json` **and** a lockfile (`package-lock.json` or `npm-shrinkwrap.json`), with `npm run build` writing `dist/index.html`. Set Vite `base` to `./`. Omit `vercel.json`. Do not commit `node_modules/` or `dist/`. Pages runs `rm -rf dist && npm ci --no-audit --no-fund && npm run build` and publishes `dist/`.
6. Serverless demos: include `vercel.json`. Deploy as a separate Vercel project.
7. Pull-request assemble (build, no publish) runs only for branches on `robotemi/openapi`. Fork PRs are not built automatically; a maintainer can check out the branch and run `bash demos/assemble-pages.sh _site` locally.

Questions about the API itself belong in the [API reference](https://openapi-docs.robotemi.com).
