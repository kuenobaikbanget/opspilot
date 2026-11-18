import { finitePercent, type Host, type HostList } from "@opspilot/contracts";

export const resources = [
  { key: "cpu_percent", label: "CPU" },
  { key: "memory_percent", label: "Memory" },
  { key: "disk_percent", label: "Disk" },
] as const;

export type Resource = (typeof resources)[number]["key"];

export type Pressure = {
  key: Resource;
  label: string;
  value: number;
  limit: number;
  headroom: number;
  state: "within" | "near" | "exceeded";
};

export function percent(value: number | null) {
  return value == null || !Number.isFinite(value) ? "—" : `${Number(value.toFixed(1))}%`;
}

export function hasFreshSample(host: Host, fleet: HostList, now: number) {
  if (host.status !== "online" || !host.sampled_at) return false;
  const elapsed = now - Date.parse(host.sampled_at);
  return Number.isFinite(elapsed) && elapsed <= fleet.stale_after_seconds * 1000;
}

export function resourcePressure(host: Host, fleet: HostList, now: number, key: Resource): Pressure | null {
  const value = host[key];
  const limit = fleet.thresholds?.[key];
  if (!hasFreshSample(host, fleet, now) || !finitePercent(value) || !finitePercent(limit)) return null;
  const headroom = limit - value;
  const label = resources.find(resource => resource.key === key)!.label;
  return { key, label, value, limit, headroom, state: headroom <= 0 ? "exceeded" : headroom <= 5 ? "near" : "within" };
}

export function pressure(host: Host, fleet: HostList, now: number): Pressure | null {
  let nearest: Pressure | null = null;
  for (const { key } of resources) {
    const candidate = resourcePressure(host, fleet, now, key);
    if (candidate && (!nearest || candidate.headroom < nearest.headroom)) nearest = candidate;
  }
  return nearest;
}
