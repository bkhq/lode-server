import type { SnippetInput } from "./-detail-snippet";
import { describe, expect, it } from "vitest";
import { ASSET_PLACEHOLDER, buildSnippet, manifestUrl, PUBLIC_KEY_PLACEHOLDER } from "./-detail-snippet";

const KEY = { key_id: "0123456789abcdef", public_key: "pk-base64url" };

function input(overrides: Partial<SnippetInput> = {}): SnippetInput {
  return {
    origin: "https://lode.example.com",
    namespace: "abcd1234",
    slug: "myapp",
    visibility: "public",
    asset: null,
    keys: [KEY],
    ...overrides,
  };
}

describe("manifestUrl", () => {
  it("joins the origin and the feed path", () => {
    expect(manifestUrl("https://lode.example.com", "abcd1234", "myapp"))
      .toBe("https://lode.example.com/r/abcd1234/myapp/manifest.json");
  });
});

describe("buildSnippet", () => {
  it("is a complete file, with the real public key, for an asset signed with a known key", () => {
    const snippet = buildSnippet(input({ asset: { name: "myapp-linux-x64.tar.gz", key_id: KEY.key_id } }));

    expect(snippet.signed).toBe(true);
    expect(snippet.keyKnown).toBe(true);
    expect(snippet.complete).toBe(true);
    expect(snippet.text).toBe([
      "# lode.toml for abcd1234/myapp",
      "# Save it as /srv/lode/lode.toml (or $LODE_DIR/lode.toml) and start lode.",
      "",
      "[global]",
      "app = \"myapp\"",
      "",
      "[update]",
      "manifest = \"https://lode.example.com/r/abcd1234/myapp/manifest.json\"",
      "asset = \"myapp-linux-x64.tar.gz\"",
      "policy = \"auto\"",
      "",
      "[trust]",
      "require_signature = \"enforce\"",
      "trusted_keys = [\"0123456789abcdef:pk-base64url\"]",
      "",
      "[command]",
      "# Change this if the program inside the asset has another name.",
      "run = \"./myapp\"",
      "",
    ].join("\n"));
  });

  it("leaves a public key placeholder, and is not complete, for an asset signed with an unknown key", () => {
    const snippet = buildSnippet(input({ asset: { name: "myapp.tar.gz", key_id: "fedcba9876543210" } }));

    expect(snippet.signed).toBe(true);
    expect(snippet.keyKnown).toBe(false);
    expect(snippet.complete).toBe(false);
    expect(snippet.text).toContain("require_signature = \"enforce\"");
    expect(snippet.text).toContain(`trusted_keys = ["fedcba9876543210:${PUBLIC_KEY_PLACEHOLDER}"]`);
    expect(snippet.text).not.toContain(KEY.public_key);
  });

  it("has no [trust] block for an unsigned asset", () => {
    const snippet = buildSnippet(input({ asset: { name: "myapp.tar.gz", key_id: null } }));

    expect(snippet.signed).toBe(false);
    expect(snippet.keyKnown).toBe(false);
    expect(snippet.complete).toBe(true);
    expect(snippet.text).toContain("asset = \"myapp.tar.gz\"");
    expect(snippet.text).not.toContain("[trust]");
    expect(snippet.text).not.toContain("require_signature");
    expect(snippet.text).not.toContain("trusted_keys");
  });

  it("adds the [http] block for a private package only", () => {
    const priv = buildSnippet(input({ visibility: "private", asset: { name: "myapp.tar.gz", key_id: KEY.key_id } }));
    expect(priv.text).toContain([
      "[http]",
      "# Set LODE_REGISTRY_TOKEN on the host to a token with a read grant on this package.",
      // eslint-disable-next-line no-template-curly-in-string -- lode expands it, not JavaScript
      "headers = [\"Authorization: Bearer ${LODE_REGISTRY_TOKEN}\"]",
      "",
    ].join("\n"));
    // The token block follows the trust block.
    expect(priv.text.indexOf("[trust]")).toBeLessThan(priv.text.indexOf("[http]"));

    expect(buildSnippet(input()).text).not.toContain("[http]");
  });

  it("uses the asset placeholder while the package has no published asset", () => {
    const snippet = buildSnippet(input({ asset: null }));

    expect(snippet.signed).toBe(false);
    expect(snippet.complete).toBe(false);
    expect(snippet.text).toContain(`asset = "${ASSET_PLACEHOLDER}"`);
    expect(ASSET_PLACEHOLDER).toBe("<asset filename>");
    expect(snippet.text).not.toContain("[trust]");
  });

  it("puts the manifest at the origin root", () => {
    const snippet = buildSnippet(input({ origin: "https://example.com" }));

    expect(snippet.manifestUrl).toBe("https://example.com/r/abcd1234/myapp/manifest.json");
    expect(snippet.text).toContain("manifest = \"https://example.com/r/abcd1234/myapp/manifest.json\"");
  });

  it("names the channel when one is chosen and omits the key otherwise", () => {
    expect(buildSnippet(input({ channel: "beta" })).text).toContain([
      "asset = \"<asset filename>\"",
      "channel = \"beta\"",
      "policy = \"auto\"",
      "",
    ].join("\n"));
    expect(buildSnippet(input()).text).not.toContain("channel");
  });

  it("writes no [command] when the asset publishes its launch command", () => {
    const published = buildSnippet(input({ asset: { name: "myapp.tar.gz", key_id: null, run: "./bin/myapp serve" } }));
    expect(published.text).not.toContain("[command]");
    expect(buildSnippet(input({ asset: { name: "myapp.tar.gz", key_id: null, run: null } })).text).toContain("run = \"./myapp\"");
  });
});
