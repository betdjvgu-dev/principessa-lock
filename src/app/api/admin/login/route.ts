import { jsonError, jsonOk } from "@/lib/server/api-response";
import { getServerEnv, getSupabaseAnonKey } from "@/lib/env";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

type AdminLoginInput = {
  email: string;
  password: string;
};

export async function POST(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many login attempts. Please wait before trying again.",
    limit: 10,
    request,
    routeKey: "admin:login",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const bodyResult = await readJsonBody<AdminLoginInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const email = typeof bodyResult.data.email === "string" ? bodyResult.data.email.trim() : "";
  const password = typeof bodyResult.data.password === "string" ? bodyResult.data.password : "";

  if (!email || !password) {
    return jsonError(400, "email and password are required.");
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.session) {
    return jsonError(401, "Invalid email or password.");
  }

  const adminEmail = process.env.ADMIN_EMAIL;

  if (adminEmail && data.session.user.email?.toLowerCase() !== adminEmail.toLowerCase()) {
    return jsonError(403, "This account is not authorized as the admin.");
  }

  // The anon key is safe to hand back here (unlike the service-role key) -- it's meaningless
  // without a valid Supabase Auth JWT, and Row Level Security on the realtime-eligible tables
  // is what actually gates what this admin session can read. This lets the desktop admin open
  // its own Supabase Realtime connection instead of relying purely on backend REST polling.
  return jsonOk({
    ok: true,
    session: {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at ?? null,
    },
    supabase: {
      anonKey: getSupabaseAnonKey(),
      url: getServerEnv().SUPABASE_URL,
    },
  });
}
