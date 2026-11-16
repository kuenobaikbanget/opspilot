import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {title:"OpsPilot | Server intelligence",description:"Lightweight server observability and evidence-first investigation"};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="en"><body>{children}</body></html>;}
