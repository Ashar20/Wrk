import type { Metadata, Viewport } from "next";
import { Manrope, Geist_Mono } from "next/font/google";
import "./globals.css";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Wrk: pocket money for first-person data",
  description:
    "Wrk pays people in SKR to record short first-person video and motion clips on their Android phone, for robotics teams. Pay sits in a Solana escrow until the take is verified.",
  icons: { icon: "/icon.svg" },
  openGraph: {
    title: "Wrk: pocket money for first-person data",
    description: "Record a short clip on your Android phone. Get paid in SKR once it's proven real.",
    type: "website",
  },
};

export const viewport: Viewport = { themeColor: "#E9E9E6" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
