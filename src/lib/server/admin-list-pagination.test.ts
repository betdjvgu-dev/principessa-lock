import { beforeEach, expect, it, vi } from "vitest";

const { tables, reads, supabase } = vi.hoisted(() => {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const reads: string[] = [];
  const supabase = { from(table: string) {
    reads.push(table);
    let from = 0;
    let to = 199;
    const filters: ((row: Record<string, unknown>) => boolean)[] = [];
    const query = {
      select() { return query; }, order() { return query; }, returns() { return query; },
      range(start: number, end: number) { from = start; to = end; return query; },
      eq(key: string, value: unknown) { filters.push((row) => row[key] === value); return query; },
      is(key: string, value: unknown) { return query.eq(key, value); },
      in(key: string, values: unknown[]) { filters.push((row) => values.includes(row[key])); return query; },
      then(resolve: (result: { data: Record<string, unknown>[]; error: null }) => unknown) {
        // Simulate a PostgREST row cap smaller than the requested page size.
        return Promise.resolve(resolve({ data: (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row))).slice(from, Math.min(to + 1, from + 20)), error: null }));
      },
    };
    return query;
  } };
  return { tables, reads, supabase };
});
vi.mock("@/lib/server/rate-limit", () => ({ enforceAdminRateLimit: async () => null }));
vi.mock("@/lib/server/admin-auth", () => ({ verifyAdminRequest: async () => ({ error: null }) }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => supabase }));
import { GET as sessions } from "@/app/api/admin/sessions/route";
import { GET as subs } from "@/app/api/admin/subs/route";
import { GET as requests } from "@/app/api/admin/session-requests/route";
import { GET as unlocks } from "@/app/api/admin/unlock-requests/route";

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  reads.length = 0;
});

it("lists sessions beyond the old 50 cap with latest heartbeat and complete unread counts", async () => {
  tables.sessions = Array.from({ length: 55 }, (_, i) => ({ id: `s${i}`, devices: null, subs: null }));
  tables.latest_session_heartbeats = [{ session_id: "s54", received_at: "2026-09-07T12:00:00Z", used_minutes: 12 }];
  tables.session_messages = Array.from({ length: 25 }, () => ({ session_id: "s54", sender: "sub", read_at: null }));
  const response = await sessions(new Request("http://localhost/api/admin/sessions"));
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.sessions).toHaveLength(55);
  expect(body.sessions[54]).toMatchObject({ unread_message_count: 25, latest_heartbeat: { used_minutes: 12 } });
  expect(reads).toContain("latest_session_heartbeats");
  expect(reads).not.toContain("device_heartbeats");
});

it("keeps every sub and pending request across short pages and batched device queries", async () => {
  tables.subs = Array.from({ length: 205 }, (_, i) => ({ id: `u${i}`, label: `User ${i}` }));
  tables.devices = tables.subs.map((row) => ({ sub_id: row.id, device_model: "Phone" }));
  tables.session_requests = tables.subs.map((row, i) => ({ id: `r${i}`, sub_id: row.id, subs: null, status: "pending" }));
  tables.app_unlock_requests = Array.from({ length: 25 }, (_, i) => ({ id: `a${i}`, subs: null, status: "pending" }));
  const request = new Request("http://localhost/api/admin/subs");
  const subBody = await (await subs(request)).json();
  expect(subBody.subs).toHaveLength(205);
  expect(subBody.subs[204].device_model).toBe("Phone");
  const requestBody = await (await requests(request)).json();
  expect(requestBody.requests).toHaveLength(205);
  expect(requestBody.requests[204].device_model).toBe("Phone");
  expect((await (await unlocks(request)).json()).requests).toHaveLength(25);
});
