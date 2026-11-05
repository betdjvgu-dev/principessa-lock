import "server-only";
import { getSupabaseAdminClient } from "./supabase-admin";
import { AccessLicenseError, exchangeAccessLicense } from "./access-licenses";

export async function resetIncompleteActivation(licenseId: string, actor: string) {
  const claim = await exchangeAccessLicense({ action: "inspect_claim", licenseId });
  if (claim.status !== "active") throw new AccessLicenseError("unavailable");
  if (claim.credentialHash === null) return;
  if (typeof claim.credentialHash !== "string" || !/^[a-f0-9]{64}$/.test(claim.credentialHash)) throw new AccessLicenseError("unavailable");
  const { error } = await getSupabaseAdminClient().rpc("fence_incomplete_lock_activation", {
    p_license: licenseId, p_hash: claim.credentialHash, p_actor: actor,
  });
  if (error?.message === "license_already_activated") throw new AccessLicenseError("already_activated", 409);
  if (error) throw new AccessLicenseError("unavailable");
  // Fence commits BEFORE the central reset. If the network fails, repeating is safe.
  await exchangeAccessLicense({ action: "reset_claim", licenseId, credentialHash: claim.credentialHash });
}
