import { expect, test } from "bun:test";
import { targetUrlProblem } from "../apps/web/lib/endpoint-target";

test("target URL shape validation rejects non-HTTP(S), credentials, fragments and non-URLs", () => {
  expect(targetUrlProblem("")).toBe("Enter a valid absolute URL, for example https://api.example.com/health.");
  expect(targetUrlProblem("not a url")).toBe("Enter a valid absolute URL, for example https://api.example.com/health.");
  expect(targetUrlProblem("ftp://api.example.com/health")).toBe("Only HTTP(S) targets can be monitored.");
  expect(targetUrlProblem("file:///etc/passwd")).toBe("Only HTTP(S) targets can be monitored.");
  expect(targetUrlProblem("https://user:pass@api.example.com/health")).toBe("URLs with embedded credentials are not allowed.");
  expect(targetUrlProblem("https://api.example.com/health#frag")).toBe("Remove the fragment (#…) from the target URL.");
});

test("target URL shape validation accepts plain HTTP(S) URLs; egress policy stays server-side", () => {
  expect(targetUrlProblem("https://api.example.com/health")).toBeNull();
  expect(targetUrlProblem("https://api.example.com:8443/health?x=1")).toBeNull();
  expect(targetUrlProblem("http://127.0.0.1:4101/health")).toBeNull(); // loopback mock stays a server decision
});
