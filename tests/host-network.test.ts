import { describe, expect, test } from "bun:test";
import type { HostMetric } from "@opspilot/contracts";
import { deriveNetworkRates } from "../apps/web/lib/host-network";
const sample = (seconds: number, rx: number, tx: number): HostMetric => ({ sampled_at: new Date(seconds * 1000).toISOString(), cpu_percent: 0, memory_percent: 0, disk_percent: 0, network_rx_bytes: rx, network_tx_bytes: tx });
const a = sample(0, 1_000_000, 500_000), b = sample(15, 2_875_000, 1_437_500);
describe("network rates", () => {
  test("uses actual time and sorts without mutating", () => { const input = [b, a]; const rates = deriveNetworkRates(input, 60); expect(rates[0].rxMbps).toBeNull(); expect(rates[1].rxMbps).toBe(1); expect(rates[1].txMbps).toBe(0.5); expect(input[0]).toBe(b); });
  test("distinguishes valid zero and a long gap", () => { expect(deriveNetworkRates([b, sample(45, b.network_rx_bytes, b.network_tx_bytes)], 60)[1].rxMbps).toBe(0); expect(deriveNetworkRates([b, sample(76, 3_000_000, 2_000_000)], 60)[1].rxMbps).toBeNull(); });
  test("rejects one direction reset and invalid counters", () => { expect(deriveNetworkRates([a, sample(15, 2_000_000, 1)], 60)[1].rxMbps).toBeNull(); for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(deriveNetworkRates([a, sample(15, value, 1)], 60)[1].txMbps).toBeNull(); });
  test("duplicate and zero readings poison adjacent pairs", () => { const c = sample(30, 3_000_000, 2_000_000), d = sample(45, 4_000_000, 3_000_000); const rates = deriveNetworkRates([a,b,b,c,d],60); expect(rates.map(r => r.rxMbps === null)).toEqual([true,true,true,false]); const zero = deriveNetworkRates([sample(0,0,0), b, c],60); expect(zero.map(r => r.rxMbps === null)).toEqual([true,true,false]); });
});
