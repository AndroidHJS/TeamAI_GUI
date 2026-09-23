import { describe, expect, it } from "vitest";
import { parseAnsi } from "./ansi";

describe("parseAnsi", () => {
  it("maps supported SGR colors without producing markup", () => {
    expect(parseAnsi("\u001b[31merror\u001b[0m plain")).toEqual([
      { text: "error", className: "ansi-red", bold: false },
      { text: " plain", className: undefined, bold: false },
    ]);
  });

  it("drops OSC links and unsafe control sequences", () => {
    const result = parseAnsi("safe\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007\u001b[2J");
    expect(result.map((part) => part.text).join("")).toBe("safelink");
  });
});

