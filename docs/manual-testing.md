# Manual Testing

## Prerequisites

1. Apply `supabase/schema.sql` in Supabase SQL editor
2. Create `.env.local` from `.env.example`
3. Fill `SUPABASE_URL`
4. Fill `SUPABASE_SERVICE_ROLE_KEY`
5. Fill `ADMIN_API_TOKEN`
6. Run:

```bash
cd backend
npm install
npm run dev
```

Assume the API is running at `http://localhost:3000`.

## 1. Create a session request

```bash
curl -X POST http://localhost:3000/api/session-requests ^
  -H "Content-Type: application/json" ^
  -d "{\"deviceName\":\"Test Phone\",\"sessionDays\":3,\"dailyLimitMinutes\":30,\"forcedSleepEnabled\":true}"
```

Expected result:

- HTTP 201
- `ok: true`
- returned request status is `pending`

## 2. List pending requests as admin

```bash
curl http://localhost:3000/api/admin/session-requests ^
  -H "Authorization: Bearer YOUR_ADMIN_API_TOKEN"
```

Expected result:

- HTTP 200
- newest pending requests first

## 3. Approve a pending request

Replace `REQUEST_ID` with the created request id.

```bash
curl -X POST http://localhost:3000/api/admin/session-requests/REQUEST_ID/approve ^
  -H "Authorization: Bearer YOUR_ADMIN_API_TOKEN"
```

Expected result:

- HTTP 200
- one plaintext `activationCode` is returned
- request status becomes `approved`

Save the returned activation code because it is not stored in plaintext.

## 4. Reject a pending request

Use this on a different pending request, because a request cannot be both approved and rejected.

```bash
curl -X POST http://localhost:3000/api/admin/session-requests/REQUEST_ID/reject ^
  -H "Authorization: Bearer YOUR_ADMIN_API_TOKEN"
```

Expected result:

- HTTP 200
- request status becomes `rejected`

## 5. Activate an approved request

Use the activation code returned by the approve endpoint.

```bash
curl -X POST http://localhost:3000/api/activate ^
  -H "Content-Type: application/json" ^
  -d "{\"activationCode\":\"PRIN-ABCD-1234\",\"deviceName\":\"Test Phone\",\"timezone\":\"Europe/Istanbul\"}"
```

Expected result:

- HTTP 200
- session is created
- response includes `sessionDays`, `dailyLimitMinutes`, `forcedSleepEnabled`, `startsAt`, `endsAt`, and `status`
- original request status becomes `activated`

## 6. Verify database state

After activation:

- `session_requests.status` should be `activated`
- `devices` should contain the new device row
- `sessions` should contain one row linked to the request and device

Useful SQL checks:

```sql
select id, device_name, status, approved_at, activated_at, activation_code_expires_at
from public.session_requests
order by created_at desc;
```

```sql
select id, device_name, platform, timezone, created_at
from public.devices
order by created_at desc;
```

```sql
select id, request_id, device_id, session_days, daily_limit_minutes, status, starts_at, ends_at
from public.sessions
order by created_at desc;
```

## Error cases worth testing

### Invalid admin token

Call any admin route with a bad token.

Expected result:

- HTTP 401
- JSON error response

### Invalid activation code

Submit a fake code to `/api/activate`.

Expected result:

- HTTP 404
- JSON error response

### Expired activation code

Manually set `activation_code_expires_at` to a past timestamp in Supabase and call `/api/activate`.

Expected result:

- HTTP 410
- request is marked `expired`

### Double activation

Call `/api/activate` twice with the same activation code.

Expected result:

- first call succeeds
- second call fails because the request is already activated
