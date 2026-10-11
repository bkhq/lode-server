import type { Context } from "hono";
import { describe, expect, test } from "bun:test";
import { getClientIp } from "./client-ip";

function ctx(headers: Record<string, string | undefined>, env?: Record<string, unknown>): Context {
  return {
    req: {
      // Mirrors Hono: no argument returns every header, a name returns that
      // one. Several call sites read a single header by name.
      header: (name?: string) => (name === undefined ? headers : headers[name.toLowerCase()]),
    },
    env,
  } as unknown as Context;
}

describe("getClientIp (default — TRUST_PROXY=false)", () => {
  test("ignores X-Forwarded-For", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }, { IP: { address: "127.0.0.1" } }),
      ),
    ).toBe("127.0.0.1");
  });

  test("ignores CF-Connecting-IP", () => {
    expect(
      getClientIp(
        ctx({ "cf-connecting-ip": "198.51.100.7" }, { IP: { address: "10.0.0.5" } }),
      ),
    ).toBe("10.0.0.5");
  });

  test("ignores True-Client-IP and X-Real-IP", () => {
    expect(
      getClientIp(
        ctx(
          { "true-client-ip": "198.51.100.42", "x-real-ip": "198.51.100.99" },
          { IP: { address: "192.0.2.42" } },
        ),
      ),
    ).toBe("192.0.2.42");
  });

  test("uses connection peer IP from c.env.IP.address", () => {
    expect(getClientIp(ctx({}, { IP: { address: "127.0.0.1" } }))).toBe("127.0.0.1");
  });

  test("returns 'unknown' when neither headers nor peer IP are available", () => {
    expect(getClientIp(ctx({}, {}))).toBe("unknown");
  });

  test("falls back to CF-Connecting-IP when the runtime exposes no socket", () => {
    expect(getClientIp(ctx({ "cf-connecting-ip": "198.51.100.7" }, {}))).toBe("198.51.100.7");
  });

  test("explicit TRUST_PROXY=false has the same effect as omitting config", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5" }, { IP: { address: "127.0.0.1" } }),
        { TRUST_PROXY: false },
      ),
    ).toBe("127.0.0.1");
  });
});

describe("getClientIp (TRUST_PROXY=true)", () => {
  const cfg = { TRUST_PROXY: true } as const;

  test("prefers rightmost X-Forwarded-For over X-Real-IP", () => {
    // The rightmost XFF entry is the hop the trusted proxy actually
    // controls; X-Real-IP is operator-defined and easier to misconfigure,
    // so an XFF value must win when both are present.
    expect(
      getClientIp(
        ctx(
          { "x-real-ip": "198.51.100.7", "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
          { IP: { address: "127.0.0.1" } },
        ),
        cfg,
      ),
    ).toBe("10.0.0.1");
  });

  test("falls back to rightmost entry of X-Forwarded-For when X-Real-IP is missing", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }, { IP: { address: "127.0.0.1" } }),
        cfg,
      ),
    ).toBe("10.0.0.1");
  });

  test("uses the only XFF entry when there is one", () => {
    expect(
      getClientIp(ctx({ "x-forwarded-for": "192.0.2.1" }, { IP: { address: "127.0.0.1" } }), cfg),
    ).toBe("192.0.2.1");
  });

  test("normalises mixed-case header keys", () => {
    expect(
      getClientIp(ctx({ "X-Forwarded-For": "192.0.2.1" }, { IP: { address: "127.0.0.1" } }), cfg),
    ).toBe("192.0.2.1");
  });

  test("falls back to peer IP when no proxy headers are present", () => {
    expect(getClientIp(ctx({}, { IP: { address: "127.0.0.1" } }), cfg)).toBe("127.0.0.1");
  });

  test("returns 'unknown' when neither headers nor peer IP are available", () => {
    expect(getClientIp(ctx({}, {}), cfg)).toBe("unknown");
  });

  test("uses CF-Connecting-IP as the peer when the runtime exposes no socket", () => {
    // Cloudflare Workers: there is no `c.env.IP`, and the edge overwrites
    // CF-Connecting-IP on every request, so it is the trustworthy peer.
    expect(getClientIp(ctx({ "cf-connecting-ip": "198.51.100.7" }, {}), cfg)).toBe("198.51.100.7");
  });
});
