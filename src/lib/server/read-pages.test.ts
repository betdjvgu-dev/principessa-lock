import { describe, expect, it, vi } from "vitest";
import { chunks, readAllPages } from "./read-pages";
import { isTransientReadError } from "./transient-read-error";

describe("status pagination", () => {
  it("keeps quiet devices beyond 1000 rows, even with a lower server cap", async () => {
    const devices = Array.from({ length: 1201 }, (_, id) => ({ id }));
    const result = await readAllPages(async (from) => ({ data: devices.slice(from, from + 80), error: null }));
    expect(result.data).toEqual(devices);
  });
  it("does not return a misleading partial success on a failed page", async () => {
    const result = await readAllPages(async (from) => from === 0
      ? { data: [1], error: null } : { data: null, error: "offline" });
    expect(result).toEqual({ data: [], error: "offline" });
  });
  it("bounds identity query sizes", () => {
    expect(chunks(Array.from({ length: 401 }, (_, i) => i)).map((p) => p.length)).toEqual([200, 200, 1]);
  });
  it("retries the failed offset without dropping or duplicating earlier rows", async () => {
    const offsets: number[] = [];
    const result = await readAllPages(async (from) => {
      offsets.push(from);
      if (offsets.length === 2) return { data: null, error: { code: "", message: "TypeError: fetch failed" }, status: 0 };
      return { data: from < 2 ? [from] : [], error: null, status: 200 };
    });
    expect(result).toEqual({ data: [0, 1], error: null });
    expect(offsets).toEqual([0, 1, 1, 2]);
  });
  it("bounds retries and does not disguise an ongoing outage as an empty list", async () => {
    const error = { code: "PGRST003", message: "Pool timeout" };
    const fetchPage = vi.fn(async () => ({ data: null, error }));
    expect(await readAllPages(fetchPage)).toEqual({ data: [], error });
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });
  it("does not retry permanent schema or permission errors", async () => {
    for (const code of ["42703", "42501", "PGRST204", "PGRST103"]) {
      const error = { code, message: "Permanent error" };
      const fetchPage = vi.fn(async () => ({ data: null, error }));
      expect(await readAllPages(fetchPage)).toEqual({ data: [], error });
      expect(fetchPage).toHaveBeenCalledTimes(1);
    }
    expect(isTransientReadError({ message: "Bad gateway" }, 502)).toBe(true);
    expect(isTransientReadError({ message: "Unauthorized" }, 401)).toBe(false);
  });
});
