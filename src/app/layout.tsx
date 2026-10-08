import type { Metadata } from "next";
import "./globals.css";
import "./workspace-theme.css";
export const metadata: Metadata = {
  title: "Entara — Bond actions. Settled.",
  description: "Manage tokenized bonds, holder entitlements, coupons and redemptions on Solana Devnet with Entara.",
  applicationName: "Entara",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
