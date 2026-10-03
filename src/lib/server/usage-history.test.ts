import { expect, it } from "vitest";
import { validUsageHistory } from "./usage-history";
import { readJsonBody } from "./request-validation";
const row = {localDate:"2026-01-01",usedMinutes:65,dailyLimitMinutes:90};
it("bounds and validates offline history, including DST-length days", () => {
  expect(validUsageHistory([row,{...row,localDate:"2026-01-02",usedMinutes:1500}])).toBe(true);
  for (const value of [[row,row], [{...row,localDate:"2026-02-30"}], [{...row,usedMinutes:-1}],
    [{...row,usedMinutes:2881}], [{...row,localDate:"2999-01-01"}], Array(32).fill(row), {}]) {
    expect(validUsageHistory(value)).toBe(false);
  }
});
it("limits body size even when Content-Length is absent or forged", async () => {
  const request = new Request("http://localhost", {method:"POST",body:JSON.stringify({text:"x".repeat(100)})});
  const result = await readJsonBody(request, 50);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.response.status).toBe(413);
});
