import { jsonError, jsonOk } from "@/lib/server/api-response";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { validateSessionRequestInput, readJsonBody, type SessionRequestInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type CreateSessionRequestRow = {
  id: string;
  status: string;
};

function buildInsertPayload(input: SessionRequestInput) {
  return {
    daily_limit_minutes: input.dailyLimitMinutes,
    device_name: input.deviceName,
    forced_sleep_enabled: input.forcedSleepEnabled,
    requested_days: input.sessionDays,
  };
}

export async function POST(request: Request) {
  const rateLimitError = enforceRateLimit({
    errorMessage: "Too many session request attempts. Please wait before trying again.",
    limit: 10,
    request,
    routeKey: "session-requests:create",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const bodyResult = await readJsonBody<SessionRequestInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validateSessionRequestInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("session_requests")
    .insert(buildInsertPayload(validation.data))
    .select("id, status")
    .single<CreateSessionRequestRow>();

  if (error) {
    return jsonSupabaseError("Failed to create session request.", error);
  }

  return jsonOk(
    {
      ok: true,
      request: {
        id: data.id,
        status: data.status,
      },
    },
    { status: 201 },
  );
}

export function GET() {
  return jsonError(405, "Method not allowed.");
}
