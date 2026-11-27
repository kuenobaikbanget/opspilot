import { useCallback, useEffect, useRef, useState } from "react";
import type { PrivacyConsentSettings } from "@opspilot/contracts";
import { ApiError, getPrivacyConsent, updatePrivacyConsent } from "../../lib/api";

/** Loads the workspace privacy consent settings and exposes a consent-aware refresh. */
export function usePrivacyConsent() {
  const [consent, setConsent] = useState<PrivacyConsentSettings | null>(null);
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
        const data = await getPrivacyConsent(signal);
        if (signal.aborted) return;
        setConsent(data);
        setError("");
      } catch (cause) {
        if (!signal.aborted && !(cause instanceof ApiError && cause.status === 401)) {
          setError(cause instanceof Error ? cause.message : "Privacy settings could not be loaded.");
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
    return () => { controller.abort(); pending.current = null; };
  }, [refresh]);

  const update = useCallback(async (aiEgressConsentGranted: boolean, redactPii: boolean): Promise<string | null> => {
    try {
      const data = await updatePrivacyConsent({ aiEgressConsentGranted, redactPii });
      setConsent(data);
      setError("");
      return null;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Privacy settings could not be saved.";
      setError(message);
      return message;
    }
  }, []);

  return { consent, loading, error, refresh, update };
}
