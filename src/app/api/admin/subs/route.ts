import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type SubRow = {
  created_at: string;
  id: string;
  label: string;
  status: string;
};

type CreateSubInput = {
  label: string;
};

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

export async function POST(request: Request) {
  const rateLimitError = await enforceAdminRateLimit(request, "subs:create");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const bodyResult = await readJsonBody<CreateSubInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const label = typeof bodyResult.data.label === "string" ? bodyResult.data.label.trim() : "";

  if (!label) {
    return jsonError(400, "label is required.");
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("subs")
    .insert({ label, status: "invited" })
    .select("id, label, status, created_at")
    .single<SubRow>();

  if (error) {
    return jsonSupabaseError("Failed to create sub.", error);
  }

  return jsonOk({ ok: true, sub: data }, { status: 201 });
}
