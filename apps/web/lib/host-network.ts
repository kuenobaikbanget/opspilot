import type { HostMetric } from "@opspilot/contracts";

export type NetworkRatePoint = { sampledAt: string; timestampMs: number; intervalSeconds: number | null; rxMbps: number | null; txMbps: number | null };

export function deriveNetworkRates(samples: readonly HostMetric[], maxIntervalSeconds: number): NetworkRatePoint[] {
  const rows = samples.map(sample => ({ sample, timestamp: Date.parse(sample.sampled_at) }))
    .filter(row => Number.isFinite(row.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  const result: NetworkRatePoint[] = [];
  let previous: typeof rows[number] | null = null;
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    let next = i + 1;
    while (next < rows.length && rows[next].timestamp === row.timestamp) next++;
    const duplicate = next - i > 1;
    const interval = previous ? (row.timestamp - previous.timestamp) / 1000 : null;
    const valid = (r: typeof row) => Number.isSafeInteger(r.sample.network_rx_bytes) && r.sample.network_rx_bytes >= 0 && Number.isSafeInteger(r.sample.network_tx_bytes) && r.sample.network_tx_bytes >= 0 && (r.sample.network_rx_bytes !== 0 || r.sample.network_tx_bytes !== 0);
    const usable = !duplicate && previous && interval !== null && interval > 0 && interval <= maxIntervalSeconds && valid(previous) && valid(row) && row.sample.network_rx_bytes >= previous.sample.network_rx_bytes && row.sample.network_tx_bytes >= previous.sample.network_tx_bytes;
    result.push({ sampledAt: row.sample.sampled_at, timestampMs: row.timestamp, intervalSeconds: interval, rxMbps: usable ? (row.sample.network_rx_bytes - previous!.sample.network_rx_bytes) * 8 / interval! / 1_000_000 : null, txMbps: usable ? (row.sample.network_tx_bytes - previous!.sample.network_tx_bytes) * 8 / interval! / 1_000_000 : null });
    previous = duplicate ? null : row;
    i = next;
  }
  return result;
}
