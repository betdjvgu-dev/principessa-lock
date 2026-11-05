import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";

let db: PGlite;
const migration = readFileSync("supabase/phase-access-licenses-20261105.sql", "utf8");
const sharedMigration = readFileSync("../docs/sql/vault-court-lock-licenses-20261105.sql", "utf8");
const owner = "10000000-0000-4000-8000-000000000001";
const phone = "20000000-0000-4000-8000-000000000001";
const license = "30000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64), otherHash = "b".repeat(64), code = "PLCK-1234-5678-ABCD-EFGH";
const details = { username: "new_user", deviceName: "New phone", hardwareIdHash: "c".repeat(64), timezone: "Europe/Istanbul", androidSdkInt: 36 };
async function rpc(name: string, args: unknown[]) {
  return (await db.query<{ value: Record<string, string> }>(
    `select ${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as value`, args)).rows[0].value;
}
const claim = (credentialHash = hash, activationCode = code) => rpc("exchange_lock_license", [JSON.stringify({ action: "claim", code: activationCode, credentialHash })]);
const activate = (credentialHash = hash, input = details) => rpc("activate_lock_access_license", [license, credentialHash, JSON.stringify(input)]);
const sync = (overrides: Record<string, unknown> = {}) => rpc("exchange_lock_license", [JSON.stringify({
  action: "sync", licenseId: license, revision: 0, holderId: owner, username: "owner", deviceName: "Phone", ...overrides,
})]);
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table subs(id uuid primary key default gen_random_uuid(),label text not null,username text unique,status text not null default 'invited');
    create table devices(id uuid primary key default gen_random_uuid(),sub_id uuid references subs(id),device_name text unique not null,
      platform text,device_secret_hash text unique,device_secret_created_at timestamptz,device_secret_rotated_at timestamptz,hardware_id_hash text unique,
      timezone text,device_manufacturer text,device_model text,android_release text,android_sdk_int int,fcm_token text);
    create table sessions(id uuid primary key default gen_random_uuid(),device_id uuid references devices(id),status text);
    create table private_messages(id uuid primary key default gen_random_uuid(),sub_id uuid references subs(id),message text);
    create unique index subs_username_lower_key on subs(lower(username));
    create unique index devices_device_name_lower_key on devices(lower(device_name));
    create table app_activation_codes(id uuid primary key default gen_random_uuid(),app_key text not null,activation_code text not null unique,
      status text not null default 'active' check(status in ('active','revoked')),owner_name text unique,notes text,bound_installation_id text,
      bound_device_label text,bound_at timestamptz,last_validated_at timestamptz,updated_at timestamptz default now());
    create table app_activation_events(id uuid primary key default gen_random_uuid(),activation_id uuid references app_activation_codes(id),
      app_key text,event_type text check(event_type in ('generated','activated','validated','reinstalled','rejected','reset','revoked')),metadata jsonb);
  `);
  await db.exec(readFileSync("supabase/phase-access-transfers-20260928.sql", "utf8"));
  await db.exec(migration);
  await db.exec(sharedMigration);
}, 60_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("truncate access_transfer_events,access_transfers,lock_access_licenses,lock_legacy_access_candidates,lock_license_migrations,subs,devices,sessions,private_messages,app_activation_events,app_activation_codes cascade");
  await db.query("insert into subs(id,label,username,status) values($1,'Owner','owner','active')", [owner]);
  await db.query("insert into devices(id,sub_id,device_name,device_secret_hash,hardware_id_hash) values($1,$2,'Old phone',$3,$4)", [phone, owner, "d".repeat(64), "e".repeat(64)]);
  await db.exec(migration);
  await db.query("insert into app_activation_codes(id,app_key,activation_code) values($1,'principessa-lock',$2)", [license, code]);
});
it("grandfathers approved users without changing their credentials, sessions or history; reruns are idempotent", async () => {
  await db.query("insert into sessions(device_id,status) values($1,'active')", [phone]);
  await db.query("insert into private_messages(sub_id,message) values($1,'private')", [owner]);
  const before = (await db.query("select access_license_id from subs where id=$1", [owner])).rows[0];
  await db.exec(migration);
  expect((await db.query("select access_license_id from subs where id=$1", [owner])).rows[0]).toEqual(before);
  expect((await db.query("select * from lock_access_licenses")).rows).toHaveLength(1);
  expect((await db.query("select device_secret_hash from devices where id=$1", [phone])).rows[0]).toEqual({ device_secret_hash: "d".repeat(64) });
  expect((await db.query("select status from sessions")).rows[0]).toEqual({ status: "active" });
  expect((await db.query("select message from private_messages")).rows[0]).toEqual({ message: "private" });
});
it("pending registrations get no entitlement until explicit admin approval, even during rollout", async () => {
  const s = (await db.query<{ id: string }>("insert into subs(label,username) values('Pending','pending') returning id")).rows[0].id;
  await db.query("insert into devices(sub_id,device_name,device_secret_hash) values($1,'Pending phone',$2)", [s, hash]);
  await db.exec(migration);
  expect((await db.query("select access_license_id from subs where id=$1", [s])).rows[0]).toEqual({ access_license_id: null });
  await db.query("update subs set status='active' where id=$1", [s]);
  expect((await db.query("select * from lock_access_licenses where current_sub_id=$1", [s])).rows).toHaveLength(1);
});
it("claim and activation retries are idempotent; different credentials cannot reuse a code", async () => {
  expect((await claim()).licenseId).toBe(license);
  expect((await claim(otherHash)).error).toBe("bound_elsewhere");
  const active = await activate();
  expect(await activate()).toEqual(active);
  expect((await claim()).licenseId).toBe(license);
  await expect(activate(otherHash)).rejects.toThrow("license_bound_elsewhere");
  expect((await db.query("select * from subs where username='new_user'")).rows).toHaveLength(1);
  expect((await db.query("select * from app_activation_events where event_type='activated'")).rows).toHaveLength(1);
});
it("an old pending registration can redeem a code without creating another identity or legacy entitlement", async () => {
  const sub = (await db.query<{ id: string }>("insert into subs(label,username) values('Pending','pending') returning id")).rows[0].id;
  const device = (await db.query<{ id: string }>("insert into devices(sub_id,device_name,device_secret_hash,hardware_id_hash) values($1,'Pending phone',$2,$3) returning id", [sub, hash, details.hardwareIdHash])).rows[0].id;
  await db.query("insert into lock_legacy_access_candidates values($1)", [sub]);
  await claim();
  const activated = await activate();
  expect(activated).toMatchObject({ subId: sub, deviceId: device, status: "active" });
  expect((await db.query("select source from lock_access_licenses where current_sub_id=$1", [sub])).rows).toEqual([{ source: "code" }]);
});
it("legacy accounts approved before credential recovery attach only after a valid credential exists", async () => {
  const sub = (await db.query<{ id: string }>("insert into subs(label,username) values('Recover','recover') returning id")).rows[0].id;
  await db.query("insert into devices(sub_id,device_name) values($1,'Recovery phone')", [sub]);
  await db.query("update subs set status='active' where id=$1", [sub]);
  expect((await db.query("select * from lock_access_licenses where current_sub_id=$1", [sub])).rows).toHaveLength(0);
  await db.query("update devices set device_secret_hash=$1 where sub_id=$2", [hash, sub]);
  await rpc("attach_legacy_lock_license", [sub]);
  expect((await db.query("select source from lock_access_licenses where current_sub_id=$1", [sub])).rows).toEqual([{ source: "legacy" }]);
});
it("a rejected registration is never grandfathered by reapplying migrations", async () => {
  await db.query("insert into subs(label,username,status) values('Rejected','rejected','archived')");
  await db.exec(migration);
  expect((await db.query("select access_license_id from subs where username='rejected'")).rows[0]).toEqual({ access_license_id: null });
});
it("a committed shared reservation survives local conflict without double accounts or extra payment", async () => {
  await claim();
  await expect(activate(hash, { ...details, username: "owner" })).rejects.toThrow();
  expect((await db.query("select * from lock_access_licenses where id=$1", [license])).rows).toHaveLength(0);
  expect((await claim()).licenseId).toBe(license);
  expect((await activate()).status).toBe("active");
});
it("known device metadata is not ownership proof and cannot steal an existing account", async () => {
  await claim();
  await expect(activate(hash, { ...details, hardwareIdHash: "e".repeat(64) })).rejects.toThrow("license_existing_device");
});
it("invalid/revoked/other-app codes cannot be claimed", async () => {
  expect((await claim(hash, "PLCK-INVALID-CODE-AAAA")).error).toBe("invalid_license");
  await db.query("update app_activation_codes set app_key='other-app' where id=$1", [license]);
  expect((await claim()).error).toBe("invalid_license");
  await db.query("update app_activation_codes set app_key='principessa-lock',status='revoked' where id=$1", [license]);
  expect((await claim()).error).toBe("invalid_license");
});
it("legacy sync is idempotent and never creates a redeemable code or a second lifetime grant", async () => {
  const l = (await db.query<{ id: string }>("select id from lock_access_licenses where current_sub_id=$1", [owner])).rows[0].id;
  expect((await sync({ licenseId: l, legacySubId: owner })).status).toBe("active");
  await sync({ licenseId: l, legacySubId: owner });
  const codes = (await db.query<{ activation_code: string }>("select activation_code from app_activation_codes where lock_legacy_sub_id=$1", [owner])).rows;
  expect(codes).toHaveLength(1);
  expect((await claim(hash, codes[0].activation_code)).error).toBe("invalid_license");
});
it("approved transfer moves the same code entitlement, preserves private history and blocks original-code reuse", async () => {
  await claim(); const active = await activate();
  await db.query("insert into private_messages(sub_id,message) values($1,'original private message')", [active.subId]);
  const t = await rpc("issue_access_transfer", [active.deviceId, otherHash, "admin:test"]);
  const target = await rpc("claim_access_transfer", [otherHash, "f".repeat(64), JSON.stringify({ ...details, username: "recipient", deviceName: "Recipient phone", hardwareIdHash: "9".repeat(64) })]);
  await rpc("decide_access_transfer", [t.id, true, "admin:test"]);
  const l = (await db.query("select current_sub_id,revision from lock_access_licenses where id=$1", [license])).rows[0];
  expect(l).toEqual({ current_sub_id: target.subId, revision: 1 });
  expect((await db.query("select sub_id from private_messages")).rows[0]).toEqual({ sub_id: active.subId });
  await expect(activate()).rejects.toThrow("license_bound_elsewhere");
  expect((await claim("f".repeat(64))).error).toBe("bound_elsewhere");
  await sync({ holderId: target.subId, revision: 1, username: "recipient" });
  await sync({ revision: 0, username: "stale_old_holder" });
  expect((await db.query("select bound_device_label from app_activation_codes where id=$1", [license])).rows[0]).toEqual({ bound_device_label: "recipient / Phone" });
});
it("active sessions prevent transfer and failed decisions do not change the entitlement", async () => {
  const t = await rpc("issue_access_transfer", [phone, otherHash, "admin:test"]);
  await rpc("claim_access_transfer", [otherHash, hash, JSON.stringify(details)]);
  await db.query("insert into sessions(device_id,status) values($1,'active')", [phone]);
  await expect(rpc("decide_access_transfer", [t.id, true, "admin:test"])).rejects.toThrow("transfer_active_session");
  expect((await db.query("select current_device_id from lock_access_licenses where current_sub_id=$1", [owner])).rows[0]).toEqual({ current_device_id: phone });
});
it("central revocation remains revoked on sync and neither public role can use either RPC", async () => {
  await claim(); await activate();
  await db.query("update app_activation_codes set status='revoked' where id=$1", [license]);
  expect((await sync()).status).toBe("revoked");
  for (const role of ["anon", "authenticated"]) {
    expect((await db.query("select has_function_privilege($1,'exchange_lock_license(jsonb)','EXECUTE') as allowed", [role])).rows[0]).toEqual({ allowed: false });
    expect((await db.query("select has_function_privilege($1,'activate_lock_access_license(uuid,text,jsonb)','EXECUTE') as allowed", [role])).rows[0]).toEqual({ allowed: false });
  }
});
it("sales migration updates only the existing Lock card to 20 PM and is repeatable", async () => {
  await db.exec("create table court_links(slug text primary key,app_key text,activation text,price_pm int,price text,action text,description text)");
  try {
    await db.exec("insert into court_links(slug,activation,price_pm) values('lock','approval',null),('wallpaper','code',10)");
    const sales = readFileSync("../docs/sql/court-enable-lock-sales-20261105.sql", "utf8");
    await db.exec(sales); await db.exec(sales);
    expect((await db.query("select app_key,activation,price_pm from court_links where slug='lock'")).rows[0])
      .toEqual({ app_key: "principessa-lock", activation: "code", price_pm: 20 });
    expect((await db.query("select price_pm from court_links where slug='wallpaper'")).rows[0]).toEqual({ price_pm: 10 });
    expect((await db.query("select * from court_links")).rows).toHaveLength(2);
  } finally { await db.exec("drop table court_links"); }
});
