#!/usr/bin/env node
// Publishes an Android APK as a public GitHub Release asset, then updates the Supabase
// app_releases metadata row. APK bytes never pass through Supabase Storage or Vercel.
//
// Usage:
//   npm run publish:android -- <path-to-apk> <versionCode> <versionName> ["release notes"]
//
// Required in backend/.env.local:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   GITHUB_RELEASE_REPOSITORY=owner/public-release-repository
//   GITHUB_RELEASE_TOKEN=<fine-grained token with Contents: Read and write for that repo>

const fs = require("fs");
const path = require("path");

function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) {
    return {};
  }

  const env = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function githubHeaders(token, contentType = "application/vnd.github+json") {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": contentType,
    "User-Agent": "principessa-lock-release-publisher",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubJson(url, options, expectedStatuses) {
  const response = await fetch(url, options);
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(
      `GitHub request failed (${response.status}): ${await response.text()}`,
    );
  }
  return response.status === 204 ? null : response.json();
}

async function getOrCreateRelease({ repository, tag, token, versionName, releaseNotes }) {
  const apiBase = `https://api.github.com/repos/${repository}`;
  const existingResponse = await fetch(
    `${apiBase}/releases/tags/${encodeURIComponent(tag)}`,
    { headers: githubHeaders(token) },
  );

  if (existingResponse.ok) {
    return existingResponse.json();
  }
  if (existingResponse.status !== 404) {
    throw new Error(
      `Failed to look up GitHub release (${existingResponse.status}): ${await existingResponse.text()}`,
    );
  }

  return githubJson(
    `${apiBase}/releases`,
    {
      body: JSON.stringify({
        body: releaseNotes ?? "",
        draft: false,
        name: `Principessa Lock ${versionName}`,
        prerelease: false,
        tag_name: tag,
      }),
      headers: githubHeaders(token),
      method: "POST",
    },
    [201],
  );
}

async function main() {
  const [apkPath, versionCodeRaw, versionName, releaseNotes] = process.argv.slice(2);

  if (!apkPath || !versionCodeRaw || !versionName) {
    console.error(
      'Usage: npm run publish:android -- <path-to-apk> <versionCode> <versionName> ["release notes"]',
    );
    process.exit(1);
  }

  const versionCode = Number.parseInt(versionCodeRaw, 10);
  if (!Number.isInteger(versionCode) || versionCode < 1) {
    throw new Error("versionCode must be a positive integer.");
  }

  const resolvedApkPath = path.resolve(apkPath);
  if (!fs.existsSync(resolvedApkPath)) {
    throw new Error(`APK not found at: ${resolvedApkPath}`);
  }

  const env = { ...loadEnvLocal(), ...process.env };
  const {
    GITHUB_RELEASE_REPOSITORY,
    GITHUB_RELEASE_TOKEN,
    SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_URL,
  } = env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from backend/.env.local",
    );
  }
  if (!GITHUB_RELEASE_REPOSITORY || !GITHUB_RELEASE_TOKEN) {
    throw new Error(
      "GITHUB_RELEASE_REPOSITORY / GITHUB_RELEASE_TOKEN missing from backend/.env.local",
    );
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(GITHUB_RELEASE_REPOSITORY)) {
    throw new Error("GITHUB_RELEASE_REPOSITORY must use the owner/repository format.");
  }

  const repository = await githubJson(
    `https://api.github.com/repos/${GITHUB_RELEASE_REPOSITORY}`,
    { headers: githubHeaders(GITHUB_RELEASE_TOKEN) },
    [200],
  );
  if (repository.private) {
    throw new Error(
      "The GitHub release repository is private. Android users need a public release repository to download without a GitHub token.",
    );
  }

  const tag = `android-v${versionName}`;
  const assetName = `principessa-lock-${versionName}.apk`;
  const release = await getOrCreateRelease({
    releaseNotes,
    repository: GITHUB_RELEASE_REPOSITORY,
    tag,
    token: GITHUB_RELEASE_TOKEN,
    versionName,
  });

  const existingAsset = release.assets?.find((asset) => asset.name === assetName);
  if (existingAsset) {
    console.log(`Replacing existing GitHub asset ${assetName}...`);
    await githubJson(
      `https://api.github.com/repos/${GITHUB_RELEASE_REPOSITORY}/releases/assets/${existingAsset.id}`,
      { headers: githubHeaders(GITHUB_RELEASE_TOKEN), method: "DELETE" },
      [204],
    );
  }

  const apkBytes = fs.readFileSync(resolvedApkPath);
  console.log(
    `Uploading ${(apkBytes.length / 1024 / 1024).toFixed(1)} MB to GitHub Release ${tag}...`,
  );
  const uploadBase = release.upload_url.split("{", 1)[0];
  const uploadedAsset = await githubJson(
    `${uploadBase}?name=${encodeURIComponent(assetName)}`,
    {
      body: apkBytes,
      headers: githubHeaders(
        GITHUB_RELEASE_TOKEN,
        "application/vnd.android.package-archive",
      ),
      method: "POST",
    },
    [201],
  );

  const downloadUrl = uploadedAsset.browser_download_url;
  if (
    typeof downloadUrl !== "string" ||
    !downloadUrl.startsWith(
      `https://github.com/${GITHUB_RELEASE_REPOSITORY}/releases/download/`,
    )
  ) {
    throw new Error("GitHub did not return a valid public release download URL.");
  }

  console.log("GitHub upload complete. Updating app_releases metadata...");
  const metadataResponse = await fetch(`${SUPABASE_URL}/rest/v1/app_releases`, {
    body: JSON.stringify({
      download_url: downloadUrl,
      platform: "android",
      release_notes: releaseNotes ?? null,
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
    const error = await metadataResponse.text();
    throw new Error(
      `Metadata update failed (${metadataResponse.status}): ${error}\nApply supabase/phase-github-apk-distribution-20260718.sql first.`,
    );
  }

  console.log(
    `Published Android versionCode=${versionCode} versionName=${versionName}.`,
  );
  console.log(`GitHub asset: ${downloadUrl}`);
  console.log(
    "Stable app URL: <your backend base URL>/api/app-download?platform=android",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
