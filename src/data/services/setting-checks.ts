import type { Value } from "@/bindings";

/*
 * Rust's `settings::validate` (`src-tauri/src/storage/settings.rs`): the
 * keys it stores (`KNOWN_KEYS`), each with its value check. The mock
 * settings and the tests' fake IPC refuse what Rust refuses. Free of
 * imports, so the fake can load it before the Tauri mocks.
 */

export const NEVER = "never";
const PATH_SEPARATOR = /[\\/]/u;

/** A whole number as a string or a number, like `whole_number` in Rust. */
function wholeNumber(value: Value): number | null {
  const number =
    typeof value === "string" && value.trim() !== ""
      ? Number(value.trim())
      : value;
  return typeof number === "number" && Number.isInteger(number) ? number : null;
}

const oneOf =
  (...allowed: string[]) =>
  (value: Value) =>
    typeof value === "string" && allowed.includes(value);

const isFlag = (value: Value) => typeof value === "boolean";

/*
 * The keys `settings::KNOWN_KEYS` in Rust stores, each with its value
 * check (`valid_value`). Any other key is refused.
 */
const SETTING_CHECKS: Record<string, (value: Value) => boolean> = {
  agentPath: (value) =>
    value === null ||
    (typeof value === "string" &&
      AGENT_CLI_NAMES.includes(value.split(PATH_SEPARATOR).at(-1) ?? "")),
  audioRetention: oneOf("7", "30", "90", NEVER),
  autoEnd: (value) => value === NEVER || (wholeNumber(value) ?? -1) >= 0,
  callLanguage: oneOf("ru", "uk", "both"),
  compactOverlay: isFlag,
  hideOnShare: isFlag,
  launchAtLogin: isFlag,
  micBusyBehavior: oneOf("widget", "record", "nothing"),
  microphone: (value) => typeof value === "string" && value.trim() !== "",
  onboardingCompleted: isFlag,
  questionCount: (value) => [1, 3, 5].includes(wholeNumber(value) ?? 0),
  questionFrequency: oneOf("rare", "normal", "often"),
  questionRequeueMinutes: (value) => (wholeNumber(value) ?? 0) >= 1,
  shortcuts: (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (keys) =>
        Array.isArray(keys) && keys.every((key) => typeof key === "string")
    ),
  speechBenchmark: () => true,
  speechModel: oneOf("turbo", "small"),
  theme: oneOf("light", "dark", "system"),
  transcriptRetention: oneOf("90", "180", "365", NEVER),
};

/** File names of the agent CLI, like `has_cli_name` in Rust. */
const AGENT_CLI_NAMES = ["claude", "claude.exe", "claude.cmd"];

/**
 * Why Rust's `settings::validate` refuses one setting, or `null` when it
 * takes it: an unknown key or a value outside the key's domain.
 */
export function settingProblem(key: string, value: Value): string | null {
  const check = SETTING_CHECKS[key];
  if (!check) {
    return `Неизвестная настройка: ${key}`;
  }
  return check(value)
    ? null
    : `Неверное значение настройки ${key}: ${JSON.stringify(value)}`;
}
