import "server-only";

type ServerEnv = {
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_URL: string;
};

let cachedEnv: ServerEnv | null = null;
let cachedAnonKey: string | null = null;

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getServerEnv(): ServerEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  cachedEnv = {
    SUPABASE_SERVICE_ROLE_KEY: readRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    SUPABASE_URL: readRequiredEnv("SUPABASE_URL"),
  };

  return cachedEnv;
}

// Read independently from getServerEnv() -- only the admin login and supabase-config routes
// need this (to hand the desktop admin a Realtime-capable client config). Bundling it into the
// same all-or-nothing getServerEnv() read previously meant a missing SUPABASE_ANON_KEY broke
// every route that touches Supabase at all, not just the two that actually use the anon key.
export function getSupabaseAnonKey(): string {
  if (cachedAnonKey) {
    return cachedAnonKey;
  }

  cachedAnonKey = readRequiredEnv("SUPABASE_ANON_KEY");

  return cachedAnonKey;
}
