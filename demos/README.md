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

| Demo | Mode | Deploy |
|------|------|--------|
| [mvp-frontend-only](mvp-frontend-only/) | Client-only (browser → temi API) | GitHub Pages. Official: enable Pages **Source: GitHub Actions**, then `https://robotemi.github.io/openapi/` |

## Contributing

1. Add a self-contained directory under `demos/`.
2. Include a short `README.md` with purpose, setup, and how the OAT is provided.
3. Keep dependencies and scope small enough that someone else can run the demo without a private environment.

Questions about the API itself belong in the [API reference](https://openapi-docs.robotemi.com).
