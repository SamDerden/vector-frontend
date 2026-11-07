import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "Профессиональный навигатор — API",
  description: "Backend API for the Professional Navigator MVP"
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body style={{ fontFamily: "system-ui", margin: "2rem" }}>{children}</body></html>;
}
