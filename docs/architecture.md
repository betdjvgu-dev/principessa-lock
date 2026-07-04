# Principessa Lock Architecture

## Phase scope

This repository currently implements only Phase 0 and Phase 1.

Not included yet:

- Android UI
- Desktop UI
- phone locking
- screen time enforcement
- forced sleep enforcement
- device admin
- usage access
- overlay blocking
- anti-bypass systems
- complex auth system
- push notifications
- heartbeat
- remote admin actions

## System roles

### Android App

- Public user-side app installed on user phones
- Submits session requests to the backend
- Later accepts activation codes from the user
- Will eventually enforce screen time, locking, and forced sleep locally
- Does not hold privileged backend secrets

### Desktop Admin App

- Private admin-only client used only by the owner
- Is not a local server
- Does not accept direct connections from Android devices
- Talks only to the backend API
- Uses an admin bearer token during Phase 1

### Backend

- Central communication bridge for both Android and Desktop Admin
- Only trusted place for privileged operations
- Stores state in Supabase
- Uses server-side API routes for approval, rejection, and activation workflows
- Keeps the Supabase service role key in server-only environment variables

## Communication model

The supported communication path is:

`Android App -> Backend API <- Desktop Admin App`

Android devices must never connect directly to the desktop app.
The desktop app is a private client, not the authority.
The backend is the authority and the only bridge between the two apps.

## Secret handling

- `SUPABASE_SERVICE_ROLE_KEY` must exist only in backend/server environment variables
- Never place the service role key in Android code
- Never place the service role key in Desktop client code
- Phase 1 admin protection uses `ADMIN_API_TOKEN`
- Admin requests must send `Authorization: Bearer <ADMIN_API_TOKEN>`

This Phase 1 token model is intentionally simple because the Desktop Admin App is private.
It can later be replaced with Supabase Auth or another stronger admin identity flow.

## First milestone

The first independently testable milestone is:

`request -> admin approval -> activation code -> Android activation`

That milestone means:

1. Android submits a session request
2. Backend stores it as pending
3. Desktop Admin lists pending requests
4. Desktop Admin approves or rejects the request
5. Approval generates a human-readable activation code
6. Only a hash of the activation code is stored
7. Android submits the activation code to the backend
8. Backend creates the device and session records

## Why enforcement comes later

Locking and enforcement features depend on a stable backend contract first.
Before adding local Android enforcement, we need a reliable approval and activation flow that can be tested independently.

Later phases will build on top of the session data created in Phase 1, including:

- device-side enforcement
- usage tracking
- sleep rules
- heartbeat and sync
- remote admin actions
- anti-bypass hardening

## Development order

### Phase 0

- Document architecture
- Lock in authority boundaries
- Confirm secret handling rules
- Confirm development order

### Phase 1

- Create Supabase tables
- Add server-only Supabase admin helper
- Add admin bearer-token verification helper
- Add activation-code generation and hashing helper
- Add request, list, approve, reject, and activate API routes

### Later phases

Only after Phase 1 is stable and manually tested should the project move to:

- Android UI
- Desktop UI
- local enforcement
- schedules and sleep rules
- hardened auth and delivery flows

