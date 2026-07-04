# Desktop Admin MVP Manual Testing

## 1. Start the backend

From the backend folder:

```bash
cd backend
npm run dev
```

The Phase 1 backend should be running at `http://localhost:3000`.

## 2. Install and start the desktop app

In a second terminal:

```bash
cd ..
cd desktop-admin
npm install
npm run dev
```

This opens the Electron desktop app window.

## 3. Create a test pending request

Using PowerShell:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/api/session-requests `
  -ContentType "application/json" `
  -Body '{"deviceName":"Test Phone A","sessionDays":3,"dailyLimitMinutes":30,"forcedSleepEnabled":true}'
```

Create a second request so you can test reject too:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/api/session-requests `
  -ContentType "application/json" `
  -Body '{"deviceName":"Test Phone B","sessionDays":5,"dailyLimitMinutes":45,"forcedSleepEnabled":false}'
```

## 4. Enter desktop settings

Inside the Desktop Admin App:

1. Set `Backend URL` to `http://localhost:3000`
2. Set `Admin API Token` to your real `ADMIN_API_TOKEN`
3. Click `Save Settings`

Expected result:

- settings save locally
- the app refreshes pending requests automatically

## 5. Refresh pending requests

Click `Refresh`.

Expected result:

- loading state appears
- both test requests appear as cards
- each card shows device name, requested days, daily limit, forced sleep flag, created time, and status

## 6. Approve one request

Click `Approve` on one pending request.

Expected result:

- the request disappears from the pending list
- an `Activation Code` panel appears
- the returned code is visible
- `Copy` copies the code
- the note `Send this code manually to the user.` is visible

## 7. Reject another request

Click `Reject` on a different pending request.

Expected result:

- the request disappears from the pending list
- no activation code is shown for the rejected request

## 8. Verify backend state

Optional API checks:

```powershell
Invoke-RestMethod `
  -Method Get `
  -Uri http://localhost:3000/api/admin/session-requests `
  -Headers @{ Authorization = "Bearer YOUR_ADMIN_API_TOKEN" }
```

Expected result:

- the approved request is gone from pending
- the rejected request is gone from pending

## 9. Error checks

### Missing settings

Clear either Backend URL or Admin API Token and click `Refresh`.

Expected result:

- clear error message explains that both values are required

### Invalid token

Save a wrong token and click `Refresh`.

Expected result:

- clear backend error is shown

### Backend offline

Stop the backend and click `Refresh`.

Expected result:

- request failure error is shown
