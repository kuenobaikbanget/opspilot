"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { BrandMark } from "../../components/brand-mark";
import { AsciiLoading } from "../../components/ascii-card-reveal";
import { Button, Field, Input, Notice, Panel } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { Workspace } from "./workspace";

export function WorkspaceSession({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<"checking" | "signed-out" | "signed-in" | "auth-disabled">("checking");
  const [sessionError, setSessionError] = useState("");
  const generation = useRef(0);
  const endSession = useCallback(() => {
    generation.current++;
    setSession("signed-out");
  }, []);

  useEffect(() => {
    window.addEventListener("opspilot-unauthorized", endSession);
    return () => window.removeEventListener("opspilot-unauthorized", endSession);
  }, [endSession]);

  const checkSession = useCallback(async () => {
    const current = generation.current;
    setSessionError("");
    try {
      const me = await api("/auth/me");
      if (current === generation.current) setSession(me?.authDisabled ? "auth-disabled" : "signed-in");
    } catch (cause) {
      if (current === generation.current && !(cause instanceof ApiError && cause.status === 401)) {
        setSessionError(cause instanceof Error ? cause.message : "Unable to verify your session.");
      }
    }
  }, []);

  useEffect(() => { void checkSession(); }, [checkSession]);

  if (session === "checking") return (
    <main className="center">
      <div>
        {sessionError ? <p role="status">Unable to verify your session.</p> : <AsciiLoading label="Checking admin session…" />}
        {sessionError && <Notice tone="danger" role="alert">{sessionError}<p><Button onClick={() => void checkSession()}>Retry session check</Button></p></Notice>}
        <Link href="/design-system">Explore the design system</Link>
      </div>
    </main>
  );

  if (session === "signed-out") return <Login onSignIn={() => setSession("signed-in")} />;
  return <Workspace onSignOut={session === "signed-in" ? endSession : undefined}>{children}</Workspace>;
}

function Login({ onSignIn }: { onSignIn: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const password = new window.FormData(event.currentTarget).get("password");
      await api("/auth/login", "POST", { password });
      onSignIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign in.");
    } finally { setBusy(false); }
  }

  return (
    <main className="login-container">
      <Panel className="login-card">
        <div className="logo"><BrandMark size={24} /><span>OpsPilot</span></div>
        <h1>Sign in to OpsPilot</h1>
        <p className="muted">Sign in with your single-admin password.</p>
        <form onSubmit={login}>
          <Field id="admin-password" label="Admin password" required>
            <Input id="admin-password" name="password" autoFocus type="password" autoComplete="current-password" required minLength={1} />
          </Field>
          <Button type="submit" variant="primary" loading={busy}>Sign in</Button>
        </form>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <p className="tiny">Your data stays in your own OpsPilot database. AI calls use the encrypted connections saved in Provider settings.</p>
        <Link href="/design-system">Explore the design system</Link>
      </Panel>
    </main>
  );
}
