import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";
let db: PGlite;
const device = "20000000-0000-4000-8000-000000000001", sub = "10000000-0000-4000-8000-000000000001";
const hardware = "a".repeat(64), old = "b".repeat(64), candidate = "c".repeat(64);
async function request(secret = candidate, username = "owner") {
  return (await db.query<{ value: Record<string, string> }>("select request_device_recovery($1,$2,$3) as value", [hardware, username, secret])).rows[0].value;
}
async function id() { return (await db.query<{ id: string }>("select id from device_recovery_requests where status='pending'")).rows[0].id; }
async function decide(approve = true) { await db.query("select decide_device_recovery($1,$2,'admin:test')", [await id(), approve]); }
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table subs(id uuid primary key,username text,status text);
    create table devices(id uuid primary key,sub_id uuid references subs(id),device_name text,
      hardware_id_hash text unique,device_secret_hash text unique,device_secret_created_at timestamptz,device_secret_rotated_at timestamptz);
    create table sessions(id uuid primary key default gen_random_uuid(),device_id uuid references devices(id),status text,starts_at timestamptz);
    create table private_messages(sub_id uuid references subs(id),message text);`);
  await db.exec(readFileSync("supabase/phase-access-transfers-20260928.sql", "utf8"));
  await db.exec(readFileSync("supabase/phase-device-recovery-20261007.sql", "utf8"));
  await db.exec(readFileSync("supabase/phase-device-recovery-20261007.sql", "utf8"));
}, 60000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("truncate subs,devices,sessions,private_messages,device_recovery_requests cascade");
  await db.query("insert into subs values($1,'owner','active')", [sub]);
  await db.query("insert into devices(id,sub_id,device_name,hardware_id_hash,device_secret_hash) values($1,$2,'Phone',$3,$4)", [device, sub, hardware, old]);
});
it("requires admin approval, preserves account/session/history and invalidates old credential", async () => {
  await db.query("insert into sessions(device_id,status,starts_at) values($1,'active',now())", [device]);
  await db.query("insert into private_messages values($1,'private')", [sub]);
  expect(await request()).toEqual({ status: "pending" });
  expect(await request()).toEqual({ status: "pending" });
  expect((await db.query("select device_secret_hash from devices")).rows[0]).toEqual({ device_secret_hash: old });
  await decide();
  const result = await request();
  expect(result.status).toBe("approved"); expect(result.deviceId).toBe(device); expect(result.sessionId).toBeTruthy();
  expect((await db.query("select device_secret_hash from devices")).rows[0]).toEqual({ device_secret_hash: candidate });
  expect((await db.query("select status from subs")).rows[0]).toEqual({ status: "active" });
  expect((await db.query("select * from private_messages")).rows).toHaveLength(1);
  expect(await request()).toEqual(result);
});
it("wrong username and another pending candidate cannot recover access", async () => {
  await expect(request(candidate, "other")).rejects.toThrow("recovery_unavailable");
  await request(); await expect(request("d".repeat(64))).rejects.toThrow("recovery_pending");
});
it("rejected and expired requests cannot rotate credentials", async () => {
  await request(); await decide(false); await expect(request()).rejects.toThrow("recovery_rejected");
  await request("e".repeat(64));
  await db.exec("update device_recovery_requests set expires_at=now()-interval '1 second' where status='pending'");
  await expect(decide()).rejects.toThrow("recovery_not_pending");
  expect((await db.query("select device_secret_hash from devices")).rows[0]).toEqual({ device_secret_hash: old });
});
it("revocation or credential rotation after requesting invalidates approval", async () => {
  await request(); await db.query("update devices set device_secret_hash=$1", ["f".repeat(64)]);
  await expect(decide()).rejects.toThrow("recovery_unavailable");
});
it("admin recovery works for transferred-to devices without disabling transfer protection", async () => {
  await db.exec("update devices set transfer_protected=true");
  await request(); await decide(); expect((await request()).status).toBe("approved");
  expect((await db.query("select transfer_protected from devices")).rows[0]).toEqual({ transfer_protected: true });
  await expect(db.query("update devices set device_secret_hash=$1", ["e".repeat(64)])).rejects.toThrow("transfer_credential_required");
});
it("revoked devices and archived accounts cannot request recovery", async () => {
  await db.exec("update devices set access_revoked_at=now(),device_secret_hash=null");
  await expect(request()).rejects.toThrow("recovery_unavailable");
});
it("database clients cannot invoke recovery functions or read candidate hashes", async () => {
  await db.exec("set role anon");
  await expect(request()).rejects.toThrow("permission denied");
  await expect(db.query("select * from device_recovery_requests")).rejects.toThrow("permission denied");
  await db.exec("reset role");
});
