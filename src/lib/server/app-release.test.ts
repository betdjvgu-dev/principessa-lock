import { describe, expect, it } from "vitest";
import { resolveAppReleaseDownloadUrl } from "./app-release";

describe("resolveAppReleaseDownloadUrl", () => {
  it("prefers a public GitHub Release asset", () => {
    expect(
      resolveAppReleaseDownloadUrl(
        {
          download_url:
            "https://github.com/example/principessa-lock-releases/releases/download/android-v1.0.0/principessa-lock.apk",
          storage_path: "android/principessa-lock-latest.apk",
        },
        "https://example.supabase.co",
      ),
    ).toContain("github.com/example/principessa-lock-releases/releases/download/");
  });

  it("falls back to the legacy Supabase Storage object", () => {
    expect(
      resolveAppReleaseDownloadUrl(
        {
          download_url: null,
          storage_path: "android/principessa lock.apk",
        },
        "https://example.supabase.co/",
      ),
    ).toBe(
      "https://example.supabase.co/storage/v1/object/public/app-releases/android/principessa%20lock.apk",
    );
  });

  it("rejects arbitrary redirect targets", () => {
    expect(
      resolveAppReleaseDownloadUrl(
        {
          download_url: "https://malicious.example/app.apk",
          storage_path: null,
        },
        "https://example.supabase.co",
      ),
    ).toBeNull();
  });
});
