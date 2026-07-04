import "server-only";

import { generateActivationCode, hashActivationCode } from "@/lib/server/activation-codes";

export type SessionRequestRow = {
  activation_code_expires_at: string | null;
  activation_code_hash: string | null;
  activated_at: string | null;
  approved_at: string | null;
  created_at: string;
  daily_limit_minutes: number;
  device_name: string;
  forced_sleep_enabled: boolean;
  id: string;
  rejected_at: string | null;
  requested_days: number;
  status: "pending" | "approved" | "rejected" | "activated" | "expired";
  updated_at: string;
};

export async function generateUniqueActivationCode(
  supabase: any,
) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const activationCode = generateActivationCode();
    const activationCodeHash = hashActivationCode(activationCode);
    const { data, error } = await supabase
      .from("session_requests")
      .select("id")
      .eq("activation_code_hash", activationCodeHash)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return {
        activationCode,
        activationCodeHash,
      };
    }
  }

  throw new Error("Unable to generate a unique activation code.");
}
