import { jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateDnsQueryLogInput, type DnsQueryLogInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

const MAX_STORED_ENTRIES = 50;

type StoredDnsQueryEntry = {
  blocked: boolean;
  domain: string;
  queriedAt: string;
};

export async function POST(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many DNS log reports. Please wait before trying again.",
    limit: 30,
    request,
    routeKey: "devices:dns-log",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const bodyResult = await readJsonBody<DnsQueryLogInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validateDnsQueryLogInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
  }

  if (validation.data.queries.length === 0) {
    return jsonOk({ ok: true });
  }

  const supabase = getSupabaseAdminClient();
  const deviceAuth = await requireAuthenticatedDevice(request, supabase);

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const { data: existingDevice, error: loadError } = await supabase
    .from("devices")
    .select("recent_dns_queries, dns_domain_query_counts")
    .eq("id", deviceAuth.device.id)
    .maybeSingle<{ recent_dns_queries: StoredDnsQueryEntry[] | null; dns_domain_query_counts: Record<string, number> | null }>();

  if (loadError) {
    return jsonSupabaseError("Failed to load existing DNS query log.", loadError);
  }

  const merged = [...(existingDevice?.recent_dns_queries ?? []), ...validation.data.queries].slice(-MAX_STORED_ENTRIES);

  // Unlike recent_dns_queries above (a small FIFO-trimmed window), this count map is never
  // trimmed by size -- it's what actually powers a "most visited websites" view, since 50
  // raw entries gets overwritten within a handful of page loads and can't reflect which
  // domains were visited most over the life of the session.
  const domainCounts = { ...(existingDevice?.dns_domain_query_counts ?? {}) };
  for (const query of validation.data.queries) {
    domainCounts[query.domain] = (domainCounts[query.domain] ?? 0) + 1;
  }

  const { error: updateError } = await supabase
    .from("devices")
    .update({ recent_dns_queries: merged, dns_domain_query_counts: domainCounts })
    .eq("id", deviceAuth.device.id);

  if (updateError) {
    return jsonSupabaseError("Failed to store DNS query log.", updateError);
  }

  return jsonOk({ ok: true });
}
