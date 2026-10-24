import { describe, expect, test } from "bun:test";
import { serveSpaRequest } from "./spa";

// Stands in for the Workers asset binding: serves what the built SPA has at
// its root, and index.html for anything else, as `not_found_handling =
// "single-page-application"` does.
function assets(files: Record<string, string>) {
  const seen: string[] = [];
  return {
    seen,
    binding: {
      fetch: async (req: Request): Promise<Response> => {
        const path = new URL(req.url).pathname;
        seen.push(path);
        const body = files[path] ?? files["/"];
        return new Response(body, { status: 200 });
      },
    },
  };
}

const FILES = { "/": "<spa>", "/assets/app.js": "js" };

function req(path: string): Request {
  return new Request(`https://example.test${path}`);
}

async function text(res: Response | undefined): Promise<string | undefined> {
  return res === undefined
    ? undefined
    : await res.text();
}

describe("serveSpaRequest — no BASE_PATH", () => {
  test("leaves every request to the platform, which serves assets itself", async () => {
    const a = assets(FILES);
    for (const path of ["/", "/overview", "/api/health"])
      expect(await serveSpaRequest(req(path), { ASSETS: a.binding })).toBeUndefined();
    expect(a.seen).toEqual([]);
  });
});

describe("serveSpaRequest — with BASE_PATH=/u", () => {
  const env = (a: ReturnType<typeof assets>, extra: Record<string, unknown> = {}) => ({ ASSETS: a.binding, BASE_PATH: "/u", ...extra });

  test("serves a prefixed asset from the build root", async () => {
    const a = assets(FILES);
    expect(await text(await serveSpaRequest(req("/u/assets/app.js"), env(a)))).toBe("js");
    expect(a.seen).toEqual(["/assets/app.js"]);
  });

  test("serves the SPA shell for the prefix itself and for client routes", async () => {
    for (const path of [
      "/u",
      "/u/",
      "/u/overview",
      "/u/issues/42",
    ]) {
      const a = assets(FILES);
      expect(await text(await serveSpaRequest(req(path), env(a)))).toBe("<spa>");
    }
  });

  test("leaves the API to the app", async () => {
    const a = assets(FILES);
    for (const path of ["/u/api/health", "/u/api/raw/health", "/u/api"])
      expect(await serveSpaRequest(req(path), env(a))).toBeUndefined();
    expect(a.seen).toEqual([]);
  });

  test("tolerates a BASE_PATH written with slashes", async () => {
    const a = assets(FILES);
    expect(await text(await serveSpaRequest(req("/u/assets/app.js"), env(a, { BASE_PATH: "/u/" })))).toBe("js");
  });

  test("keeps the query string when it strips the prefix", async () => {
    const a = assets(FILES);
    await serveSpaRequest(req("/u/overview?x=1"), env(a));
    expect(a.seen).toEqual(["/overview"]);
  });

  test("does not treat a path that merely starts with the prefix as under it", async () => {
    const a = assets(FILES);
    expect(await serveSpaRequest(req("/user"), env(a))).toBeUndefined();
  });

  test("/ goes to the app, unless the home page is at the root", async () => {
    for (const homePage of [undefined, "off", "base"]) {
      const a = assets(FILES);
      const res = await serveSpaRequest(req("/"), env(a, { HOME_PAGE: homePage }));
      expect(await res!.text()).toContain("url=/u/");
      expect(res!.headers.get("content-type")).toContain("text/html");
    }
    const a = assets(FILES);
    expect(await text(await serveSpaRequest(req("/"), env(a, { HOME_PAGE: "root" })))).toBe("<spa>");
  });
});
