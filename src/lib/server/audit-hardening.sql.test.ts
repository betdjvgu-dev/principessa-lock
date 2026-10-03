import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";
let db: PGlite;
const device = "20000000-0000-4000-8000-000000000001";
const sub = "10000000-0000-4000-8000-000000000001";
const request = "30000000-0000-4000-8000-000000000001";
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('app.uid',true),'')::uuid $$;
    grant usage on schema auth to authenticated;
    create table subs(id uuid primary key,label text,status text);
    create table devices(id uuid primary key,sub_id uuid,access_revoked_at timestamptz,timezone text);
    create table session_requests(id uuid primary key,device_id uuid,sub_id uuid,status text,activated_at timestamptz,
      activation_code_expires_at timestamptz,requested_days int,daily_limit_minutes int,screen_time_enabled boolean,
      always_allowed_package text,forced_sleep_enabled boolean,gallery_access_enabled boolean default false);
    create table sessions(id uuid primary key default gen_random_uuid(),request_id uuid unique,device_id uuid,sub_id uuid,
      session_days int check(session_days between 1 and 30),daily_limit_minutes int,screen_time_enabled boolean,
      always_allowed_package text,forced_sleep_enabled boolean,gallery_access_enabled boolean default false,
      starts_at timestamptz,ends_at timestamptz,activated_at timestamptz,timezone text,status text,price_usd numeric,
      paused_at timestamptz,config_version int default 1);
    create table admin_push_tokens(admin_user_id uuid primary key,fcm_token text,updated_at timestamptz default now());`);
  const sql = readFileSync("supabase/phase-audit-hardening-20261003.sql", "utf8");
  await db.exec(sql); await db.exec(sql);
}, 60000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("reset role; truncate subs,devices,session_requests,sessions,admin_rls_identities,admin_push_tokens");
  await db.query("insert into subs values($1,'Owner','active')", [sub]);
  await db.query("insert into devices(id,sub_id,timezone) values($1,$2,'Europe/Istanbul')", [device, sub]);
  await db.query(`insert into session_requests(id,device_id,sub_id,status,activation_code_expires_at,requested_days,
    daily_limit_minutes,screen_time_enabled,forced_sleep_enabled) values($1,$2,$3,'approved',now()+interval '1 day',3,60,true,false)`, [request,device,sub]);
});
async function activate(id = request) {
  return (await db.query<{ value: { created: boolean; session: { id: string } } }>(
    "select activate_device_session($1,$2,null) as value", [device,id])).rows[0].value;
}
it("activation is idempotent and leaves exactly one usable session", async () => {
  const a = await activate(), b = await activate();
  expect(a.created).toBe(true); expect(b.created).toBe(false); expect(a.session.id).toBe(b.session.id);
  expect((await db.query("select status from sessions")).rows).toEqual([{ status: "active" }]);
  expect((await db.query("select status from session_requests")).rows).toEqual([{ status: "activated" }]);
});
it("insert failure does not revoke the existing session", async () => {
  const original = await activate();
  const next = "30000000-0000-4000-8000-000000000002";
  await db.query("insert into session_requests select $1,device_id,sub_id,'approved',null,now()+interval '1 day',99,daily_limit_minutes,screen_time_enabled,always_allowed_package,forced_sleep_enabled,gallery_access_enabled,gallery_access_consented from session_requests where id=$2", [next,request]);
  await expect(activate(next)).rejects.toThrow();
  expect((await db.query("select status from sessions where id=$1", [original.session.id])).rows[0]).toEqual({ status: "active" });
});
it("revoked requests cannot resurrect a session", async () => {
  const a = await activate();
  await db.query("update sessions set status='revoked' where id=$1", [a.session.id]);
  await expect(activate()).rejects.toThrow("activation_terminal");
});
it("gallery consent is immutable and enabled flags are not a substitute", async () => {
  await expect(db.exec("update session_requests set gallery_access_enabled=true")).rejects.toThrow("gallery_user_consent_required");
  await expect(db.exec("update session_requests set gallery_access_consented=true")).rejects.toThrow("gallery_consent_immutable");
  await activate();
  await expect(db.exec("update sessions set gallery_access_enabled=true")).rejects.toThrow("gallery_user_consent_required");
});
it("legacy gallery disable increments config version once so Android applies it", async () => {
  const a = await activate();
  await db.exec("alter table sessions disable trigger guard_gallery_consent");
  await db.query("update sessions set gallery_access_enabled=true where id=$1", [a.session.id]);
  await db.exec("alter table sessions enable trigger guard_gallery_consent");
  const sql = readFileSync("supabase/phase-audit-hardening-20261003.sql", "utf8");
  await db.exec(sql); await db.exec(sql);
  expect((await db.query("select gallery_access_enabled,config_version from sessions where id=$1", [a.session.id])).rows[0])
    .toEqual({ gallery_access_enabled: false, config_version: 2 });
});
it("anonymous and ordinary authenticated users cannot read private data or invoke service RPCs", async () => {
  try {
    await db.exec("set role anon");
    await expect(db.query("select * from devices")).rejects.toThrow("permission denied");
    await expect(activate()).rejects.toThrow("permission denied");
    await db.exec("reset role; set role authenticated");
    expect((await db.query("select * from subs")).rows).toEqual([]);
    await expect(db.exec("insert into subs(label) values('intruder')")).rejects.toThrow("permission denied");
    await expect(db.query("select set_lock_realtime_admin($1)",[sub])).rejects.toThrow("permission denied");
  } finally { await db.exec("reset role"); }
});
it("only the configured admin can use read-only realtime", async () => {
  await db.query("select set_lock_realtime_admin($1)", [sub]);
  await db.query("select set_config('app.uid',$1,false)",[sub]);
  try {
    await db.exec("set role authenticated");
    expect((await db.query("select label from subs")).rows).toEqual([{label:"Owner"}]);
    await expect(db.exec("update subs set label='other'")).rejects.toThrow("permission denied");
    await expect(db.query("select * from devices")).rejects.toThrow("permission denied");
  } finally { await db.exec("reset role; select set_config('app.uid','',false)"); }
});
it("multiple admin installations keep their own tokens", async () => {
  await db.query("insert into admin_push_tokens(admin_user_id,fcm_token) values($1,'phone'),($1,'companion')",[sub]);
  expect((await db.query("select * from admin_push_tokens")).rows).toHaveLength(2);
});
