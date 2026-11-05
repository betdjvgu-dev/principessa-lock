-- Apply to LOCK Supabase only, after phase-access-licenses-20261105.sql.
-- Does not delete any rows. License and transfer foreign keys remain restrictive.
begin;
alter table public.lock_legacy_access_candidates
  drop constraint if exists lock_legacy_access_candidates_sub_id_fkey;
alter table public.lock_legacy_access_candidates
  add constraint lock_legacy_access_candidates_sub_id_fkey
  foreign key (sub_id) references public.subs(id) on delete cascade;
commit;
