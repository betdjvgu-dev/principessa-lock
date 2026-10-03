const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function validateApkBadging(text, versionCode, versionName) {
  if (/^application-debuggable\s*$/m.test(text)) throw new Error("Refusing to publish a debuggable APK. Build assembleRelease instead.");
  const pkg = text.match(/^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m);
  if (!pkg || pkg[1] !== "com.principessa.lock" || Number(pkg[2]) !== versionCode || pkg[3] !== versionName) {
    throw new Error("APK package/version does not match the requested release metadata.");
  }
}

function checkReleaseApk(apk, versionCode, versionName, env = process.env) {
  const propsPath = path.resolve(__dirname, "../../principessa-lock/local.properties");
  const props = fs.existsSync(propsPath) ? fs.readFileSync(propsPath,"utf8") : "";
  const localSdk = props.match(/^sdk\.dir=(.+)$/m)?.[1]?.trim().replace(/\\:/g,":").replace(/\\\\/g,"\\");
  const sdk = env.ANDROID_SDK_ROOT || env.ANDROID_HOME || localSdk;
  if (!sdk) throw new Error("Android SDK is required to validate a release APK.");
  const root = path.join(sdk,"build-tools");
  const version = fs.readdirSync(root).filter(v => fs.existsSync(path.join(root,v,process.platform === "win32" ? "aapt.exe" : "aapt")))
    .sort((a,b) => b.localeCompare(a,undefined,{numeric:true}))[0];
  if (!version) throw new Error("Android SDK build-tools/aapt is missing.");
  const tools = path.join(root,version);
  validateApkBadging(execFileSync(path.join(tools, process.platform === "win32" ? "aapt.exe" : "aapt"),
    ["dump","badging",apk],{encoding:"utf8",maxBuffer:2_000_000}),versionCode,versionName);
  const java = env.JAVA_HOME ? path.join(env.JAVA_HOME,"bin",process.platform === "win32" ? "java.exe" : "java") : "java";
  const result = execFileSync(java,["-jar",path.join(tools,"lib","apksigner.jar"),"verify","--print-certs",apk],{encoding:"utf8"});
  const certificate = result.match(/certificate SHA-256 digest:\s*([a-f0-9]+)/i)?.[1]?.toLowerCase();
  const expected = env.ANDROID_RELEASE_CERT_SHA256?.replace(/:/g,"").trim().toLowerCase();
  if (!expected || !certificate || expected !== certificate) throw new Error("Set ANDROID_RELEASE_CERT_SHA256 to the installed release's signing certificate fingerprint. Key changes must not strand existing users.");
}
module.exports = { checkReleaseApk, validateApkBadging };
