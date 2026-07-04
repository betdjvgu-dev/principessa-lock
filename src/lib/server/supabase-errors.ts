import { jsonError } from "@/lib/server/api-response";

type SupabaseLikeError = {
  code?: string;
  message: string;
};

export function jsonSupabaseError(message: string, error: SupabaseLikeError, status = 500) {
  return jsonError(status, message, {
    code: error.code ?? null,
    message: error.message,
  });
}

