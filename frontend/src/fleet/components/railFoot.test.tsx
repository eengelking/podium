import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { RailFoot } from "./Rail";

afterEach(cleanup);

const rows = (c: HTMLElement) => [...c.querySelectorAll(".rail-foot > span")].map((r) => r.textContent);

describe("RailFoot (#400)", () => {
  it("is the links, the version and the copyright, each on its own row, on a release", () => {
    const { container } = render(<RailFoot version="1.1.0" build={null} />);
    expect(rows(container)).toEqual(["Theme credits · License", "Podium v1.1.0", "© 2026 Ed Engelking"]);
  });

  it("adds a Dev row with the commit hash above the version on a dev build", () => {
    const { container } = render(<RailFoot version="1.1.0" build="a1b2c3d4" />);
    expect(rows(container)).toEqual(["Theme credits · License", "Dev: a1b2c3d4", "Podium v1.1.0", "© 2026 Ed Engelking"]);
    expect(container.querySelector(".rail-foot .mono")!.textContent).toBe("a1b2c3d4");
  });

  it("keeps the -dirty mark in the hash", () => {
    const { container } = render(<RailFoot version="1.1.0" build="a1b2c3d4-dirty" />);
    expect(rows(container)[1]).toBe("Dev: a1b2c3d4-dirty");
  });

  it("leaves the version and Dev rows out when the version is not known, as before", () => {
    for (const version of [null, "unknown"]) {
      const { container } = render(<RailFoot version={version} build="a1b2c3d4" />);
      expect(rows(container)).toEqual(["Theme credits · License", "© 2026 Ed Engelking"]);
      cleanup();
    }
  });

  it("takes a class for the narrow Admin layout", () => {
    const { container } = render(<RailFoot version="1.1.0" build={null} className="afoot-narrow" />);
    expect(container.querySelector("footer")).toHaveClass("rail-foot", "afoot-narrow");
  });
});
