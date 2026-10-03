import { createRequire } from "node:module";
import { expect, it } from "vitest";
const { validateApkBadging } = createRequire(import.meta.url)("../../../scripts/apk-release-check.js");
const good = "package: name='com.principessa.lock' versionCode='39' versionName='1.3.12'";
it("publication fails closed for debug, malformed, or mismatched APK metadata", () => {
  expect(() => validateApkBadging(good,39,"1.3.12")).not.toThrow();
  for (const text of [good+"\napplication-debuggable", "", good.replace("39","40"),good.replace("com.principessa.lock","other.app")]) {
    expect(() => validateApkBadging(text,39,"1.3.12")).toThrow();
  }
});
