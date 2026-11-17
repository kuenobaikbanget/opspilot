import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "OpsPilot | Server intelligence",
  description: "Lightweight server observability and evidence-first investigation",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="en"><body>{children}</body></html>;}
