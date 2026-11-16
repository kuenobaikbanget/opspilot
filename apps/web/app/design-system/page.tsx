import type { Metadata } from "next";
import DesignCatalog from "./catalog";

export const metadata: Metadata = {
  title: "Design system | OpsPilot",
  description: "OpsPilot UI foundation: semantic tokens, accessible components, and evidence-first patterns. All examples are synthetic.",
};

export default function DesignSystemPage() {
  return <DesignCatalog />;
}
