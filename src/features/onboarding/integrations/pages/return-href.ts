import { routes } from "@/lib/routes";

/** Where a service step goes back to: the list, or the summary it came from. */
export function returnHref(from?: "done") {
  return routes.onboarding(from === "done" ? "done" : "integrations");
}
