#!/usr/bin/env node
// Publishes a new Android APK release: uploads the APK straight to Supabase Storage (bypassing
// Vercel's ~4.5MB serverless request-body limit entirely, since it never goes through a Next.js
// route) at a *fixed* object path, then upserts the app_releases metadata row. The download URL
// the app uses (/api/app-download) never changes across releases -- only what this script
// uploads changes.
//
// Usage:
//   node scripts/publish-android-release.js <path-to-apk> <versionCode> <versionName> ["release notes"]
//
// Requires backend/.env.local to have SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set.

const fs = require("fs");
const path = require("path");

function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  const env = {};
  for (const line of lines) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) {
      continue;
    }
    const idx = line.indexOf("=");
    env[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return env;
}

async function main() {
  const [apkPath, versionCodeRaw, versionName, releaseNotes] = process.argv.slice(2);

  if (!apkPath || !versionCodeRaw || !versionName) {
    console.error("Usage: node scripts/publish-android-release.js <path-to-apk> <versionCode> <versionName> [\"release notes\"]");
    process.exit(1);
  }

  const versionCode = Number.parseInt(versionCodeRaw, 10);
  if (!Number.isInteger(versionCode) || versionCode < 1) {
    console.error("versionCode must be a positive integer.");
    process.exit(1);
  }

  const resolvedApkPath = path.resolve(apkPath);
  if (!fs.existsSync(resolvedApkPath)) {
    console.error(`APK not found at: ${resolvedApkPath}`);
    process.exit(1);
  }

  const env = loadEnvLocal();
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from backend/.env.local");
    process.exit(1);
  }

  const storagePath = "android/principessa-lock-latest.apk";
  const apkBytes = fs.readFileSync(resolvedApkPath);

  console.log(`Uploading ${resolvedApkPath} (${(apkBytes.length / 1024 / 1024).toFixed(1)} MB) -> ${storagePath} ...`);

  const uploadResponse = await fetch(
    `${SUPABASE_URL}/storage/v1/object/app-releases/${storagePath}`,
    {
      body: apkBytes,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/vnd.android.package-archive",
        "x-upsert": "true",
      },
      method: "POST",
    },
  );

  if (!uploadResponse.ok) {
    console.error(`Storage upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`);
    process.exit(1);
  }

  console.log("Upload complete. Updating app_releases metadata...");

  const metadataResponse = await fetch(`${SUPABASE_URL}/rest/v1/app_releases`, {
    body: JSON.stringify({
      platform: "android",
      release_notes: releaseNotes ?? null,
      storage_path: storagePath,
      updated_at: new Date().toISOString(),
      version_code: versionCode,
      version_name: versionName,
    }),
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    method: "POST",
  });

  if (!metadataResponse.ok) {
    console.error(`Metadata update failed: ${metadataResponse.status} ${await metadataResponse.text()}`);
    process.exit(1);
  }

  console.log(`Done. Published android versionCode=${versionCode} versionName=${versionName}.`);
  console.log("Stable download URL: <your backend base URL>/api/app-download?platform=android");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
