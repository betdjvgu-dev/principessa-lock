export type OwnSessionRequestRow = {
  id: string;
  status: string;
  device_name: string;
  requested_days: number;
  daily_limit_minutes: number;
  screen_time_enabled: boolean;
  always_allowed_package: string | null;
  forced_sleep_enabled: boolean;
  gallery_access_enabled: boolean;
  full_discretion: boolean;
  activation_code_expires_at: string | null;
};

export function ownSessionRequest(row: OwnSessionRequestRow, now = Date.now()) {
  const expired = row.status === "approved" && row.activation_code_expires_at !== null &&
    Date.parse(row.activation_code_expires_at) <= now;
  return {
    id: row.id,
    status: expired ? "expired" : row.status,
    settings: {
      deviceName: row.device_name,
      sessionDays: row.requested_days,
      dailyLimitMinutes: row.daily_limit_minutes,
      screenTimeEnabled: row.screen_time_enabled,
      alwaysAllowedPackage: row.always_allowed_package,
      forcedSleepEnabled: row.forced_sleep_enabled,
      galleryAccessEnabled: row.gallery_access_enabled,
      fullDiscretion: row.full_discretion,
    },
  };
}
