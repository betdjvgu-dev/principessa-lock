import { beforeEach, expect, it, vi } from "vitest";
const { query, db, push } = vi.hoisted(() => {
  const query = { insert: vi.fn(), select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
  return { query, db: { from: vi.fn(() => query) }, push: vi.fn() };
});
vi.mock("@/lib/server/fcm", () => ({ sendRemoteActionPush: push }));
import { queueSyncConfigPush } from "./remote-action-dispatch";

beforeEach(() => {
  vi.resetAllMocks();
  db.from.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.insert.mockResolvedValue({ error: null });
  query.maybeSingle.mockResolvedValue({ data: { fcm_token: "test-only" }, error: null });
  push.mockResolvedValue(true);
});
const target = { sessionId: "session", deviceId: "device", subId: "sub" };
const run = () => queueSyncConfigPush(db as never, target);

it("awaits queue and push for immediate delivery", async () => {
  expect(await run()).toEqual({ queued: true, pushSent: true });
  expect(query.insert).toHaveBeenCalledWith(expect.objectContaining({ action_type: "sync_config", device_id: "device", status: "pending" }));
});
it("does not treat a Supabase error result as a successfully queued action", async () => {
  query.insert.mockResolvedValue({ error: { code: "42501" } });
  expect(await run()).toEqual({ queued: false, pushSent: true });
});
it("retains queued delivery when push fails", async () => {
  push.mockResolvedValue(false);
  expect(await run()).toEqual({ queued: true, pushSent: false });
});
it("does not roll back approval or throw when the device lookup fails", async () => {
  query.maybeSingle.mockResolvedValue({ data: null, error: { code: "PGRST003" } });
  expect(await run()).toEqual({ queued: true, pushSent: false });
});
