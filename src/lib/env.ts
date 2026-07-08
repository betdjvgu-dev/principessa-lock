import "server-only";

type ServerEnv = {
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_URL: string;
};

let cachedEnv: ServerEnv | null = null;

function readRequiredEnv(name: keyof ServerEnv): string {
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
    SUPABASE_ANON_KEY: readRequiredEnv("SUPABASE_ANON_KEY"),
    SUPABASE_SERVICE_ROLE_KEY: readRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    SUPABASE_URL: readRequiredEnv("SUPABASE_URL"),
  };

  return cachedEnv;
}

