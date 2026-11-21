import type { ReactNode } from "react";
import { WorkspaceSession } from "./workspace-session";

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <WorkspaceSession>{children}</WorkspaceSession>;
}
