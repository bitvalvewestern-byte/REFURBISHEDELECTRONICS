# Hosting notes (Vercel frontend + separate backend)

## Why the plain Vercel deploy showed `404 NOT_FOUND`

The Vercel project for this repo was created without a build configuration and
without a framework preset, so Vercel treated the **repository root** as a static
site. That root contains no `index.html` (the pages live in `frontend/`), so:

| URL | Result | Why |
| --- | --- | --- |
| `/` | 404 `NOT_FOUND` | no `index.html` at the repo root |
| `/frontend/index.html` | 200 | served, but its assets 404 |
| `/css/styles.css`, `/js/index.js` | 404 | the pages use **root-absolute** paths, so they only resolve when the frontend is the web root |
| `/api/*` | 404 | Vercel static hosting cannot run the Express backend |

Two independent problems: (1) the frontend was not being served as the web root,
and (2) there is no backend on Vercel.

## Fix applied: `vercel.json`

`vercel.json` copies `frontend/` into `dist/` at build time and publishes `dist`
as the output directory, so the frontend becomes the web root. Because every page
references assets with root-absolute paths (`/css/styles.css`, `/js/index.js`,
`/products.html`), serving the frontend at the root makes all of them resolve
without touching a single page. `cleanUrls` gives `/products`, `/cart`,
`/checkout`, `/admin` instead of the `.html` variants; `frontend/404.html` is used
for not-found responses automatically.

After this change `https://<project>.vercel.app/` serves the storefront shell.

## Remaining requirement: the API

The frontend calls `/api/...` on its own origin (`api.js`, `admin.js`). Vercel
static hosting cannot run `backend/` (long-running Express process, `SQLite` file
storage, in-memory rate limiting). The backend must be hosted on a persistent
Node.js host, e.g. Render, Railway, Fly.io, or a VPS.

Recommended wiring - keep the browser on **one origin** and let Vercel proxy the
API to the backend. This matters for security, not just convenience: the admin
session cookie is `SameSite=Strict`, so it is never sent on cross-site requests.
Pointing the frontend directly at a different API domain would break admin login.

Add to `vercel.json` (replace the host with your backend's URL):

```json
"rewrites": [
  { "source": "/api/(.*)", "destination": "https://your-backend.example.com/api/$1" }
]
```

Backend environment for this setup:

```ini
NODE_ENV=production
PUBLIC_BASE_URL=https://<project>.vercel.app
CORS_ORIGINS=https://<project>.vercel.app
TRUST_PROXY=true            # rate limiting must key on the real client IP, not Vercel's proxy
COOKIE_SECURE=true
ADMIN_PASSWORD_HASH=<scrypt hash from: npm run hash-password>
```

`TRUST_PROXY=true` is required behind the Vercel proxy, otherwise every visitor
shares one rate-limit bucket and one abusive client can lock out everyone.
`CORS_ORIGINS`/`PUBLIC_BASE_URL` must list the Vercel domain or the backend's
same-origin check returns `403 CSRF_ORIGIN_MISMATCH` on state-changing requests.

### Alternative

Host the backend and the frontend together on a normal Node host (Render, Fly,
Railway, VPS) and run `node backend/server.js` with `frontend/` served from the
same process. Then no proxy and no CORS configuration is needed at all, and the
defaults (`PUBLIC_BASE_URL=http://localhost:8080`) simply become the real host.
This is the simplest correct deployment for this codebase.

## Local run (unchanged)

```bash
cd backend && npm install
cp .env.example .env
cp ../mock-source-api/products.json data/    # not needed; mock reads its own copy
node ../mock-source-api/server.js &          # upstream on :9099
node server.js                               # storefront on :8080
```

Then open <http://localhost:8080/>.
