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

All optional — sensible defaults if you don't set any of them.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server port |
| `API_KEY` | *(unset)* | If set, every request (except `/health`) must include a matching `x-api-key` header. Unset = no auth, fine for local dev. |
| `CLEANUP_MAX_AGE_HOURS` | `24` | Projects and step-upload folders older than this are deleted automatically |
| `CLEANUP_INTERVAL_MINUTES` | `60` | How often the cleanup sweep runs |

---

## Deploying this somewhere

**Read this before you deploy — it will save you a confusing debugging session.**

This app stores everything on the **local filesystem**: uploaded projects live in `storage/projects/`, the database is a SQLite **file** at `storage/*.db`. That's fine on your own machine or a VPS with a persistent disk. It is **not** fine on most free-tier PaaS hosts (Render's free tier, Railway's ephemeral containers, etc.) — those wipe the local filesystem on every redeploy or container restart, which means your database and every uploaded project disappear without warning.

**Before deploying, pick one:**

- **A host with a persistent disk** — a small VPS (DigitalOcean, Linode, a $5 droplet is plenty), or a PaaS plan that explicitly offers a persistent volume (Render's paid disk add-on, Railway volumes, Fly.io volumes). Point `storage/` at that volume and you're done — no code changes needed.
- **Accept it's ephemeral** — fine if this is purely a demo you'll re-seed each time, not fine if you want data to survive a redeploy.

If you outgrow local disk entirely, the real fix is swapping the storage layer for S3-compatible object storage and the SQLite file for Postgres — the route/step logic doesn't change, only `db.js` and the `fs.` calls in the upload/extract paths would need to point elsewhere.

**Setting the API key on your host:** most PaaS providers have an environment variables panel — set `API_KEY` there to a long random string. The browser will prompt you for it on first use and remember it in `localStorage`.

---

## Known limitations

- **No automated tests.** Every endpoint in this project was verified by hand with `curl` during development. Fine for a portfolio piece; a real service would want integration tests before each deploy.
- **Single shared API key, not per-user accounts.** `API_KEY` stops randoms on the internet from touching your instance — it does not give you multiple isolated users. If you need that, this needs real auth (sessions, JWT, whatever fits) before it should hold anyone else's data.
- **No rate limiting.** Someone with your API key (or an unauthenticated instance) could still hammer the upload endpoint. A reverse proxy with rate limiting (nginx, Cloudflare) is the usual quick fix if this matters to you.
- **Ephemeral by default on most free PaaS tiers** — see the deployment section above.

---

## Tech stack

Express · SQLite (`better-sqlite3`) · `chardet` · `archiver`/`unzipper` · vanilla JS + JSZip on the frontend (no framework, no build step).

---

## Also see

[Loc Toolkit (Desktop)](https://github.com/bunyamingenc/Localization-Toolkit) — the original Electron app this API was ported from, with a real Windows installer and full local-filesystem workflow (including direct Okapi Rainbow launching, which this web version can't do since a server can't spawn a process on your machine).

---

## Author

**Bünyamin Genç** — Localization Engineering, Hacettepe University
[GitHub](https://github.com/bunyamingenc)
