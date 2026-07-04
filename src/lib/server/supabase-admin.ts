import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getServerEnv } from "@/lib/env";

let cachedClient: SupabaseClient<any, "public", any> | null = null;

export function getSupabaseAdminClient() {
  if (cachedClient) {
    return cachedClient;
  }

  const { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } = getServerEnv();

  cachedClient = createClient<any>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return cachedClient;
}
