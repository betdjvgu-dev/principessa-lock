import "server-only";

export type SessionRequestRow = {
  always_allowed_package: string | null;
  // Column name is a holdover from the old activation-code system (there's no code anymore --
  // approval just moves status to "approved" and the sub activates with a single tap), but it's
  // reused as-is to avoid a schema migration. It still means the same thing: how long an
  // approval stays valid before the request auto-expires if never activated.
  activation_code_expires_at: string | null;
  activated_at: string | null;
  approved_at: string | null;
  created_at: string;
  daily_limit_minutes: number;
  device_id: string | null;
  device_name: string;
  forced_sleep_enabled: boolean;
  full_discretion: boolean;
  gallery_access_enabled: boolean;
  id: string;
  rejected_at: string | null;
  requested_days: number;
  screen_time_enabled: boolean;
  status: "pending" | "approved" | "rejected" | "activated" | "expired";
  sub_id: string | null;
  updated_at: string;
};
