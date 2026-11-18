import { expect, test } from "bun:test";
import { finitePercent, safeTool } from "../packages/contracts/src/index";
import { redact } from "../packages/ai/src/index";

test("only supported read-only diagnostics", () => {
  expect(safeTool("service_status")).toBe(true);
  expect(safeTool("execute_shell")).toBe(false);
});

test("reject nonfinite or out-of-range metrics", () => {
  expect(finitePercent(30)).toBe(true);
  expect(finitePercent(NaN)).toBe(false);
  expect(finitePercent(-1)).toBe(false);
  expect(finitePercent(101)).toBe(false);
});

test("redact obvious credentials", () => {
  expect(redact("token=secret password=abc")).not.toContain("token=secret");
  expect(redact("Authorization: Bearer abc123")).not.toContain("abc123");
});
