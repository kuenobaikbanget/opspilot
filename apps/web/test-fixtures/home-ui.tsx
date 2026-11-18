import { closeDom } from "../../../tests/fixtures/home-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import Home from "../app/page";

const scenario = process.argv[2];
let sessionStatus = scenario === "unauthorized" ? 401 : scenario === "session-recovery" ? 503 : 200;
let incidentStatus = scenario === "cold-failure" || scenario === "recovery" ? 503 : 200;
const requests: string[] = [];
const hostId = "d0000000-0000-4000-8000-000000000001";
const timestamp = "2026-11-18T00:00:00.000Z";
const incident = {
  id: "d0000000-0000-4000-8000-000000000002",
  title: "Fixture CPU incident",
  agent_id: hostId,
  hostname: "Fixture host",
  category: "cpu",
  status: "open",
  created_at: timestamp,
  resolution: null,
};

const fixtureFetch = async (input: RequestInfo | URL) => {
  const path = new URL(String(input), window.location.href).pathname;
  requests.push(path);
  let value: unknown;
  let status = 200;
  switch (path) {
    case "/api/auth/me":
      status = sessionStatus;
      value =
        status === 200
          ? { authenticated: true, role: "admin", ...(scenario === "auth-disabled" ? { authDisabled: true } : {}) }
          : { error: "Fixture session failure" };
      break;
    case "/api/incidents":
      status = incidentStatus;
      value = status === 200 ? [incident] : { error: "Fixture incident failure" };
      break;
    case "/api/hosts":
      value = {
        hosts: [{ id: hostId, hostname: "Fixture host", version: "fixture", status: "offline", created_at: timestamp, last_seen_at: timestamp, sampled_at: timestamp, cpu_percent: 82, memory_percent: 40, disk_percent: 25 }],
        total: 1, online: 0, limit: 100, observed_at: timestamp, stale_after_seconds: 60,
        thresholds: { cpu_percent: 90, memory_percent: 90, disk_percent: 90 },
      };
      break;
    case `/api/hosts/${hostId}/metrics`:
      value = [];
      break;
    case "/api/ai/providers":
      value = { providers: [], encryptionConfigured: false };
      break;
    case "/api/services":
      value = { services: [], endpoints: [] };
      break;
    case "/api/auth/logout":
      status = 503;
      value = { error: "Fixture sign-out failure" };
      break;
    default:
      throw new Error(`Unexpected fixture request: ${path}`);
  }
  return Response.json(value, { status });
};
Object.assign(globalThis, { fetch: fixtureFetch });
Object.assign(window, { fetch: fixtureFetch });

const container = window.document.createElement("div");
window.document.body.append(container);
const root = createRoot(container);
const document = window.document;
const snapshot = () => {
  const incidentReading = [...document.querySelectorAll("dt")].find(element => element.textContent?.startsWith("Open incidents"));
  return {
    protectedVisible: !!document.getElementById("main-content"),
    loginVisible: !!document.getElementById("admin-password"),
    signOutVisible: [...document.querySelectorAll("button")].some(element => element.textContent?.trim() === "Sign out"),
    incidentCount: incidentReading?.nextElementSibling?.textContent,
    incidentContext: incidentReading?.textContent,
    relatedIncident: document.querySelector(".inspector-incident")?.textContent,
    alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
  };
};
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(element => element.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => { button.click(); });
}

try {
  await act(async () => { root.render(createElement(Home)); });
  const initial = snapshot();
  switch (scenario) {
    case "cold-failure":
      await click("Incidents");
      console.log(JSON.stringify({ initial, incidentList: document.querySelector(".list")?.textContent }));
      break;
    case "recovery":
      await click("Sign out");
      const failed = snapshot();
      incidentStatus = 200;
      await click("Retry incidents");
      console.log(JSON.stringify({ failed, recovered: snapshot() }));
      break;
    case "cached-failure":
      incidentStatus = 503;
      await click("Refresh");
      const cached = snapshot();
      incidentStatus = 200;
      await click("Retry incidents");
      console.log(JSON.stringify({ initial, cached, recovered: snapshot() }));
      break;
    case "unauthorized":
      console.log(JSON.stringify({ initial, requests }));
      break;
    case "session-recovery":
      const beforeRetry = [...requests];
      sessionStatus = 200;
      await click("Retry session check");
      console.log(JSON.stringify({ initial, beforeRetry, recovered: snapshot() }));
      break;
    case "expired-session":
      incidentStatus = 401;
      await click("Refresh");
      console.log(JSON.stringify({ initial, expired: snapshot() }));
      break;
    case "auth-disabled":
      console.log(JSON.stringify({ initial, requests }));
      break;
    default:
      throw new Error(`Unknown scenario: ${scenario}`);
  }
} finally {
  await act(async () => { root.unmount(); });
  await closeDom();
}
