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
- `ADMIN_API_TOKEN`

Important:

- `SUPABASE_SERVICE_ROLE_KEY` is server-only and must never be exposed to Android or Desktop client code.
- Admin endpoints require `Authorization: Bearer <ADMIN_API_TOKEN>`.

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
