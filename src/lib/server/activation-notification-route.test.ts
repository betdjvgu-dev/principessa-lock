import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ single: vi.fn(), rpc: vi.fn(), notify: vi.fn(), query: {} as Record<string, unknown> }));
vi.mock("./rate-limit", () => ({ enforceRateLimit: async () => null }));
vi.mock("./device-auth", () => ({ requireAuthenticatedDevice: async () => ({ ok: true, device: { id: "device", deviceName: "Phone" } }) }));
vi.mock("./request-validation", () => ({ readJsonBody: async () => ({ ok: true, data: {} }), validateActivateInput: () => ({ ok: true, data: {} }) }));
vi.mock("./supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: () => m.query, rpc: m.rpc }) }));
vi.mock("./session-activation-notification", () => ({ notifyAdminSessionActivated: m.notify }));
import { POST } from "@/app/api/activate/route";
const session = { id: "session", device_id: "device", status: "active", session_days: 3, daily_limit_minutes: 90,
  starts_at: "2026-09-28T00:00:00Z", ends_at: "2026-10-01T00:00:00Z", activated_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z" };
const approved = { id: "request", activation_code_expires_at: "2099-01-01T00:00:00Z", requested_days: 3, daily_limit_minutes: 90 };
beforeEach(() => {
  vi.resetAllMocks();
  for (const method of ['select','eq','order','limit','update','insert']) m.query[method] = () => m.query;
  m.query.maybeSingle = m.single; m.query.error = null;
  m.notify.mockResolvedValue(false);
  m.rpc.mockResolvedValue({ data: { created: true, session }, error: null });
});
const run = () => POST(new Request('http://localhost/api/activate', { method: 'POST' }));
it('notifies only after a new session exists; failed delivery does not break activation', async () => {
  m.single.mockResolvedValueOnce({ data: approved }).mockResolvedValueOnce({ data: null }).mockResolvedValueOnce({ data: session });
  expect((await run()).status).toBe(200);
  expect(m.notify).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session', deviceName: 'Phone', sessionDays: 3, dailyLimitMinutes: 90 });
});
it('activation retry recovering an existing session does not notify again', async () => {
  m.single.mockResolvedValueOnce({ data: null }).mockResolvedValueOnce({ data: session });
  expect((await run()).status).toBe(200);
  expect(m.notify).not.toHaveBeenCalled();
});
it('repairing the request for an existing session does not notify again', async () => {
  m.single.mockResolvedValueOnce({ data: approved }).mockResolvedValueOnce({ data: session });
  expect((await run()).status).toBe(200);
  expect(m.notify).not.toHaveBeenCalled();
});
