"use client";

import { useEffect } from "react";
import { ProviderSettings } from "../../../components/provider-settings";
import { useProviders } from "../use-providers";
import { WorkspaceHeader } from "../workspace-header";

export default function ProvidersPage() {
  const { providers, encryptionConfigured, loading, error, refresh } = useProviders();
  const activeTest = providers.some(p => p.lastTest?.status === "queued" || p.lastTest?.status === "running");
  useEffect(() => {
    if (!activeTest) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [activeTest, refresh]);

  return <>
    <WorkspaceHeader title="Provider settings" description="Encrypted AI connections. Choose the endpoint and model explicitly; no automatic fallback." />
    <ProviderSettings providers={providers} encryptionConfigured={encryptionConfigured} loading={loading} error={error} onRefresh={refresh} />
  </>;
}
