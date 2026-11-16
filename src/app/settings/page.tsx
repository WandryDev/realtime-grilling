import { redirect } from "next/navigation";

import { routes } from "@/lib/routes";

// /settings opens the first section. In the static export the redirect is
// written into the page as a meta refresh, so it works without a server.
export default function SettingsIndexPage() {
  redirect(routes.settings("general"));
}
