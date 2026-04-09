import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chess Recall — Personalized SRS Training",
  description: "Learn from your own blunders with spaced repetition.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full flex flex-col antialiased">{children}</body>
    </html>
  );
}
