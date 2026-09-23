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
---

## One-click backend hosting: Render

`render.yaml` at the repo root is a Render blueprint for the backend. It runs
`backend/scripts/start.js`, which hashes `ADMIN_PASSWORD` at boot (or uses
`ADMIN_PASSWORD_HASH` if set), strips the plain password from the server
process environment, and then starts `server.js`. The backend serves the whole
storefront (frontend + API) on one origin, so the Render URL alone is a
complete working site.

Deploy: <https://render.com/deploy?repo=https://github.com/bitvalvewestern-byte/REFURBISHEDELECTRONICS>

After the service is created, set two secrets in the Render dashboard:

| Secret | Value |
| --- | --- |
| `PUBLIC_BASE_URL` | `https://<your-service>.onrender.com` |
| `ADMIN_PASSWORD` | a strong password (min 10 chars; hashed at boot) |

Blueprint defaults: Node 24, `NODE_ENV=production`, `TRUST_PROXY=true`,
`COOKIE_SECURE=true`, `SOURCE_DRIVER=mock`, `SELLING_PRICE_FACTOR=0.50`,
`SYNC_ON_BOOT=true`, `CORS_ORIGINS=https://refurbishedelectronics.vercel.app`.

### Ephemeral storage on the free plan

Render's free plan gives the service an **ephemeral filesystem**: the SQLite
database (`backend/data/storefront.sqlite`) is wiped on every restart or
redeploy. Orders and admin sessions will not survive. That is acceptable for a
demo. For real orders:

- paid plan: add a **persistent disk** (e.g. mounted at `/var/data`) and set
  `DB_FILE=/var/data/storefront.sqlite`, or
- use a managed database (Postgres/MySQL) - the schema is portable.

### Wiring the Vercel frontend to the Render backend

Keep the browser on one origin (the admin cookie is `SameSite=Strict` and is
never sent cross-site). Add a rewrite to `vercel.json`:

```json
"rewrites": [
  { "source": "/api/(.*)", "destination": "https://<your-service>.onrender.com/api/$1" }
]
```

and make sure the backend has `CORS_ORIGINS=https://refurbishedelectronics.vercel.app`
and `TRUST_PROXY=true` (both already in `render.yaml`). `TRUST_PROXY=true` is
required behind the Vercel proxy so rate limiting keys on the real client IP
instead of one shared bucket.

### Testing `start.js` locally

```bash
cd backend
DB_FILE=/tmp/start-test.sqlite PORT=8091 ADMIN_PASSWORD='TestPassword123' node scripts/start.js
# then: curl http://127.0.0.1:8091/api/health
```

`dotenv` never overrides real environment variables, so the CLI values win over
`backend/.env`.
### Current temporary wiring

`vercel.json` currently proxies `/api/*` to the temporary sandbox backend
(`https://8080-i4wtqey543n4xvrw9zxpe.e2b.app`). That URL exists only while the
sandbox runs. Once a permanent backend host exists (e.g. the Render service
above), change the rewrite destination to
`https://<your-service>.onrender.com/api/:path*` - that is the only change
needed.

Backend side of the current wiring (applied in the sandbox `backend/.env`):
`CORS_ORIGINS` lists both the Vercel domain and the sandbox origin, and
`TRUST_PROXY=true` because requests now arrive through the Vercel proxy
(without it, every visitor would share one rate-limit bucket).
---

## Why product listings keep working even when the backend sleeps

The temporary backend lives on an ephemeral sandbox. When that sandbox idles or
restarts, `/api/*` stops answering and the storefront would otherwise show an
empty listing. The front-end now degrades in three steps instead of failing:

1. **Live API** - `/api/products` (normal path).
2. **localStorage cache** - the last successful catalogue fetch, kept in the
   browser. Survives short API blips and repeat visits.
3. **Bundled snapshot** - `frontend/data/catalogue.json`, a static file served
   by the static host itself. Works for a first-time visitor with no cache, so
   browsing never depends on the backend being awake.

A warning banner is shown whenever steps 2 or 3 are used. All three sources are
display-only: `POST /api/orders/quote` and `POST /api/orders` re-price every
line from the database, so a stale displayed price can never be checked out.

### Refreshing the snapshot

The snapshot is committed to the repo. Rebuild it whenever the catalogue
changes and the backend is reachable:

```bash
python3 scripts/build-catalogue-snapshot.py http://localhost:8080
# or against the deployed backend:
python3 scripts/build-catalogue-snapshot.py https://<backend-host>
```

Only display fields are copied (id, name, description, image, selling_price,
currency, stock, in_stock, category, updated_at) - no cost price, no margin, no
supplier data.

### Static cache headers

`vercel.json` serves HTML and JS with `Cache-Control: no-cache, must-revalidate`.
Vercel's ETag makes the revalidation cheap (304s), and it removes the stale-JS
problem where an old bundle kept running after a deploy.

### Source ordering caveat

Steps 2 and 3 can only ever show what the live API has already exposed. If the
site has never once loaded successfully in a given browser (step 2 empty) the
bundled snapshot still covers it - but if a *new* product was just added and the
backend is down, that product appears only after the next successful API load or
snapshot rebuild. The permanent fix for this remains a persistent backend host
(Render), as described above.
