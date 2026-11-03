// errors.mjs: what the helper calls a failure, and how long it waits after a 429 (#584, #585, #948).
import { describe, expect, test } from "claude-code/testing";
import { DAY_MS, RENEW_RETRY_MS, classifyError, retryDelayMs } from "./errors.mjs";

describe("errors.mjs: classifyError", () => {
  test("names the failures a person can act on", () => {
    expect(classifyError({ code: "CERT_HAS_EXPIRED" })).toBe("CERT_HAS_EXPIRED");
    expect(classifyError({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe("ALTNAME");
    expect(classifyError({ code: "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED" })).toBe("CLIENT_CERT_REJECTED");
    expect(classifyError({ code: "ERR_SSL_SSLV3_ALERT_CERTIFICATE_REVOKED" })).toBe("CLIENT_CERT_REJECTED");
    expect(classifyError({ code: "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA" })).toBe("CLIENT_CERT_REJECTED");
    expect(classifyError({ code: "ENOTFOUND" })).toBe("ENOTFOUND");
    expect(classifyError({ code: "ECONNRESET" })).toBe("ECONNRESET");
    expect(classifyError({ message: "something odd" })).toBe("UPSTREAM_ERROR");
  });

  test("passes the verification codes through and calls anything else an upstream error", () => {
    expect(classifyError({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" })).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    expect(classifyError({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]) expect(classifyError({ code })).toBe(code);
    expect(classifyError({ code: "EPIPE" })).toBe("UPSTREAM_ERROR");
    expect(classifyError({ code: "cert_lowercase" })).toBe("UPSTREAM_ERROR");
    expect(classifyError(null)).toBe("UPSTREAM_ERROR");
    expect(classifyError(undefined)).toBe("UPSTREAM_ERROR");
  });
});

describe("errors.mjs: retryDelayMs", () => {
  test("waits as long as Retry-After says, within the usual retry and a day", () => {
    expect(retryDelayMs("3000", 60_000)).toBe(3_000_000);
    expect(retryDelayMs(["120"], 60_000)).toBe(120_000);
    expect(retryDelayMs("5", 60_000)).toBe(60_000);
    expect(retryDelayMs("99999999", 60_000)).toBe(86_400_000);
    for (const bad of [undefined, "", "soon", "-5", "0", "NaN"]) expect(retryDelayMs(bad, 60_000)).toBe(60_000);
  });

  test("the usual retry is a minute unless the caller says otherwise, and a day is 24 hours", () => {
    expect(RENEW_RETRY_MS).toBe(60_000);
    expect(DAY_MS).toBe(86_400_000);
    expect(retryDelayMs(undefined)).toBe(60_000);
    expect(retryDelayMs("120")).toBe(120_000);
  });
});
