import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";

let db: PGlite;
const migration = readFileSync("supabase/phase-access-licenses-20261105.sql", "utf8");
const candidateDeleteFix = readFileSync("supabase/phase-access-candidate-delete-fix-20261105.sql", "utf8");
const reliabilityMigration = readFileSync("supabase/phase-license-reliability-20261105.sql", "utf8");
const claimRecoveryMigration = readFileSync("../docs/sql/vault-court-lock-claim-recovery-20261105.sql", "utf8");
const sharedMigration = readFileSync("../docs/sql/vault-court-lock-licenses-20261105.sql", "utf8");
const intervalMigration = readFileSync("supabase/phase-license-check-30m-20261105.sql", "utf8");
const syncWritesMigration = readFileSync("../docs/sql/vault-court-lock-sync-writes-20261105.sql", "utf8");
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
    create table devices(id uuid primary key default gen_random_uuid(),sub_id uuid references subs(id) on delete cascade,device_name text unique not null,
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
  await db.exec(reliabilityMigration);
  await db.exec(claimRecoveryMigration);
  await db.exec(intervalMigration);
  await db.exec(syncWritesMigration);
}, 60_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("truncate lock_activation_reset_fences,lock_reset_claims,access_transfer_events,access_transfers,lock_access_licenses,lock_legacy_access_candidates,lock_license_migrations,subs,devices,sessions,private_messages,app_activation_events,app_activation_codes cascade");
  await db.query("insert into subs(id,label,username,status) values($1,'Owner','owner','active')", [owner]);
  await db.query("insert into devices(id,sub_id,device_name,device_secret_hash,hardware_id_hash) values($1,$2,'Old phone',$3,$4)", [phone, owner, "d".repeat(64), "e".repeat(64)]);
  await db.exec(migration);
  await db.exec(reliabilityMigration);
  await db.query("insert into app_activation_codes(id,app_key,activation_code) values($1,'principessa-lock',$2)", [license, code]);
});
it("unchanged Vault syncs do not rewrite the row or add events; hourly validation and changed metadata still update", async () => {
  await claim();
  await sync();
  const row = async () => (await db.query("select ctid::text as tuple,last_validated_at,updated_at,bound_device_label from app_activation_codes where id=$1", [license])).rows[0];
  const first = await row();
  const events = (await db.query("select count(*)::int as n from app_activation_events")).rows;
  await sync();
  expect(await row()).toEqual(first);
  expect((await db.query("select count(*)::int as n from app_activation_events")).rows).toEqual(events);
  await db.query("update app_activation_codes set last_validated_at=now()-interval '31 minutes' where id=$1", [license]);
  const halfHour = await row();
  await sync();
  expect(await row()).toEqual(halfHour);
  await db.query("update app_activation_codes set last_validated_at=now()-interval '61 minutes' where id=$1", [license]);
  const stale = await row();
  await sync();
  const refreshed = await row();
  expect(refreshed.tuple).not.toBe(stale.tuple);
  expect(refreshed.last_validated_at).not.toEqual(stale.last_validated_at);
  expect(refreshed.updated_at).toEqual(stale.updated_at);
  await sync({ deviceName: "Renamed phone" });
  expect((await row()).bound_device_label).toBe("owner / Renamed phone");
  await db.query("update app_activation_codes set status='revoked' where id=$1", [license]);
  expect((await sync()).status).toBe("revoked");
});
it("incremental migrations are repeatable and preserve activated access; the SQL lease enforces 30 minutes", async () => {
  await claim();
  const active = await activate();
  await sync();
  const central = (await db.query("select * from app_activation_codes where id=$1", [license])).rows;
  const device = (await db.query("select * from devices where id=$1", [active.deviceId])).rows;
  for (let i = 0; i < 2; i++) {
    await db.exec(intervalMigration);
    await db.exec(syncWritesMigration);
  }
  expect((await db.query("select * from app_activation_codes where id=$1", [license])).rows).toEqual(central);
  expect((await db.query("select * from devices where id=$1", [active.deviceId])).rows).toEqual(device);
  const args = [license, active.subId, active.deviceId, 0];
  await db.query("update lock_access_licenses set last_validated_at=now()-interval '29 minutes' where id=$1", [license]);
  expect(await rpc("begin_lock_license_check", args)).toBe(false);
  await db.query("update lock_access_licenses set last_validated_at=now()-interval '30 minutes' where id=$1", [license]);
  expect(await rpc("begin_lock_license_check", args)).toBe(true);
  expect(await rpc("begin_lock_license_check", args)).toBe(false);
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
async function pendingCandidate(username: string) {
  const sub = (await db.query<{ id: string }>("insert into subs(label,username) values($1,$1) returning id", [username])).rows[0].id;
  await db.query("insert into devices(sub_id,device_name) values($1,$2)", [sub, `${username} phone`]);
  await db.query("insert into lock_legacy_access_candidates values($1)", [sub]);
  return sub;
}
it("repairs the deployed FK without deleting data and allows single pending rejection", async () => {
  await db.exec(`alter table lock_legacy_access_candidates drop constraint lock_legacy_access_candidates_sub_id_fkey;
    alter table lock_legacy_access_candidates add constraint lock_legacy_access_candidates_sub_id_fkey
    foreign key(sub_id) references subs(id);`);
  const sub = await pendingCandidate("single_pending");
  const reject = () => db.query("delete from subs where id=$1 and status='invited' and access_transfer_id is null returning id", [sub]);
  await expect(reject()).rejects.toMatchObject({ code: "23503" });
  await db.exec(candidateDeleteFix);
  await db.exec(candidateDeleteFix);
  expect((await db.query("select sub_id from lock_legacy_access_candidates where sub_id=$1", [sub])).rows).toHaveLength(1);
  expect((await db.query("select id from devices where sub_id=$1", [sub])).rows).toHaveLength(1);
  expect((await reject()).rows).toEqual([{ id: sub }]);
  expect((await db.query("select * from lock_legacy_access_candidates where sub_id=$1", [sub])).rows).toHaveLength(0);
  expect((await db.query("select * from devices where sub_id=$1", [sub])).rows).toHaveLength(0);
  await db.exec(migration);
  expect((await db.query("select * from lock_legacy_access_candidates where sub_id=$1", [sub])).rows).toHaveLength(0);
});
it("bulk rejection removes only selected pending registrations, preserving approvals and transfer targets", async () => {
  await db.exec(candidateDeleteFix);
  const first = await pendingCandidate("pending_first");
  const second = await pendingCandidate("pending_second");
  const later = await pendingCandidate("pending_later");
  const approved = await pendingCandidate("already_approved");
  await db.query("update devices set device_secret_hash=$1 where sub_id=$2", [hash, approved]);
  await db.query("update subs set status='active' where id=$1", [approved]);
  const transfer = await rpc("issue_access_transfer", [phone, otherHash, "admin:test"]);
  const target = await rpc("claim_access_transfer", [otherHash, "f".repeat(64), JSON.stringify(details)]);
  const result = await db.query<{ id: string }>(`delete from subs where id=any($1::uuid[])
    and status='invited' and access_transfer_id is null returning id`, [[first, second, approved, owner, target.subId]]);
  expect(result.rows.map(r => r.id).sort()).toEqual([first, second].sort());
  for (const sub of [approved, owner, later, target.subId]) {
    expect((await db.query("select id from subs where id=$1", [sub])).rows).toHaveLength(1);
  }
  expect((await db.query("select * from lock_access_licenses")).rows).toHaveLength(2);
  expect((await db.query("select status from access_transfers where id=$1", [transfer.id])).rows).toEqual([{ status: "pending" }]);
});
it("candidate cleanup never cascades into actual licenses; a protected deletion rolls back", async () => {
  await db.exec(candidateDeleteFix);
  await expect(db.query("delete from subs where id=$1", [owner])).rejects.toMatchObject({ code: "23503" });
  expect((await db.query("select id from subs where id=$1", [owner])).rows).toHaveLength(1);
  expect((await db.query("select sub_id from lock_legacy_access_candidates where sub_id=$1", [owner])).rows).toHaveLength(1);
  expect((await db.query("select current_device_id from lock_access_licenses where current_sub_id=$1", [owner])).rows).toEqual([{ current_device_id: phone }]);
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

it("an incomplete reservation can be reset without letting a delayed old activation steal the code", async () => {
  await claim();
  await expect(activate(hash, { ...details, username: "owner" })).rejects.toMatchObject({ code: "23505" });
  await rpc("fence_incomplete_lock_activation", [license, hash, "test-admin"]);
  const recoveryInput = { action: "reset_claim", licenseId: license, credentialHash: hash };
  expect((await rpc("recover_incomplete_lock_claim", [JSON.stringify(recoveryInput)])).ok).toBe(true);
  expect((await rpc("recover_incomplete_lock_claim", [JSON.stringify(recoveryInput)])).ok).toBe(true);
  await expect(activate()).rejects.toThrow("license_claim_reset");
  await expect(claim()).rejects.toThrow("license_claim_reset");
  expect((await claim(otherHash)).ok).toBe(true);
  expect((await activate(otherHash)).status).toBe("active");
  await expect(activate()).rejects.toThrow("license_claim_reset");
  expect((await db.query("select device_secret_hash from devices where sub_id=$1", [owner])).rows[0]).toEqual({ device_secret_hash: "d".repeat(64) });
});
it("a completed activation or transferred license cannot be fenced/reset", async () => {
  await claim(); const active = await activate();
  await db.query("update lock_access_licenses set next_validation_attempt_at=now()+interval '15 minutes',validation_failures=5,last_good_validation_at=now() where id=$1", [license]);
  await expect(rpc("fence_incomplete_lock_activation", [license, hash, "admin"])).rejects.toThrow("license_already_activated");
  const transfer = await rpc("issue_access_transfer", [active.deviceId, otherHash, "admin"]);
  const target = await rpc("claim_access_transfer", [otherHash, "f".repeat(64), JSON.stringify({ ...details, username: "recipient", deviceName: "Recipient", hardwareIdHash: "9".repeat(64) })]);
  await rpc("decide_access_transfer", [transfer.id, true, "admin"]);
  await expect(rpc("fence_incomplete_lock_activation", [license, hash, "admin"])).rejects.toThrow("license_already_activated");
  expect((await db.query("select current_sub_id from lock_access_licenses where id=$1", [license])).rows[0]).toEqual({ current_sub_id: target.subId });
  expect((await db.query("select next_validation_attempt_at,validation_failures,last_good_validation_at is not null as grace_preserved from lock_access_licenses where id=$1", [license])).rows[0])
    .toEqual({ next_validation_attempt_at: null, validation_failures: 0, grace_preserved: true });
  expect(await rpc("finish_lock_license_check", [license, active.subId, active.deviceId, 0, "revoked"])).toBe(false);
});
it("recovery refuses a changed claim and legacy access; public roles cannot invoke it", async () => {
  await claim();
  expect((await rpc("recover_incomplete_lock_claim", [JSON.stringify({ action: "reset_claim", licenseId: license, credentialHash: otherHash })])).error).toBe("claim_changed");
  await db.query("update app_activation_codes set lock_legacy_sub_id=$1 where id=$2", [owner, license]);
  expect((await rpc("recover_incomplete_lock_claim", [JSON.stringify({ action: "inspect_claim", licenseId: license })])).error).toBe("invalid_license");
  for (const role of ["anon", "authenticated"]) for (const fn of ["recover_incomplete_lock_claim(jsonb)",
    "fence_incomplete_lock_activation(uuid,text,text)", "finish_lock_license_check(uuid,uuid,uuid,integer,text)"]) {
    expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role,fn])).rows[0]).toEqual({ allowed: false });
  }
});
it("leases/backoff persist across workers and confirmed revocation ends only this device's sessions", async () => {
  await claim(); const active = await activate();
  await db.query("insert into sessions(device_id,status) values($1,'active'),($1,'completed'),($2,'active')", [active.deviceId, phone]);
  const args = [license, active.subId, active.deviceId, 0];
  expect(await rpc("begin_lock_license_check", args)).toBe(true);
  expect(await rpc("begin_lock_license_check", args)).toBe(false);
  await rpc("fail_lock_license_check", args);
  expect((await db.query("select validation_failures,status,last_validated_at from lock_access_licenses where id=$1", [license])).rows[0])
    .toEqual({ validation_failures: 1, status: "active", last_validated_at: null });
  expect(await rpc("begin_lock_license_check", args)).toBe(false);
  expect(await rpc("finish_lock_license_check", [...args, "revoked"])).toBe(true);
  expect((await db.query("select status from sessions where device_id=$1 order by status", [active.deviceId])).rows)
    .toEqual([{ status: "completed" }, { status: "revoked" }]);
  expect((await db.query("select status from sessions where device_id=$1", [phone])).rows).toEqual([{ status: "active" }]);
  expect((await db.query("select device_secret_hash from devices where id=$1", [active.deviceId])).rows[0]).toEqual({ device_secret_hash: hash });
  expect(await rpc("finish_lock_license_check", [...args, "active"])).toBe(false);
});
it("new display names do not expose internal handles, and repair preserves custom names and legacy accounts", async () => {
  await claim();
  const result = await activate(hash, { ...details, displayName: "Friendly phone" } as typeof details);
  expect((await db.query("select username,label from subs where id=$1", [result.subId])).rows[0])
    .toEqual({ username: "new_user", label: "Friendly phone" });
  await rpc("repair_lock_generated_label", [result.deviceId, "new_user"]);
  expect((await db.query("select label from subs where id=$1", [result.subId])).rows[0]).toEqual({ label: "Friendly phone" });
  await db.query("update subs set label=username where id=$1", [result.subId]);
  await rpc("repair_lock_generated_label", [result.deviceId, "new_user"]);
  expect((await db.query("select username,label from subs where id=$1", [result.subId])).rows[0]).toEqual({ username: "new_user", label: "New phone" });
  await rpc("repair_lock_generated_label", [phone, "owner"]);
  expect((await db.query("select label from subs where id=$1", [owner])).rows[0]).toEqual({ label: "Owner" });
  await db.exec(reliabilityMigration); await db.exec(claimRecoveryMigration);
  expect((await db.query("select device_secret_hash from devices where id=$1", [result.deviceId])).rows[0]).toEqual({ device_secret_hash: hash });
});
