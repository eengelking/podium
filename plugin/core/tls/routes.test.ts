// The reporter route allowlist the TLS helper forwards from and the server's gate matches against (#668, #948).
import { describe, expect, test } from "claude-code/testing";
import { REPORTER_ROUTES, reporterTarget } from "./routes.mjs";

describe("routes.mjs: the reporter routes and nothing else", () => {
  test("every allowed route is forwarded with its own method and fixed parts", () => {
    for (const [method, template] of REPORTER_ROUTES) {
      const url = template.replaceAll(":id", "x1");
      expect(reporterTarget(method, url), `${method} ${url}`).toEqual({ method, path: url });
    }
  });

  test("rebuilds the target: lowercased fixed parts, the person's ids, trailing slashes dropped, a plain query kept", () => {
    expect(reporterTarget("POST", "/api/fleet/report")).toEqual({ method: "POST", path: "/api/fleet/report" });
    expect(reporterTarget("POST", "/API/Fleet/Report//")).toEqual({ method: "POST", path: "/api/fleet/report" });
    expect(reporterTarget("GET", "/api/fleet/sessions/Ab%20c-1/asks/a1/answer?wait=25")).toEqual({ method: "GET", path: "/api/fleet/sessions/Ab%20c-1/asks/a1/answer?wait=25" });
    expect(reporterTarget("PUT", "/api/fleet/sessions/s1/diffs/d.1")).toEqual({ method: "PUT", path: "/api/fleet/sessions/s1/diffs/d.1" });
  });

  test("lets a reporter read a channel it was called into (#1034), by GET only, and not post to one", () => {
    expect(reporterTarget("GET", "/api/fleet/sessions/s1/chat/channels/group/messages?before=cur_9%3D")).toEqual({ method: "GET", path: "/api/fleet/sessions/s1/chat/channels/group/messages?before=cur_9%3D" });
    expect(reporterTarget("POST", "/api/fleet/sessions/s1/chat/channels/group/messages")).toBeNull();
    expect(reporterTarget("GET", "/api/fleet/sessions/s1/chat/channels/../messages")).toBeNull();
    expect(reporterTarget("GET", "/api/fleet/sessions/s1/chat/channels/group")).toBeNull();
  });

  test("says no to another route, method, address form, or an id that could change where the request goes", () => {
    for (const [m, u] of [
      ["GET", "/api/fleet/ping"],
      ["GET", "/api/fleet/report"],
      ["DELETE", "/api/fleet/report"],
      ["POST", "/api/reporter/renew"],
      ["POST", "/api/admin/people"],
      ["POST", "//evil.example/api/fleet/report"],
      ["POST", "http://evil.example/api/fleet/report"],
      ["POST", "*"],
      ["POST", "/api//fleet/report"],
      ["POST", "/api/fleet/report/x"],
      ["GET", "/api/fleet/sessions//peers"],
      ["GET", "/api/fleet/sessions/../peers"],
      ["GET", "/api/fleet/sessions/./peers"],
      ["GET", "/api/fleet/sessions/%2e%2E/peers"],
      ["GET", "/api/fleet/sessions/a%2Fb/peers"],
      ["GET", "/api/fleet/sessions/a%5cb/peers"],
      ["GET", "/api/fleet/sessions/a\\b/peers"],
      ["GET", "/api/fleet/sessions/a b/peers"],
      ["GET", "/api/fleet/sessions/%E0%A4%A/peers"],
      ["GET", "/api/fleet/sessions/s1/peers?a=b#frag"],
      ["GET", "/api/fleet/sessions/s1/peers?a=\r\nHost: x"],
      [undefined, "/api/fleet/report"],
      ["POST", undefined],
    ] as Array<[string | undefined, string | undefined]>) expect(reporterTarget(m, u), `${m} ${u}`).toBeNull();
  });
});
