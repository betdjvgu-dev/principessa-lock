import { jsonError } from "@/lib/server/api-response";

type SupabaseLikeError = {
  code?: string;
  message: string;
};

export function jsonSupabaseError(message: string, error: SupabaseLikeError, status = 500) {
  // Only the Postgres error code (already checked explicitly by some routes, e.g. 23505)
  // is exposed to the client. The raw error message can contain column/constraint/schema
  // names, so it is logged server-side only.
  console.error(message, error);

  return jsonError(status, message, {
    code: error.code ?? null,
  });
}

