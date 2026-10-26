// Copies the version that `changeset version` wrote to package.json into the
// Rust crate, so Cargo.toml and Cargo.lock stay in sync with the app version.
// tauri.conf.json reads the version from package.json directly.
import { readFileSync, writeFileSync } from "node:fs";

const CRATE_NAME = "realtime-grilling";
const CARGO_TOML = "src-tauri/Cargo.toml";
const CARGO_LOCK = "src-tauri/Cargo.lock";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as {
  version: string;
};

const replaceOnce = (path: string, pattern: RegExp, replacement: string) => {
  const source = readFileSync(path, "utf8");
  if (!pattern.test(source)) {
    throw new Error(`Could not find the ${CRATE_NAME} version in ${path}`);
  }
  writeFileSync(path, source.replace(pattern, replacement));
};

replaceOnce(
  CARGO_TOML,
  /^(?<prefix>\[package\][^[]*?\nversion = )"[^"]*"/mu,
  `$<prefix>"${version}"`
);
replaceOnce(
  CARGO_LOCK,
  new RegExp(`(?<prefix>\\nname = "${CRATE_NAME}"\\nversion = )"[^"]*"`, "u"),
  `$<prefix>"${version}"`
);
