// A container the test and e2e scripts start is removed with its volumes (#1296). The postgres and mariadb images declare a data VOLUME, so `rm -f` with no `-v` leaves one anonymous volume per
// container behind: about 150 piled up in a day of runs and filled a 100 GB podman disk. scripts/test-db.test.ts runs db-servers.sh against a fake engine and checks that no volume is left; e2e-up.sh
// needs a real engine and a built image to run, so this reads both scripts and holds every removal of a container to carry `-v`, in `remove_labelled` (the teardown and `down`) and in the two
// places that remove one by name.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const lines = (file: string): string[] => readFileSync(join(SCRIPTS, file), "utf8").split("\n").filter((l) => !l.trim().startsWith("#"));
/** The lines that remove a container through the engine: `$E rm ...` or `"$engine" rm ...`, not `volume rm` or `network rm`. */
const removals = (file: string, engine: RegExp): string[] => lines(file).filter((l) => engine.test(l));

describe("the scripts that start containers remove them with their volumes", () => {
  it("e2e-up.sh removes every container with `rm -f -v`: the labelled ones, the Cypress one and the server's", () => {
    const found = removals("e2e-up.sh", /\$E rm\b/);
    // remove_labelled, the kept run's Cypress container, and server_create's server container.
    expect(found).toHaveLength(3);
    for (const l of found) expect(l, l.trim()).toMatch(/\$E rm -f -v /);
  });

  it("db-servers.sh removes every container with `rm -f -v`", () => {
    const found = removals("db-servers.sh", /"\$engine" rm\b/);
    expect(found).toHaveLength(1);
    for (const l of found) expect(l, l.trim()).toMatch(/"\$engine" rm -f -v /);
  });

  it("starts a container that stays with `run -d` only in the places the removals above cover, so a new one is looked at", () => {
    // `run -d` makes a container that stays until it is removed; `run --rm` is removed by the engine, with its anonymous volumes.
    expect(lines("e2e-up.sh").filter((l) => /\$E run -d\b/.test(l))).toHaveLength(2);
    expect(lines("db-servers.sh").filter((l) => /"\$engine" run -d\b/.test(l))).toHaveLength(1);
  });
});
