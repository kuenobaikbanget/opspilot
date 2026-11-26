import { closeDom } from "../../../tests/fixtures/home-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import type { EndpointMonitor, HostList, HostSystemdStatus } from "../../../packages/contracts/src/index";
import WorkspaceLayout from "../app/(workspace)/layout";
import ServicesPage from "../app/(workspace)/services/page";
import NewMonitorPage from "../app/(workspace)/new-monitor/page";

const scenario = process.argv[2];
const requests: string[] = [];
const now = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const webId = "a0000000-0000-4000-8000-000000000001";
const backupId = "a0000000-0000-4000-8000-000000000002";

const referenceEndpoints: EndpointMonitor[] = [
  {
    id: "e0000000-0000-4000-8000-000000000001", agent_id: webId, service_name: "storefront-api.service",
    name: "storefront-api", target_url: "https://storefront.example.invalid/health", expected_status: 200,
    probe_location: "hub-local", last_status: "down", last_http_status: 503, last_latency_ms: null,
    last_error: "http_503", last_checked_at: iso(now() - 5_000),
  },
  {
    id: "e0000000-0000-4000-8000-000000000002", agent_id: backupId, service_name: null,
    name: "legacy-web", target_url: "https://legacy.example.invalid/", expected_status: 200,
    probe_location: "hub-local", last_status: "up", last_http_status: 200, last_latency_ms: 48,
    last_error: null, last_checked_at: iso(now() - 5_000),
  },
  {
    id: "e0000000-0000-4000-8000-000000000003", agent_id: null, service_name: null,
    name: "status-page", target_url: "https://status.example.invalid/", expected_status: 200,
    probe_location: "hub-local", last_status: "unknown", last_http_status: null, last_latency_ms: null,
    last_error: null, last_checked_at: null,
  },
  {
    id: "e0000000-0000-4000-8000-000000000004", agent_id: null, service_name: null,
    name: "metrics-edge", target_url: "https://metrics.example.invalid/", expected_status: 200,
    probe_location: "hub-local", last_status: "up", last_http_status: 200, last_latency_ms: 51,
    last_error: null, last_checked_at: iso(now() - 300_000),
  },
];

const endpointsByScenario: Record<string, EndpointMonitor[]> = {
  reference: referenceEndpoints,
  "offline-endpoint-up": referenceEndpoints,
  "not-configured": [referenceEndpoints[0]],
  "check-failure": referenceEndpoints,
  error: referenceEndpoints,
  empty: [],
};

let servicesStatus = scenario === "error" ? 503 : 200;
let backupServicesStatus = scenario === "host-services-error" ? 404 : 200;
let checkStatus = scenario === "check-failure" ? 503 : 200;

const fleet: HostList = {
  hosts: [
    {
      id: webId, hostname: "web-01", status: "online", version: "fixture",
      created_at: iso(now() - 86_400_000), last_seen_at: iso(now()), sampled_at: iso(now()),
      cpu_percent: 96.9, memory_percent: 61, disk_percent: 44,
    },
    {
      id: backupId, hostname: "backup-01", status: "offline", version: "fixture",
      created_at: iso(now() - 86_400_000), last_seen_at: iso(now() - 600_000), sampled_at: iso(now() - 600_000),
      cpu_percent: 12, memory_percent: 38, disk_percent: 71,
    },
  ],
  total: 2, online: 1, limit: 100, observed_at: iso(now()), stale_after_seconds: 60,
  thresholds: { cpu_percent: 95, memory_percent: 90, disk_percent: 90 },
};

const systemd = (id: string): HostSystemdStatus => id === webId
  ? {
      agent_id: id, online: true, checked_at: iso(now()),
      report: { status: "observed", observed_at: iso(now()), current: true },
      service: {
        id: "s0000000-0000-4000-8000-000000000001", agent_id: id, name: "storefront-api.service",
        runtime: "systemd", source: "agent_systemd", state: "running", observed_at: iso(now()), freshness: "fresh",
      },
    }
  : {
      agent_id: id, online: false, checked_at: iso(now()),
      report: { status: "observed", observed_at: iso(now() - 600_000), current: false },
      service: {
        id: "s0000000-0000-4000-8000-000000000002", agent_id: id, name: "backup-web.service",
        runtime: "systemd", source: "agent_systemd", state: "running", observed_at: iso(now() - 600_000), freshness: "stale",
      },
    };

const fixtureFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), window.location.href);
  const path = url.pathname;
  requests.push(`${init?.method ?? "GET"} ${path}`);
  const json = (value: unknown, status = 200) => Response.json(value, { status });

  if (path === "/api/auth/me") return json({ authenticated: true, role: "admin" });
  if (path === "/api/hosts") return json(fleet);
  if (path === "/api/incidents") return json([]);
  if (path === "/api/services") {
    if (servicesStatus !== 200) return json({ error: "Fixture endpoints outage" }, servicesStatus);
    return json({ endpoints: endpointsByScenario[scenario] ?? [] });
  }
  if (path === "/api/ai/providers") return json({ providers: [], encryptionConfigured: false });
  const checkMatch = /^\/api\/endpoints\/([^/]+)\/check$/.exec(path);
  if (checkMatch && init?.method === "POST") {
    if (checkStatus !== 200) return json({ error: "Fixture check outage" }, checkStatus);
    const base = referenceEndpoints.find(item => item.id === checkMatch[1]) ?? referenceEndpoints[0];
    const updated: EndpointMonitor = {
      ...base,
      last_status: "up", last_http_status: 200, last_latency_ms: 33, last_error: null, last_checked_at: iso(now()),
    };
    return json({ endpoint: updated });
  }
  const hostServices = /^\/api\/hosts\/([^/]+)\/services$/.exec(path);
  if (hostServices) {
    if (hostServices[1] === backupId && backupServicesStatus !== 200) return json({ error: "Host not found" }, backupServicesStatus);
    return json(systemd(hostServices[1]));
  }
  const hostMetrics = /^\/api\/hosts\/([^/]+)\/metrics$/.exec(path);
  if (hostMetrics) return json([]);
  throw new Error(`Unexpected fixture request: ${init?.method ?? "GET"} ${path}`);
};
Object.assign(globalThis, { fetch: fixtureFetch });
Object.assign(window, { fetch: fixtureFetch });

const container = window.document.createElement("div");
window.document.body.append(container);
const root = createRoot(container);
const document = window.document;

const routes = { "/services": ServicesPage, "/new-monitor": NewMonitorPage };

const router: AppRouterInstance = {
  push: renderRoute,
  replace() { throw new Error("Unexpected fixture replace"); },
  back() { throw new Error("Unexpected fixture back"); },
  forward() { throw new Error("Unexpected fixture forward"); },
  refresh() { throw new Error("Unexpected fixture router refresh"); },
  prefetch() {},
  bfcacheId: "fixture",
};

function renderRoute(pathname: string) {
  const Page = routes[pathname as keyof typeof routes];
  if (!Page) throw new Error(`Unexpected fixture route: ${pathname}`);
  window.history.pushState(null, "", pathname);
  root.render(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value={pathname}>
        <WorkspaceLayout><Page /></WorkspaceLayout>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

const snapshot = () => ({
  workloads: document.querySelector('[aria-labelledby="services-workloads-title"]')?.textContent,
  endpointPanel: document.querySelector('[aria-labelledby="services-endpoints-title"]')?.textContent,
  inspector: document.querySelector(".services-endpoint-inspector")?.textContent,
  alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
  pressed: [...document.querySelectorAll('[aria-pressed="true"]')].map(element => element.textContent),
  pageText: document.querySelector("main")?.textContent ?? "",
});

async function click(predicate: (element: HTMLButtonElement) => boolean) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(predicate);
  if (!button) throw new Error("Missing button");
  await act(async () => { button.click(); });
}

const clickText = (label: string) => click(element => element.textContent?.trim() === label);
const clickEndpoint = (name: string) => click(element =>
  element.className.includes("overview-endpoint-select") && element.textContent?.includes(name));
const clickCheck = (name: string) => click(element => element.getAttribute("aria-label") === `Check now: ${name}`);

async function setSelect(id: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(`#${id}`);
  if (!select) throw new Error(`Missing select #${id}`);
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

try {
  await act(async () => renderRoute(scenario === "add-service-empty" ? "/new-monitor" : "/services"));

  switch (scenario) {
    case "reference": {
      const initial = snapshot();
      await clickEndpoint("storefront-api");
      const inspected = snapshot();
      await clickCheck("metrics-edge");
      const afterCheck = snapshot();
      console.log(JSON.stringify({ initial, inspected, afterCheck, requests }));
      break;
    }
    case "offline-endpoint-up": {
      await setSelect("service-host", backupId);
      await setSelect("services-endpoint-scope", backupId);
      const scoped = snapshot();
      await clickEndpoint("legacy-web");
      console.log(JSON.stringify({ scoped, inspected: snapshot() }));
      break;
    }
    case "not-configured": {
      await setSelect("services-endpoint-scope", backupId);
      console.log(JSON.stringify(snapshot()));
      break;
    }
    case "empty": {
      console.log(JSON.stringify(snapshot()));
      break;
    }
    case "error": {
      const failed = snapshot();
      servicesStatus = 200;
      await clickText("Refresh");
      console.log(JSON.stringify({ failed, recovered: snapshot(), requests }));
      break;
    }
    case "host-services-error": {
      await setSelect("service-host", backupId);
      console.log(JSON.stringify(snapshot()));
      break;
    }
    case "check-failure": {
      await clickEndpoint("storefront-api");
      await clickCheck("storefront-api");
      const failed = snapshot();
      const checkButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find(element => element.getAttribute("aria-label") === "Check now: storefront-api");
      console.log(JSON.stringify({ ...failed, checkButtonDisabled: checkButton?.disabled ?? null, requests }));
      break;
    }
    case "add-service-empty": {
      const probeField = document.querySelector<HTMLInputElement>("input[readonly]");
      await act(async () => {
        document.querySelector<HTMLFormElement>("form.onboarding-step-body")!.requestSubmit();
      });
      const submitted = snapshot();
      console.log(JSON.stringify({
        probeField: probeField ? { value: probeField.value, readOnly: probeField.readOnly } : null,
        alerts: submitted.alerts,
        posts: requests.filter(path => path.startsWith("POST /api/endpoints")),
      }));
      break;
    }
    default:
      throw new Error(`Unknown scenario: ${scenario}`);
  }
} finally {
  await act(async () => { root.unmount(); });
  await closeDom();
}
