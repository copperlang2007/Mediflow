import { describe, it, expect } from "vitest";
import { deferredJobId } from "../jobIds";

describe("deferredJobId", () => {
  it("is a stable UUID for a given job id", () => {
    const a = deferredJobId("7f1d2c3b-0000-4000-8000-000000000001");
    expect(a).toBe(deferredJobId("7f1d2c3b-0000-4000-8000-000000000001"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("differs between jobs", () => {
    expect(deferredJobId("job-a")).not.toBe(deferredJobId("job-b"));
  });
});
