import { beforeEach, describe, expect, it, vi } from "vitest";
const { query, supabase } = vi.hoisted(() => {
  const query = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), update: vi.fn(), maybeSingle: vi.fn() };
  return { query, supabase: { from: vi.fn(() => query) } };
});
vi.mock("@/lib/server/rate-limit", () => ({ enforceRateLimit: async () => null }));
vi.mock("@/lib/server/device-auth", () => ({
  requireAuthenticatedDevice: async () => ({ ok: true, device: { id: "device" } }),
  verifySessionOwnershipForDevice: async () => ({ ok: true }),
}));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => supabase }));
import { POST as resume } from "./[id]/resume/route";
import { POST as pause } from "./[id]/pause/route";

beforeEach(() => {
  vi.clearAllMocks();
  query.maybeSingle.mockReset();
  for (const method of [query.select, query.eq, query.is, query.update]) method.mockReturnValue(query);
});
const context = () => ({ params: Promise.resolve({ id: "session" }) });
const request = () => new Request("http://localhost/api/sessions/session/resume", { method: "POST" });

describe("concurrent pause/resume", () => {
  it("returns the pause actually stored by a competing request", async () => {
    query.maybeSingle.mockResolvedValueOnce({ data: { status: "active", paused_at: null }, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { status: "active", paused_at: "2026-09-07T10:00:00Z" }, error: null });
    const response = await pause(request(), context());
    expect(await response.json()).toMatchObject({ pausedAt: "2026-09-07T10:00:00Z" });
  });
  it("never returns a locally computed end date if another request already resumed", async () => {
    query.maybeSingle.mockResolvedValueOnce({ data: {
      status: "active", ends_at: "2026-09-10T10:00:00Z", paused_at: "2026-09-07T10:00:00Z",
    }, error: null }).mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { status: "active", ends_at: "2026-09-11T10:00:00Z", paused_at: null }, error: null });
    const response = await resume(request(), context());
    expect(await response.json()).toMatchObject({ endsAt: "2026-09-11T10:00:00Z", pausedAt: null });
    expect(query.eq).toHaveBeenCalledWith("ends_at", "2026-09-10T10:00:00Z");
  });
  it("does not resume revoked sessions", async () => {
    query.maybeSingle.mockResolvedValueOnce({ data: {
      status: "revoked", ends_at: "2026-09-10T10:00:00Z", paused_at: null,
    }, error: null });
    expect((await resume(request(), context())).status).toBe(409);
    expect(query.update).not.toHaveBeenCalled();
  });
});
