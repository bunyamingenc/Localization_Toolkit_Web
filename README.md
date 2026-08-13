# Loc Toolkit — Web

A REST API and browser front-end version of [Loc Toolkit](https://github.com/bunyamingenc/Localization-Toolkit) (the desktop Electron app). Upload a project, run it through the same encoding QA / placeholder analysis / renamer / Okapi Rainbow pipeline, entirely from a browser — no install required.

Built to demonstrate turning a single-user desktop tool into a stateless, scalable web service: async job processing, multi-project support, and a REST contract that could sit behind a real job queue and object storage with no changes to the core pipeline logic.

---

## What this is (and isn't)

This is a **portfolio/demo-grade** implementation, not a production SaaS. It proves the architecture — stateless endpoints, async pipeline execution, multi-tenant-shaped data model — using the simplest possible storage: local disk and a SQLite file. See [Known limitations](#known-limitations) below before you rely on it for anything beyond a demo.

---

## Quick start

```bash
git clone https://github.com/bunyamingenc/Localization-Toolkit-Web.git
cd Localization-Toolkit-Web
npm install
npm start
```

Open **http://localhost:3000** — upload a zip or a folder, and the pipeline runs automatically.

---

## Pipeline

| Step | Type | What it does |
|---|---|---|
| File inventory | Auto | Classifies every file — resource, content, asset, unrecognized |
| Encoding & line-ending QA | Auto | Detects encoding, EOL, BOM for source files |
| Placeholder analysis | Auto | Detects 14 placeholder pattern types, generates Trados regex |
| CAT tool | Manual | Mark done once you've translated externally (Trados, etc.) |
| Normalize filenames | Interactive | Preview + apply a renaming convention to translated files |
| Output encoding & line-ending QA | Interactive | Compares output against the source baseline |
| Okapi Rainbow | Auto-detect | Groups error files into 3 fileSets, generates a downloadable `.rnb` |
| Package delivery | — | *(not yet ported to web — see desktop version)* |

Every project can have multiple runs. Run history is kept per project.

---

## Environment variables

All optional — every one of these has a working default that requires zero configuration for local dev. Set any of them to swap in the real backend for a production deployment.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server port |
| `API_KEY` | *(unset)* | If set, every request (except `/health`) must include a matching `x-api-key` header. Unset = no auth, fine for local dev. |
| `CLEANUP_MAX_AGE_HOURS` | `24` | Projects and step-upload folders older than this are deleted automatically |
| `CLEANUP_INTERVAL_MINUTES` | `60` | How often the cleanup sweep runs |
| `REDIS_URL` | *(unset)* | If set, pipeline runs are enqueued via BullMQ instead of executing in-process. **You must also run `npm run worker`** as a separate process to actually consume jobs — the API server only enqueues once this is set. |
| `WORKER_CONCURRENCY` | `2` | How many jobs the worker process handles at once (only relevant with `REDIS_URL` set) |
| `S3_BUCKET` | *(unset)* | If set, uploaded projects are stored in this S3 bucket instead of local disk. Requires standard AWS credentials (env vars, IAM role, or `~/.aws/credentials`) to be available to the process. |
| `AWS_REGION` | `us-east-1` | AWS region for S3 (only relevant with `S3_BUCKET` set) |
| `S3_ENDPOINT` | *(unset)* | Set this to use an S3-compatible service instead of real AWS — Cloudflare R2, MinIO, etc. |
| `DATABASE_URL` | *(unset)* | If set (a Postgres connection string), the app uses Postgres instead of the local SQLite file. Schema is created automatically on first connect. |

### Testing status — please read before relying on the "real" backends

This sandbox environment I built this in has no network access to Redis, S3/AWS, or Postgres — only npm and GitHub. That means:

- **The default (no env vars set) path** — local disk, SQLite, in-process pipeline execution — was tested end-to-end repeatedly throughout development, including after every single refactor in this section. It works, verified.
- **`REDIS_URL`, `S3_BUCKET`, `DATABASE_URL`** — each one was verified to *correctly detect the setting and attempt a real connection* (confirmed via connection errors when pointed at addresses with nothing listening), and the code was written and reviewed carefully. But none of them have been exercised against a real, live Redis/S3/Postgres instance. **Test these against your actual infrastructure before trusting them in production** — the architecture is sound, but "I wrote it carefully" isn't the same guarantee as "I ran it against the real thing and watched it work."

If something doesn't work exactly as documented once you point it at real infra, that's much more likely than not a small bug in the untested path, not a fundamental design problem — the abstractions were built so a fix wouldn't ripple back into the tested default path.

---

## Deploying this somewhere

**Two deployment shapes, pick based on what you need:**

### Simple — everything on one machine (default)

With no env vars set, this app stores everything on the **local filesystem**: uploaded projects in `storage/projects/`, the database in a SQLite file at `storage/*.db`. Fine on your own machine or a VPS with a persistent disk. **Not** fine on most free-tier PaaS hosts (Render's free tier, Railway's ephemeral containers) — those wipe local disk on every redeploy or restart, and your data disappears without warning.

If you go this route, either use a host with a persistent disk (a small VPS is plenty — DigitalOcean, Linode), or accept the data is disposable and you'll re-seed it each time.

### Scaled — real backends (Redis + S3 + Postgres)

Set `DATABASE_URL`, `S3_BUCKET`, and `REDIS_URL` and this becomes a genuinely stateless, horizontally-scalable service:

- **API instances** hold no state — scale them to as many as you want behind a load balancer
- **Worker processes** (`npm run worker`) consume the queue independently — scale these separately based on how much pipeline work you're actually doing
- **Postgres** is the single source of truth for project/run/step data, shared across every API and worker instance
- **S3** is the single source of truth for uploaded files, same story

This is the architecture that makes "bulk operations" and "automation integration" actually work at scale — any of your instances can serve any request, because none of them are holding anything in memory or on a disk only they can see.

**Setting the API key on your host:** most PaaS providers have an environment variables panel — set `API_KEY` there to a long random string. The browser will prompt you for it on first use and remember it in `localStorage`.

---

## Known limitations

- **No automated tests.** Every endpoint — including the Redis/S3/Postgres integration work — was verified by hand with `curl` and direct Node scripts during development, not a test suite. Fine for a portfolio piece; a real service would want integration tests before each deploy.
- **The Redis/S3/Postgres paths are structurally correct but not live-tested** against real infrastructure — see the testing status note under Environment Variables above for exactly what was and wasn't verified.
- **Single shared API key, not per-user accounts.** `API_KEY` stops randoms on the internet from touching your instance — it does not give you multiple isolated users. If you need that, this needs real auth (sessions, JWT, whatever fits) before it should hold anyone else's data.
- **No rate limiting.** Someone with your API key (or an unauthenticated instance) could still hammer the upload endpoint. A reverse proxy with rate limiting (nginx, Cloudflare) is the usual quick fix if this matters to you.
- **S3 backing covers project upload/download only.** The renamer and output-QA steps' scratch uploads (translated files you upload mid-pipeline) stay on local disk regardless of `S3_BUCKET` — they're ephemeral per-run artifacts, not durable project data, so this is a deliberate scope boundary, not an oversight.

---

## Tech stack

Express · SQLite (`better-sqlite3`) or Postgres (`pg`) · BullMQ + Redis (optional) · AWS S3 SDK v3 (optional) · `chardet` · `archiver`/`unzipper` · vanilla JS + JSZip on the frontend (no framework, no build step).

---

## Also see

[Loc Toolkit (Desktop)](https://github.com/bunyamingenc/Localization-Toolkit) — the original Electron app this API was ported from, with a real Windows installer and full local-filesystem workflow (including direct Okapi Rainbow launching, which this web version can't do since a server can't spawn a process on your machine).

---

## Author

**Bünyamin Genç** — Localization Engineering, Hacettepe University
[GitHub](https://github.com/bunyamingenc)
