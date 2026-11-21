import { useCallback, useEffect, useRef, useState } from "react";
import type { AiProvider } from "@opspilot/contracts";
import { api, ApiError } from "../../lib/api";

export function useProviders() {
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [encryptionConfigured, setEncryptionConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const scope = useRef<AbortController | null>(null);
  const pending = useRef<Promise<void> | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (pending.current) return pending.current;
    const signal = scope.current?.signal;
    if (!signal || signal.aborted) return Promise.resolve();
    setLoading(true);
    pending.current = (async () => {
      try {
        const data: { providers: AiProvider[]; encryptionConfigured: boolean } = await api("/ai/providers", "GET", undefined, signal);
        if (signal.aborted) return;
        setProviders(data.providers);
        setEncryptionConfigured(data.encryptionConfigured);
        setError("");
      } catch (cause) {
        if (!signal.aborted && !(cause instanceof ApiError && cause.status === 401)) {
          setError(cause instanceof Error ? cause.message : "Provider metadata could not be loaded.");
        }
      } finally {
        if (!signal.aborted) {
          setLoading(false);
          pending.current = null;
        }
      }
    })();
    return pending.current;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => { controller.abort(); pending.current = null; clearInterval(timer); };
  }, [refresh]);

  return { providers, encryptionConfigured, loading, error, refresh };
}
