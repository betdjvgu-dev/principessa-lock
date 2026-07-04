import { jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type PendingRequestRow = {
  approved_at: string | null;
  created_at: string;
  daily_limit_minutes: number;
  device_name: string;
  forced_sleep_enabled: boolean;
  id: string;
  requested_days: number;
  status: string;
};

export async function GET(request: Request) {
  const authError = verifyAdminRequest(request);

  if (authError) {
    return authError;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("session_requests")
    .select("id, device_name, requested_days, daily_limit_minutes, forced_sleep_enabled, status, created_at, approved_at")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .returns<PendingRequestRow[]>();

  if (error) {
    return jsonSupabaseError("Failed to load pending session requests.", error);
  }

  return jsonOk({
    ok: true,
    requests: data,
  });
}
