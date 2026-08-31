# temi OpenAPI scenario runner

Client-only browser demo for composing and running a small temi robot scenario.
It demonstrates the complete operator flow:

`verify → discover → validate → play → poll → stop`

The interface starts in Chinese and includes an English option. It supports the
Production (`api.robotemi.com`), Production-CN (`api.robotemi.cn`), and
Integration temi API environments, robot selection, MOVEMENT, SPEAK, and
START_CALL actions, final run confirmation, and status polling.

Choose the production environment that matches the organization's region.

## Run locally

Requires Node.js 20 or newer. From this directory:

```bash
npm ci
npm run dev
```

Open the URL printed by Vite. To verify the production build instead:

```bash
npm run build
npm run preview
```

The demo is served over HTTP; do not open the source or `dist/index.html` with
`file://`.

## Token safety

Enter your own Organization Access Token (OAT) in the page. The demo keeps it
only in page memory and sends it as `x-api-key` directly to the selected temi
API origin (`api.robotemi.com`, `api.robotemi.cn`, or
`integration.dev.temi.cloud`). Use the production host that matches the
organization's region. It does not use a backend, cookies, Web Storage,
analytics, or third-party runtime code. The token is cleared when the connection is reset,
the environment changes, a request returns 401, or the page closes.

Never commit an OAT, put one in a URL, or include one in logs, screenshots, or
support reports. Play and Stop can control a real PRO robot; use explicit
operator confirmation and a safe test area.

For the API contract and endpoint reference, see the
[temi OpenAPI documentation](https://openapi-docs.robotemi.com).
