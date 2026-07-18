type AppReleaseLocation = {
  download_url: string | null;
  storage_path: string | null;
};

function validGitHubReleaseUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      url.pathname.includes("/releases/download/")
    );
  } catch {
    return false;
  }
}

export function resolveAppReleaseDownloadUrl(
  release: AppReleaseLocation,
  supabaseUrl: string,
) {
  const downloadUrl = release.download_url?.trim();
  if (downloadUrl && validGitHubReleaseUrl(downloadUrl)) {
    return downloadUrl;
  }

  const storagePath = release.storage_path?.trim();
  if (!storagePath) {
    return null;
  }

  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/app-releases/${storagePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}
