import { describe, expect, it } from "vitest";
import { chunks, readAllPages } from "./read-pages";

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
});
