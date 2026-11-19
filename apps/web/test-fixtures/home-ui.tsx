import { closeDom } from "../../../tests/fixtures/home-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import Home from "../app/page";

const scenario = process.argv[2];
let sessionStatus = scenario === "unauthorized" ? 401 : scenario === "session-recovery" ? 503 : 200;
let incidentStatus = scenario === "cold-failure" || scenario === "recovery" ? 503 : 200;
const requests: string[] = [];
const hostOnline = scenario === "overview-services" || scenario === "overview-services-error" || scenario === "ascii-loading-transition";
const currentSample = hostOnline || scenario === "investigation-unavailable" || scenario === "unrelated-investigation";
const deferredHosts = scenario === "ascii-loading-transition" ? Promise.withResolvers<Response>() : null;
const deferredServices = scenario === "ascii-loading-transition" ? Promise.withResolvers<Response>() : null;
const deferredHostServices = scenario === "ascii-loading-transition" ? Promise.withResolvers<Response>() : null;
const deferredInvestigation = scenario === "ascii-loading-transition" ? Promise.withResolvers<Response>() : null;
const deferredMemory = scenario === "ascii-memory" ? [
  Promise.withResolvers<Response>(), Promise.withResolvers<Response>(), Promise.withResolvers<Response>(),
] : [];
let memoryRequests = 0;
const timestamp = "2026-11-18T00:00:00.000Z";
const sampleTime = currentSample ? new Date().toISOString() : timestamp;
let historyAborted = false;
const hostId = "d0000000-0000-4000-8000-000000000001";
const incident = {
  id: "d0000000-0000-4000-8000-000000000002",
  title: "Fixture CPU incident",
  agent_id: hostId,
  hostname: "Fixture host",
  category: scenario === "unrelated-investigation" ? "config_drift" : "cpu",
  status: "open",
  created_at: timestamp,
  resolution: null,
};

const fixtureFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
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
    case `/api/incidents/${incident.id}`:
      if (deferredInvestigation) return deferredInvestigation.promise;
      if (scenario === "investigation-unavailable") {
        status = 503;
        value = { error: "Fixture investigation detail failure" };
      } else {
        value = { incident, evidence: [], investigations: [] };
      }
      break;
    case "/api/hosts":
      if (deferredHosts) return deferredHosts.promise;
      if (scenario === "ascii-error-safety") {
        status = 503;
        value = { error: "Fixture fleet outage" };
        break;
      }
      value = {
        hosts: [{ id: hostId, hostname: "Fixture host", version: "fixture", status: currentSample ? "online" : "offline", created_at: timestamp, last_seen_at: sampleTime, sampled_at: sampleTime, cpu_percent: currentSample ? 94 : 82, memory_percent: 40, disk_percent: 25 }],
        total: 1, online: currentSample ? 1 : 0, limit: 100, observed_at: sampleTime, stale_after_seconds: 60,
        thresholds: { cpu_percent: 85, memory_percent: 90, disk_percent: 90 },
      };
      break;
    case `/api/hosts/${hostId}/metrics`:
      if (scenario === "host-history-visibility") {
        const { promise, reject } = Promise.withResolvers<Response>();
        init?.signal?.addEventListener("abort", () => {
          historyAborted = true;
          reject(init.signal?.reason);
        }, { once: true });
        return promise;
      }
      value = [];
      break;
    case `/api/hosts/${hostId}/services`:
      if (deferredHostServices) return deferredHostServices.promise.then(response => response.clone());
      if (scenario === "overview-services-error") {
        status = 503;
        value = { error: "Fixture systemd outage" };
        break;
      }
      value = hostOnline
        ? {
            agent_id: hostId,
            online: true,
            checked_at: sampleTime,
            report: { status: "observed", observed_at: sampleTime, current: true },
            service: {
              id: "d0000000-0000-4000-8000-000000000003",
              agent_id: hostId,
              name: "mock-edge-proxy.service",
              runtime: "systemd",
              source: "agent_systemd",
              state: "running",
              observed_at: sampleTime,
              freshness: "fresh",
            },
          }
        : { agent_id: hostId, online: false, checked_at: timestamp, report: null, service: null };
      break;
    case "/api/ai/providers":
      value = { providers: [], encryptionConfigured: false };
      break;
    case "/api/services":
      if (deferredServices) return deferredServices.promise;
      if (scenario === "ascii-error-safety") {
        status = 503;
        value = { error: "Fixture endpoints outage" };
        break;
      }
      value = { endpoints: [] };
      break;
    case "/api/memory": {
      const read = deferredMemory[memoryRequests++];
      if (!read) throw new Error("Unexpected memory read");
      return read.promise;
    }
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
    relatedIncident: document.querySelector(".inspector-incident")?.textContent,
    incidentContext: incidentReading?.textContent,
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
    case "cold-failure": {
      await click("Hosts");
      const { relatedIncident: related } = snapshot();
      await click("Incidents");
      console.log(JSON.stringify({ initial, related, incidentList: document.querySelector(".list")?.textContent }));
      break;
    }
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
      await click("Hosts");
      const { relatedIncident: related } = snapshot();
      await click("Overview");
      incidentStatus = 200;
      await click("Retry incidents");
      console.log(JSON.stringify({ initial, cached, related, recovered: snapshot() }));
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
    case "overview-services":
    case "overview-services-error":
      console.log(JSON.stringify({
        riskServices: document.querySelector(".overview-risk-services")?.textContent,
        inspectorSystemd: document.querySelector(".overview-inspector .host-systemd")?.textContent,
      }));
      break;
    case "investigation-unavailable":
    case "unrelated-investigation":
      console.log(JSON.stringify({ advisory: document.querySelector('[aria-label="Advisory AI analysis"]')?.textContent, requests }));
      break;
    case "host-history-visibility": {
      const historyRequests = () => requests.filter(path => path === `/api/hosts/${hostId}/metrics`).length;
      const onOverview = historyRequests();
      await click("Hosts");
      const onHosts = historyRequests();
      await click("Overview");
      console.log(JSON.stringify({ onOverview, onHosts, afterLeaving: historyRequests(), historyAborted }));
      break;
    }
    case "ascii-loading-transition": {
      const loadingState = {
        summarySkeletons: document.querySelectorAll(".overview-summary [data-ascii-skeleton]").length,
        riskSkeletons: document.querySelectorAll(".overview-watchlist [data-ascii-skeleton]").length,
        inspectorLoading: document.querySelector(".overview-inspector > [role=status]")?.textContent,
        inspectorSkeletons: document.querySelectorAll(".overview-inspector > [role=status] [data-ascii-skeleton]").length,
        endpointSkeletons: document.querySelectorAll(".overview-endpoint-scope [data-ascii-skeleton]").length,
        inventorySkeletons: document.querySelectorAll(".overview-inventory [data-ascii-skeleton]").length,
        animatedSkeletons: document.querySelectorAll("[data-ars-animate]").length,
        overlays: document.querySelectorAll(".ar-overlay").length,
      };
      await act(async () => {
        deferredHosts?.resolve(Response.json({
          hosts: [{ id: hostId, hostname: "Fixture host", version: "fixture", status: "online", created_at: timestamp, last_seen_at: sampleTime, sampled_at: sampleTime, cpu_percent: 94, memory_percent: 40, disk_percent: 25 }],
          total: 1, online: 1, limit: 100, observed_at: sampleTime, stale_after_seconds: 60,
          thresholds: { cpu_percent: 85, memory_percent: 90, disk_percent: 90 },
        }));
        deferredServices?.resolve(Response.json({ endpoints: [] }));
      });
      const midState = {
        summarySkeletons: document.querySelectorAll(".overview-summary [data-ascii-skeleton]").length,
        inspectorHost: document.querySelector(".overview-inspector .overview-hostname")?.textContent,
        inspectorLoading: document.querySelector(".overview-inspector > [role=status]")?.textContent,
        endpointSkeletons: document.querySelectorAll(".overview-endpoint-scope [data-ascii-skeleton]").length,
        inventorySkeletons: document.querySelectorAll(".overview-inventory [data-ascii-skeleton]").length,
        serviceSkeletons: document.querySelectorAll(".overview-risk-services [data-ascii-skeleton]").length,
        serviceStatus: document.querySelector(".overview-risk-services")?.textContent,
        advisoryBrailleSkeletons: document.querySelectorAll('[aria-label="Advisory AI analysis"] [data-ascii-skeleton].ars-braille').length,
        advisoryStatus: document.querySelector('[aria-label="Advisory AI analysis"]')?.textContent,
      };
      await act(async () => {
        deferredHostServices?.resolve(Response.json({
          agent_id: hostId,
          online: true,
          checked_at: sampleTime,
          report: { status: "observed", observed_at: sampleTime, current: true },
          service: {
            id: "d0000000-0000-4000-8000-000000000003",
            agent_id: hostId,
            name: "mock-edge-proxy.service",
            runtime: "systemd",
            source: "agent_systemd",
            state: "running",
            observed_at: sampleTime,
            freshness: "fresh",
          },
        }));
        deferredInvestigation?.resolve(Response.json({
          incident,
          evidence: [],
          investigations: [{
            status: "completed",
            provider: { name: "fixture-ai", model: "mock-1" },
            result_json: {
              probable_cause: "Sustained worker load saturated CPU.",
              confidence: "medium",
              recommended_checks: ["Inspect top CPU processes"],
            },
            error: null,
          }],
        }));
      });
      const loadedState = {
        remainingSkeletons: document.querySelectorAll("[data-ascii-skeleton]").length,
        riskServices: document.querySelector(".overview-risk-services")?.textContent,
        advisory: document.querySelector('[aria-label="Advisory AI analysis"]')?.textContent,
      };
      console.log(JSON.stringify({ loadingState, midState, loadedState }));
      break;
    }
    case "ascii-error-safety": {
      console.log(JSON.stringify({
        remainingSkeletons: document.querySelectorAll("[data-ascii-skeleton]").length,
        overlays: document.querySelectorAll(".ar-overlay").length,
        summaryText: document.querySelector(".overview-summary")?.textContent,
        endpointText: document.querySelector(".overview-endpoint-scope")?.textContent,
        inventoryText: document.querySelector(".overview-inventory")?.textContent,
      }));
      break;
    }
    case "ascii-memory": {
      const memory = () => ({
        pending: Boolean(document.querySelector('[aria-labelledby="memory-title"] [data-ascii-skeleton]')),
        text: document.querySelector('[aria-labelledby="memory-title"]')?.textContent,
      });
      async function reopenMemory() {
        await click("Overview");
        await click("Incident memory");
      }
      await click("Incident memory");
      const pending = memory();
      await reopenMemory();
      await act(async () => { deferredMemory[1].resolve(Response.json({ error: "Fixture memory outage" }, { status: 503 })); });
      const failed = memory();
      await act(async () => { deferredMemory[0].resolve(Response.json([{ id: "old", summary: "Old search result" }])); });
      const afterStaleResponse = memory();
      await reopenMemory();
      const pendingAgain = memory();
      await act(async () => { deferredMemory[2].resolve(Response.json([])); });
      console.log(JSON.stringify({ pending, failed, afterStaleResponse, pendingAgain, empty: memory() }));
      break;
    }
    default:
      throw new Error(`Unknown scenario: ${scenario}`);
  }
} finally {
  await act(async () => { root.unmount(); });
  await closeDom();
}
