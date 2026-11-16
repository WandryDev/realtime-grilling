import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

/*
 * The tests wait on conditions (`findBy*`, `waitFor`), never on time. A
 * machine busy with a Rust build can take seconds to get there; the
 * default second would fail them.
 */
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  cleanup();
});
