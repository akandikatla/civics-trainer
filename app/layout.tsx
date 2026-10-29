import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "USCIS Civics Interview Trainer",
  description: "Spoken mock interview for the 2025 USCIS civics test (128 questions)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
