/*
 * Every URL of the app in one place. Screens link through these helpers,
 * never through string literals.
 *
 * The app is a static export inside Tauri, so routes can't depend on data
 * that only exists at runtime (projects and calls are created on the user's
 * machine). Entity screens therefore take their id from the query string
 * (`/project?id=…`) instead of a dynamic segment. Fixed sets (settings
 * sections, onboarding steps) are plain path segments.
 */

export type SettingsSection =
  | "general"
  | "audio"
  | "agent"
  | "shortcuts"
  | "privacy"
  | "integrations";

export type OnboardingStep =
  | "welcome"
  | "permissions"
  | "speech"
  | "agent"
  | "integrations"
  | "done";

export type IntegrationService = "github" | "outline" | "clickup";

function withQuery(path: string, query: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, value);
    }
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

export const routes = {
  /** The live call window. */
  call: () => "/call",
  callProposals: (id: string) => withQuery("/calls/proposals", { id }),

  /** A finished call: summary, task cards, proposals, transcript. */
  callSummary: (id: string) => withQuery("/calls/summary", { id }),
  callTasks: (id: string) => withQuery("/calls/tasks", { id }),
  callTranscript: (id: string, moment?: string) =>
    withQuery("/calls/transcript", { id, moment }),

  /** All calls, or the calls of one project. */
  history: (projectId?: string) =>
    withQuery("/history", { project: projectId }),
  home: () => "/",
  newProject: () => "/project/new",

  onboarding: (step: OnboardingStep = "welcome") =>
    step === "welcome" ? "/onboarding" : `/onboarding/${step}`,
  /** A service step; `from: "done"` returns to the summary instead of the list. */
  onboardingIntegration: (service: IntegrationService, from?: "done") =>
    withQuery(`/onboarding/integrations/${service}`, { from }),
  overlay: () => "/overlay",
  person: (projectId: string, personId: string) =>
    withQuery("/project/person", { id: personId, project: projectId }),

  project: (id: string) => withQuery("/project", { id }),

  settings: (section: SettingsSection = "general") => `/settings/${section}`,

  /** Floating windows. In Tauri each is its own small transparent window. */
  startWidget: () => "/widget",
} as const;

/** Name of the query parameter that forces a screen state in development. */
export const DEMO_PARAM = "demo";

/** Adds `?demo=<state>` to a route, for the dev navigator. */
export function withDemo(href: string, state: string) {
  const [path, search = ""] = href.split("?");
  const params = new URLSearchParams(search);
  params.set(DEMO_PARAM, state);
  return `${path}?${params.toString()}`;
}
