-- LOCK database only, after phase-license-reliability-20261105.sql.
-- Keep the persisted cross-instance lease in sync with the backend's 30m policy.
begin;
create or replace function public.begin_lock_license_check(p_license uuid,p_sub uuid,p_device uuid,p_revision integer)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.lock_access_licenses set next_validation_attempt_at=clock_timestamp()+interval '30 seconds'
    where id=p_license and current_sub_id=p_sub and current_device_id=p_device and revision=p_revision and status='active'
      and (next_validation_attempt_at is null or next_validation_attempt_at<=clock_timestamp())
      and (last_validated_at is null or last_validated_at<=clock_timestamp()-interval '30 minutes');
  return found;
end $$;
revoke all on function public.begin_lock_license_check(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.begin_lock_license_check(uuid,uuid,uuid,integer) to service_role;
commit;
