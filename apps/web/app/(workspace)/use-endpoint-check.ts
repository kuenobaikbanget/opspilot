import { useState } from "react";
import type { EndpointMonitor } from "@opspilot/contracts";
import { api } from "../../lib/api";
import { useWorkspace } from "./workspace";

export function useEndpointCheck() {
  const { updateEndpoint } = useWorkspace();
  const [checkingEndpointId, setCheckingEndpointId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function checkEndpoint(id: string) {
    setCheckingEndpointId(id);
    try {
      const res: { endpoint: EndpointMonitor } = await api(`/endpoints/${id}/check`, "POST", {});
      updateEndpoint(res.endpoint);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Endpoint check failed.");
    } finally {
      setCheckingEndpointId(current => current === id ? null : current);
    }
  }

  return { checkingEndpointId, checkEndpoint, actionError: { error, dismiss: () => setError("") } };
}
