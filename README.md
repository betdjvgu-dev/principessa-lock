# Principessa Lock Backend

Phase 0 and Phase 1 backend foundation for the Principessa Lock system.

Current scope:

- `docs/architecture.md`: architecture and phase order
- `supabase/schema.sql`: Phase 1 tables and constraints
- `src/app/api/...`: request, approval, rejection, and activation endpoints
- `docs/manual-testing.md`: exact manual test flow with `curl`
- `../desktop-admin/`: Phase 2 private desktop admin MVP
- `docs/desktop-admin-manual-testing.md`: exact desktop admin test flow

## Environment variables

Copy `.env.example` to `.env.local` and fill in:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `ADMIN_EMAIL` (required; admin login, refresh and protected admin routes deny access when missing)
- `SETTINGS_PIN` (optional; kept server-side, enables the authenticated session Settings approval endpoint)
- `GITHUB_RELEASE_REPOSITORY` (public APK-only repository)
- `GITHUB_RELEASE_TOKEN` (fine-grained token scoped to that repository)

Important:

- `SUPABASE_SERVICE_ROLE_KEY` is server-only and must never be exposed to Android or Desktop client code.
- Admin endpoints require a Supabase Auth access token.

### October 4 update

Before deploying this update on an existing database, apply
`supabase/phase-settings-access-20261004.sql` if the `settings_access_allowed`
column is missing. Do not re-run the full schema on an existing database.
Settings approval increments the session config version and uses authenticated
device ownership checks. Process-exit diagnostics use bounded fields from the
existing heartbeat payload; they need no additional database columns.
Failed/cooldown-delayed Settings alert pushes remain queued for a later heartbeat.

## Run locally

```bash
cd backend
npm install
npm run dev
```

Then apply `supabase/schema.sql` in your Supabase SQL editor and follow `docs/manual-testing.md`.

## Desktop Admin MVP

The private desktop admin app lives in the sibling folder `../desktop-admin/`.

Run it with:

```bash
cd ..
cd desktop-admin
npm install
npm run dev
```

It stores only:

- backend URL
- admin API token

It does not use or embed the Supabase service role key.

## Android APK publishing

APK binaries are published as assets in a separate public GitHub repository. The private source
repository must not be made public. Apply
`supabase/phase-github-apk-distribution-20260718.sql`, then publish with:

```powershell
npm run publish:android -- "..\principessa-lock\app\build\outputs\apk\release\app-release.apk" 19 "1.0.0" "Release notes"
```

`/api/app-download?platform=android` remains the stable URL used by existing Android clients.
It redirects to the latest GitHub Release asset and falls back to the old Supabase Storage object
until the first GitHub-hosted release is published.
