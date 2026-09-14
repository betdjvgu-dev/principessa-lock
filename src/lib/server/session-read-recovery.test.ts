import { beforeEach, expect, it, vi } from "vitest";

const { query, db } = vi.hoisted(() => {
  const query = { select: vi.fn(), eq: vi.fn(), gt: vi.fn(), maybeSingle: vi.fn(), returns: vi.fn() };
  return { query, db: { from: vi.fn(() => query), rpc: vi.fn() } };
});
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => db }));
import { requireAuthenticatedDevice } from "./device-auth";
import { GET } from "@/app/api/sessions/[id]/route";

const request = () => new Request("http://localhost/api/sessions/session", {
  headers: { authorization: "Bearer test-only" },
});
const context = { params: Promise.resolve({ id: "session" }) };
const transient = { code: "PGRST003", message: "Connection pool timeout" };
const device = { id: "device", device_secret_hash: "hash", subs: { status: "active" } };

beforeEach(() => {
  vi.resetAllMocks();
  for (const method of [query.select, query.eq, query.gt]) method.mockReturnValue(query);
  db.from.mockReturnValue(query);
  db.rpc.mockResolvedValue({ data: 0, error: null });
  query.returns.mockResolvedValue({ data: [], error: null });
});

function authenticatedSession() {
  query.maybeSingle.mockResolvedValueOnce({ data: device, error: null })
    .mockResolvedValueOnce({ data: { id: "session", device_id: "device" }, error: null });
}

it("database auth outage returns 503, never invalid credentials or a successful empty session", async () => {
  query.maybeSingle.mockResolvedValue({ data: null, error: transient });
  const result = await requireAuthenticatedDevice(request());
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.response.status).toBe(503);
  expect(query.maybeSingle).toHaveBeenCalledTimes(3);
});

it("device lookup can recover without weakening ownership checks", async () => {
  query.maybeSingle.mockResolvedValueOnce({ data: null, error: transient })
    .mockResolvedValueOnce({ data: device, error: null })
    .mockResolvedValueOnce({ data: { id: "session", device_id: "someone-else" }, error: null });
  expect((await GET(request(), context)).status).toBe(403);
  expect(db.rpc).not.toHaveBeenCalled();
});

it("sync recovers a transient pause check and retains returned unlock configuration", async () => {
  authenticatedSession();
  db.rpc.mockResolvedValueOnce({ data: null, error: transient })
    .mockResolvedValueOnce({ data: 0, error: null });
  query.maybeSingle.mockResolvedValueOnce({ data: { id: "session", status: "active", daily_limit_minutes: 150 }, error: null });
  query.returns.mockResolvedValue({ data: [{ package_name: "example.allowed" }], error: null });
  const response = await GET(request(), context);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "active", dailyLimitMinutes: 150, unlockedPackages: ["example.allowed"] });
  expect(db.rpc).toHaveBeenCalledTimes(2);
});

it("an unlock query outage cannot overwrite Android's saved unlocks with an empty list", async () => {
  authenticatedSession();
  query.maybeSingle.mockResolvedValueOnce({ data: { id: "session", status: "active" }, error: null });
  query.returns.mockResolvedValue({ data: null, error: transient });
  const response = await GET(request(), context);
  expect(response.status).toBe(503);
  const body = await response.json();
  expect(body.ok).toBe(false);
  expect(body.unlockedPackages).toBeUndefined();
});

it("a missing pause RPC stays an explicit 500, not a skipped safety check", async () => {
  authenticatedSession();
  db.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Function missing" } });
  expect((await GET(request(), context)).status).toBe(500);
  expect(db.rpc).toHaveBeenCalledTimes(1);
});
