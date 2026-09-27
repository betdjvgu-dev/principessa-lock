import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";

// Exercise the actual migration, not a JavaScript imitation of its transactions.
let db: PGlite;
const source = "10000000-0000-4000-8000-000000000001";
const device = "20000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64), secret = "b".repeat(64);
const details = {username:"new_owner",deviceName:"New phone",hardwareIdHash:"c".repeat(64),timezone:"Europe/Istanbul"};
async function rpc(name:string,args:unknown[]) {
  const r=await db.query<{value:Record<string,string>}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) as value`,args);
  return r.rows[0].value;
}
const issue=()=>rpc("issue_access_transfer",[device,hash,"device:test"]);
const claim=(input=details,credential=secret)=>rpc("claim_access_transfer",[hash,credential,JSON.stringify(input)]);
const decide=(id:string,approve=true)=>rpc("decide_access_transfer",[id,approve,"admin:test"]);
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.subs(id uuid primary key default gen_random_uuid(),label text not null,username text unique,status text not null default 'invited');
    create table public.devices(id uuid primary key default gen_random_uuid(),sub_id uuid references subs(id),device_name text unique not null,
      device_secret_hash text unique,device_secret_created_at timestamptz,device_secret_rotated_at timestamptz,hardware_id_hash text unique,
      timezone text,device_manufacturer text,device_model text,android_release text,android_sdk_int int,fcm_token text);
    create table public.sessions(id uuid primary key default gen_random_uuid(),device_id uuid references devices(id),status text);
    create table private_messages(id uuid primary key default gen_random_uuid(),sub_id uuid references subs(id),message text);
    create unique index subs_username_lower_key on subs(lower(username));
    create unique index devices_device_name_lower_key on devices(lower(device_name));`);
  await db.exec(readFileSync("supabase/phase-access-transfers-20260928.sql","utf8"));
  await db.exec(readFileSync("supabase/phase-access-transfers-20260928.sql","utf8"));
},60000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{
  await db.exec("truncate access_transfer_events,access_transfers,subs,devices,sessions,private_messages cascade");
  await db.query("insert into subs(id,label,username,status) values($1,'Owner','owner','active')",[source]);
  await db.query("insert into devices(id,sub_id,device_name,device_secret_hash,hardware_id_hash) values($1,$2,'Old phone',$3,$4)",[device,source,"d".repeat(64),"e".repeat(64)]);
});
it("claims do not grant access; approval transfers access once and retains old private history",async()=>{
  await db.query("insert into private_messages(sub_id,message) values($1,'private')",[source]);
  const t=await issue(), c=await claim();
  expect((await db.query("select status from subs where id=$1",[c.subId])).rows[0]).toEqual({status:"invited"});
  await decide(t.id);
  expect((await db.query("select status from subs where id=$1",[source])).rows[0]).toEqual({status:"archived"});
  expect((await db.query("select status from subs where id=$1",[c.subId])).rows[0]).toEqual({status:"active"});
  expect((await db.query("select device_secret_hash,access_revoked_at is not null as revoked from devices where id=$1",[device])).rows[0]).toEqual({device_secret_hash:null,revoked:true});
  expect((await db.query("select sub_id from private_messages")).rows[0]).toEqual({sub_id:source});
  await decide(t.id);
  expect((await db.query("select * from access_transfer_events where event_type='approved'")).rows).toHaveLength(1);
});
it("reject leaves source access intact and denies recipient",async()=>{
  const t=await issue(),c=await claim(); await decide(t.id,false);
  expect((await db.query("select status from subs where id=$1",[source])).rows[0]).toEqual({status:"active"});
  expect((await db.query("select status from subs where id=$1",[c.subId])).rows[0]).toEqual({status:"archived"});
  await expect(decide(t.id)).rejects.toThrow("transfer_already_decided");
});
it("ordinary registration approval cannot grant transfer access",async()=>{
  await issue(); const c=await claim();
  await expect(db.query("update subs set status='active' where id=$1",[c.subId])).rejects.toThrow("transfer_requires_approval");
});
it("an approved source cannot recover its secret or be reapproved",async()=>{
  const t=await issue();await claim();await decide(t.id);
  await expect(db.query("update devices set device_secret_hash=$1 where id=$2",[secret,device])).rejects.toThrow("transfer_credential_required");
  await expect(db.query("update subs set status='active' where id=$1",[source])).rejects.toThrow("transfer_source_revoked");
  await expect(db.query("insert into sessions(device_id,status) values($1,'active')",[device])).rejects.toThrow("transfer_source_unavailable");
});
it("active/paused source sessions prevent code generation and approval rechecks",async()=>{
  await db.query("insert into sessions(device_id,status) values($1,'active')",[device]);
  await expect(issue()).rejects.toThrow("transfer_active_session");
  await db.exec("delete from sessions");const t=await issue();await claim();
  await db.query("insert into sessions(device_id,status) values($1,'active')",[device]);
  await expect(decide(t.id)).rejects.toThrow("transfer_active_session");
  expect((await db.query("select status from access_transfers")).rows[0]).toEqual({status:"pending"});
});
it("a pending recipient cannot activate a session",async()=>{
  await issue();const c=await claim();
  await expect(db.query("insert into sessions(device_id,status) values($1,'active')",[c.deviceId])).rejects.toThrow("transfer_source_unavailable");
});
it("expiry is enforced on claim and on approval",async()=>{
  const t=await issue();
  await db.exec("update access_transfers set expires_at=now()-interval '1 minute'");
  await expect(claim()).rejects.toThrow("transfer_invalid_code");
  await db.exec("update access_transfers set expires_at=now()+interval '1 hour'");await claim();
  await db.exec("update access_transfers set expires_at=now()-interval '1 minute'");
  await expect(decide(t.id)).rejects.toThrow("transfer_expired");
});
it("retries return only the same credential's claim; another credential cannot consume it",async()=>{
  const t=await issue(),c=await claim();
  expect(await claim()).toEqual(c);
  await expect(claim(details,"f".repeat(64))).rejects.toThrow("transfer_invalid_code");
  await decide(t.id);expect((await claim()).status).toBe("active");
  await expect(claim(details,"f".repeat(64))).rejects.toThrow("transfer_invalid_code");
});
it("one outstanding request per source; replacing an unclaimed code invalidates it",async()=>{
  await issue(); await rpc("issue_access_transfer",[device,"f".repeat(64),"admin:test"]);
  await expect(claim()).rejects.toThrow("transfer_invalid_code");
  await rpc("claim_access_transfer",["f".repeat(64),secret,JSON.stringify(details)]);
  await expect(issue()).rejects.toThrow("transfer_pending");
});
it("hardware recovery cannot rotate credentials after a transfer is issued or claimed",async()=>{
  await issue();const c=await claim();
  for(const id of [device,c.deviceId]) {
    await expect(db.query("update devices set device_secret_hash=$1 where id=$2",["f".repeat(64),id])).rejects.toThrow("transfer_credential_required");
    await expect(db.query("update devices set transfer_protected=false where id=$1",[id])).rejects.toThrow("transfer_credential_required");
  }
});
it.each(['rejected','expired'])("the same recipient credential can retry a %s invitation with a new code",async status=>{
  const t=await issue(),c=await claim();
  if(status==='rejected') await decide(t.id,false);
  else await db.exec("update access_transfers set expires_at=now()-interval '1 hour'");
  const next=await rpc("issue_access_transfer",[device,"f".repeat(64),"admin:test"]);
  await expect(rpc("claim_access_transfer",["f".repeat(64),"1".repeat(64),JSON.stringify(details)])).rejects.toThrow("transfer_existing_device");
  const retried=await rpc("claim_access_transfer",["f".repeat(64),secret,JSON.stringify(details)]);
  expect(retried.deviceId).toBe(c.deviceId);expect(retried.transferId).toBe(next.id);
  await decide(next.id);expect((await db.query("select status from subs where id=$1",[c.subId])).rows[0]).toEqual({status:"active"});
});
it.each(['approve','reject','expire'])("a stale transfer cannot %s a recipient owned by a newer transfer",async action=>{
  const old=await issue(),recipient=await claim();await decide(old.id,false);
  const next=await rpc("issue_access_transfer",[device,"f".repeat(64),"admin:test"]);
  await rpc("claim_access_transfer",["f".repeat(64),secret,JSON.stringify(details)]);
  // Model a stale historical owner independently of the current invitation.
  await db.query("update access_transfers set status='cancelled' where id=$1",[next.id]);
  await db.query("update access_transfers set status='pending' where id=$1",[old.id]);
  await db.query("update devices set fcm_token='keep-me' where id=$1",[recipient.deviceId]);
  if(action==='approve') await expect(decide(old.id)).rejects.toThrow('transfer_target_unavailable');
  if(action==='reject') await decide(old.id,false);
  if(action==='expire') {
    await db.query("update access_transfers set expires_at=now()-interval '1 minute' where id=$1",[old.id]);
    await rpc("issue_access_transfer",[device,"9".repeat(64),"admin:test"]);
  }
  expect((await db.query("select status,access_transfer_id from subs where id=$1",[recipient.subId])).rows[0])
    .toEqual({status:'invited',access_transfer_id:next.id});
  expect((await db.query("select fcm_token from devices where id=$1",[recipient.deviceId])).rows[0]).toEqual({fcm_token:'keep-me'});
});
it("existing devices cannot claim; failed claims roll back account creation",async()=>{
  await issue();await expect(claim({...details,hardwareIdHash:"e".repeat(64)})).rejects.toThrow("transfer_existing_device");
  await expect(claim({...details,deviceName:"Old phone"})).rejects.toThrow();
  await expect(claim({...details,username:"OWNER"})).rejects.toThrow();
  expect((await db.query("select * from subs")).rows).toHaveLength(1);
  expect((await db.query("select status from access_transfers")).rows[0]).toEqual({status:"issued"});
});
it("decision failure rolls back source revocation and audit",async()=>{
  const t=await issue();const c=await claim();
  await db.exec(`create function fail_target() returns trigger language plpgsql as $$ begin
    if new.username='new_owner' and new.status='active' then raise exception 'test_failure'; end if; return new; end $$;
    create trigger test_fail before update on subs for each row execute function fail_target();`);
  try { await expect(decide(t.id)).rejects.toThrow("test_failure"); }
  finally { await db.exec("drop trigger test_fail on subs; drop function fail_target()"); }
  expect((await db.query("select status from subs where id=$1",[source])).rows[0]).toEqual({status:"active"});
  expect((await db.query("select status from subs where id=$1",[c.subId])).rows[0]).toEqual({status:"invited"});
  expect((await db.query("select * from access_transfer_events where event_type='approved'")).rows).toHaveLength(0);
});
it("public roles cannot read the code hashes or execute transfer RPCs",async()=>{
  const t=await issue();
  for(const role of ['anon','authenticated']) {
    await db.exec(`set role ${role}`);
    try {
      await expect(db.query("select code_hash from public.access_transfers")).rejects.toThrow("permission denied");
      await expect(decide(t.id)).rejects.toThrow("permission denied");
      await expect(issue()).rejects.toThrow("permission denied");
      await expect(claim()).rejects.toThrow("permission denied");
    } finally { await db.exec("reset role"); }
  }
});
