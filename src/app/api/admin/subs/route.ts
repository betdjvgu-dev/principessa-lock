import { jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type SubRow = {
  created_at: string;
  id: string;
  label: string;
  status: string;
};

// Subs are now created only via self-registration (/api/register) -- there is no admin-facing
// "create a sub" action anymore, so this route is read-only.
export async function GET(request: Request) {
  const rateLimitError = await enforceAdminRateLimit(request, "subs:list");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("subs")
    .select("id, label, status, created_at")
    .order("created_at", { ascending: false })
    .returns<SubRow[]>();

  if (error) {
    return jsonSupabaseError("Failed to load subs.", error);
  }

  return jsonOk({
    ok: true,
    subs: data,
  });
}
