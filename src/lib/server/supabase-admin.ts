import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getServerEnv } from "@/lib/env";

let cachedClient: SupabaseClient<any, "public", any> | null = null;

function buildClient() {
  const { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } = getServerEnv();

  return createClient<any>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Shared service-role client for data access.
 *
 * Never call a sign-in method on this one (signInWithPassword, verifyOtp, refreshSession, ...).
 * supabase-js swaps the client's PostgREST Authorization header over to the signed-in user's JWT,
 * and because this instance is cached for the lifetime of the serverless container, every later
 * query from that container would silently run as `authenticated` instead of service_role --
 * which RLS turns into empty SELECT results and 42501 on writes, with no error at the call site.
 * Use createIsolatedSupabaseClient() for anything that establishes a session.
 */
export function getSupabaseAdminClient() {
  if (cachedClient) {
    return cachedClient;
  }

  cachedClient = buildClient();

  return cachedClient;
}

/**
 * A throwaway client for auth flows that sign a user in. It is never shared, so the session it
 * picks up dies with the request instead of contaminating unrelated queries.
 */
export function createIsolatedSupabaseClient() {
  return buildClient();
}
