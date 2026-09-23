import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redaction";

describe("redactSecrets", () => {
  it("redacts every occurrence without changing unrelated output", () => {
    expect(redactSecrets("password=s3cr3t; retry s3cr3t", ["s3cr3t"]))
      .toBe("password=[REDACTED]; retry [REDACTED]");
  });
});
