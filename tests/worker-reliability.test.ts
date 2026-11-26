import { expect, test } from "bun:test";
import { isRetryableFailure, retryDelayMs, type Failure } from "../apps/worker/src/jobs";

const failure = (code: Failure["code"], httpStatus: number | null = null): Failure => ({ code, httpStatus });

test("only transient failures are retryable; permanent errors never replay a paid call", () => {
  // Transient: timeouts, network/DNS, lease expiry, HTTP 429 and 5xx.
  for (const transient of [
    failure("provider_timeout"),
    failure("provider_network"),
    failure("dns_failed"),
    failure("worker_lease_expired"),
    failure("provider_http", 429),
    failure("provider_http", 500),
    failure("provider_http", 503),
  ]) expect(isRetryableFailure(transient)).toBe(true);

  // Permanent: configuration, credentials, blocked egress, invalid responses, 4xx.
  for (const permanent of [
    failure("provider_changed"),
    failure("provider_disabled"),
    failure("provider_unavailable"),
    failure("credential_unavailable"),
    failure("provider_invalid_response"),
    failure("provider_response_too_large"),
    failure("provider_redirect"),
    failure("provider_configuration"),
    failure("invalid_endpoint"),
    failure("endpoint_not_public"),
    failure("provider_http", 400),
    failure("provider_http", 401),
    failure("provider_http", 403),
    failure("provider_http", 404),
    failure("provider_http", null),
  ]) expect(isRetryableFailure(permanent)).toBe(false);
});

test("retry backoff grows exponentially per failed attempt and is capped", () => {
  expect(retryDelayMs(5_000, 1)).toBe(5_000);
  expect(retryDelayMs(5_000, 2)).toBe(10_000);
  expect(retryDelayMs(5_000, 3)).toBe(20_000);
  expect(retryDelayMs(5_000, 4)).toBe(40_000);
  expect(retryDelayMs(200_000, 4)).toBe(300_000); // capped
  expect(retryDelayMs(0, 1)).toBe(0); // injectable to zero for fast tests
  expect(retryDelayMs(5_000, 0)).toBe(5_000); // attempts are 1-based
});
