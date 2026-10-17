import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  artifactMessage,
  canonicalCatalog,
  decodeBase64Flexible,
  delegationMessage,
  encodeBase64Url,
  keyIdOf,
  manifestExpiryMessage,
  manifestMessage,
  revocationMessage,
  verifyArtifactSignature,
  verifyEd25519,
} from "./signature";
import delegated from "./testdata/delegation-vectors.json";
import manifests from "./testdata/manifest-vectors.json";
import fixture from "./testdata/vectors.json";

// Every vector was produced by the real `lode-cli sign`; see testdata/README.md.
const { signer, other, vectors } = fixture;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function inputOf(vector: (typeof vectors)[number]) {
  return {
    publicKey: signer.publicKey,
    sig: vector.sig,
    app: vector.app,
    name: vector.name,
    version: vector.version,
    sha256: vector.sha256,
    run: vector.run,
    exec: vector.exec,
  };
}

function vectorById(id: string) {
  const vector = vectors.find(v => v.id === id);
  if (!vector)
    throw new Error(`missing vector ${id}`);
  return vector;
}

/** Replace the character at `index` with a different one of the same class. */
function flipChar(text: string, index = 0): string {
  const char = text.charAt(index);
  const replacement = char === "a" ? "b" : "a";
  return text.slice(0, index) + replacement + text.slice(index + 1);
}

/** Re-encode a base64url value as padded standard base64. */
function toPaddedStandard(value: string): string {
  const bytes = decodeBase64Flexible(value);
  if (!bytes)
    throw new Error(`not base64: ${value}`);
  return Buffer.from(bytes).toString("base64");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Buffer.from(digest).toString("hex");
}

describe("artifactMessage", () => {
  test("matches lode's canonical bytes, absent overrides as empty fields", () => {
    const message = artifactMessage({ app: "myapp", name: "app.tar.gz", version: "1.0.0", sha256: "abc" });
    expect(decoder.decode(message)).toBe("lode.artifact.v2\nmyapp\napp.tar.gz\n1.0.0\nabc\n\n");
  });

  test("null overrides encode like absent ones", () => {
    const base = { app: "myapp", name: "app.tar.gz", version: "1.0.0", sha256: "abc" };
    expect(artifactMessage({ ...base, run: null, exec: null })).toEqual(artifactMessage(base));
  });

  test("run and exec occupy distinct fields with no trailing newline", () => {
    const base = { app: "myapp", name: "app.tar.gz", version: "1.0.0", sha256: "abc" };
    expect(decoder.decode(artifactMessage({ ...base, run: "./app" }))).toBe(
      "lode.artifact.v2\nmyapp\napp.tar.gz\n1.0.0\nabc\n./app\n",
    );
    expect(decoder.decode(artifactMessage({ ...base, exec: "./app" }))).toBe(
      "lode.artifact.v2\nmyapp\napp.tar.gz\n1.0.0\nabc\n\n./app",
    );
    expect(decoder.decode(artifactMessage({ ...base, run: "./a serve", exec: "./a" }))).toBe(
      "lode.artifact.v2\nmyapp\napp.tar.gz\n1.0.0\nabc\n./a serve\n./a",
    );
  });
});

describe("base64 helpers", () => {
  // 256 bytes: every 6-bit group occurs, so `+` and `/` (standard) and `-` and
  // `_` (url-safe) all appear, and the length forces `==` padding.
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  const standard = Buffer.from(bytes).toString("base64");
  const urlSafe = encodeBase64Url(bytes);

  test("encodeBase64Url emits unpadded base64url", () => {
    expect(standard).toContain("+");
    expect(standard).toContain("/");
    expect(standard.endsWith("==")).toBe(true);
    expect(urlSafe).toBe(standard.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""));
    expect(encodeBase64Url(new Uint8Array())).toBe("");
  });

  test("decodeBase64Flexible accepts both alphabets, padded or not", () => {
    expect(decodeBase64Flexible(standard)).toEqual(bytes);
    expect(decodeBase64Flexible(standard.replace(/=+$/, ""))).toEqual(bytes);
    expect(decodeBase64Flexible(urlSafe)).toEqual(bytes);
    expect(decodeBase64Flexible(`  ${urlSafe}==\n`)).toEqual(bytes);
    expect(decodeBase64Flexible("")).toEqual(new Uint8Array());
  });

  test("decodeBase64Flexible round-trips every tail length", () => {
    for (const length of [1, 2, 3, 4, 5, 31, 32, 64]) {
      const input = bytes.slice(0, length);
      expect(decodeBase64Flexible(encodeBase64Url(input))).toEqual(input);
    }
  });

  test("decodeBase64Flexible rejects what lode rejects", () => {
    expect(decodeBase64Flexible("not-base64-!!!")).toBeNull();
    // Interior whitespace.
    expect(decodeBase64Flexible("AB CD")).toBeNull();
    // Impossible length (a single trailing symbol carries only 6 bits).
    expect(decodeBase64Flexible("AAAAA")).toBeNull();
    // Stray trailing bits: "AB" would decode to one byte with 4 bits left over.
    expect(decodeBase64Flexible("AB")).toBeNull();
    expect(decodeBase64Flexible("AAB")).toBeNull();
    // Interior padding.
    expect(decodeBase64Flexible("AA==AA")).toBeNull();
  });
});

describe("keyIdOf", () => {
  test("matches the key_id lode-cli prints", async () => {
    for (const key of [signer, other]) {
      const raw = decodeBase64Flexible(key.publicKey);
      expect(raw).toHaveLength(32);
      expect(await keyIdOf(raw!)).toBe(key.keyId);
    }
    for (const vector of vectors) expect(vector.keyId).toBe(signer.keyId);
  });
});

describe("verifyArtifactSignature", () => {
  test("covers the required vector shapes", () => {
    expect(vectors.map(v => v.id)).toEqual(["plain", "run", "exec", "run-exec", "version"]);
    expect(vectorById("plain")).toMatchObject({ run: null, exec: null });
    expect(vectorById("run").run).toBeString();
    expect(vectorById("run").exec).toBeNull();
    expect(vectorById("exec").run).toBeNull();
    expect(vectorById("exec").exec).toBeString();
    expect(vectorById("run-exec").run).toBeString();
    expect(vectorById("run-exec").exec).toBeString();
    for (const char of [".", "-", "_"]) expect(vectorById("version").version).toContain(char);
  });

  for (const vector of vectors) {
    describe(`vector ${vector.id}`, () => {
      const input = inputOf(vector);

      test("sha256 is the digest of the signed content", async () => {
        expect(await sha256Hex(vector.content)).toBe(vector.sha256);
      });

      test("verifies", async () => {
        expect(await verifyArtifactSignature(input)).toBe(true);
      });

      test("rejects a tampered sha256", async () => {
        expect(await verifyArtifactSignature({ ...input, sha256: flipChar(input.sha256) })).toBe(false);
        // The digest is bound verbatim: lode signs lowercase hex.
        expect(await verifyArtifactSignature({ ...input, sha256: input.sha256.toUpperCase() })).toBe(false);
      });

      test("rejects a tampered sig", async () => {
        expect(await verifyArtifactSignature({ ...input, sig: flipChar(input.sig) })).toBe(false);
        expect(await verifyArtifactSignature({ ...input, sig: flipChar(input.sig, 40) })).toBe(false);
      });

      test("rejects another app", async () => {
        expect(await verifyArtifactSignature({ ...input, app: flipChar(input.app) })).toBe(false);
        expect(await verifyArtifactSignature({ ...input, app: "lib" })).toBe(false);
      });

      test("rejects a tampered name", async () => {
        expect(await verifyArtifactSignature({ ...input, name: flipChar(input.name) })).toBe(false);
      });

      test("rejects a tampered version", async () => {
        expect(await verifyArtifactSignature({ ...input, version: flipChar(input.version) })).toBe(false);
      });

      test("rejects a tampered run", async () => {
        const run = input.run === null ? "./evil" : flipChar(input.run, 2);
        expect(await verifyArtifactSignature({ ...input, run })).toBe(false);
        if (input.run !== null)
          expect(await verifyArtifactSignature({ ...input, run: null })).toBe(false);
      });

      test("rejects a tampered exec", async () => {
        const exec = input.exec === null ? "./evil" : flipChar(input.exec, 2);
        expect(await verifyArtifactSignature({ ...input, exec })).toBe(false);
        if (input.exec !== null)
          expect(await verifyArtifactSignature({ ...input, exec: null })).toBe(false);
      });

      test("rejects a different key", async () => {
        expect(await verifyArtifactSignature({ ...input, publicKey: other.publicKey })).toBe(false);
      });

      test("accepts padded standard base64 for sig and key", async () => {
        const sig = toPaddedStandard(input.sig);
        const publicKey = toPaddedStandard(input.publicKey);
        expect(sig.endsWith("==")).toBe(true);
        expect(publicKey.endsWith("=")).toBe(true);
        expect(await verifyArtifactSignature({ ...input, sig })).toBe(true);
        expect(await verifyArtifactSignature({ ...input, publicKey })).toBe(true);
        expect(await verifyArtifactSignature({ ...input, sig, publicKey })).toBe(true);
      });
    });
  }

  test("run and exec are not interchangeable", async () => {
    const input = inputOf(vectorById("run"));
    expect(await verifyArtifactSignature({ ...input, run: null, exec: input.run })).toBe(false);
  });

  test("a signature does not transfer to another vector", async () => {
    const input = inputOf(vectorById("plain"));
    expect(await verifyArtifactSignature({ ...input, sig: vectorById("version").sig })).toBe(false);
  });

  test("returns false instead of throwing on malformed input", async () => {
    const input = inputOf(vectorById("plain"));
    const malformed = [
      { ...input, sig: "" },
      { ...input, sig: "not-base64-!!!" },
      { ...input, sig: input.sig.slice(0, -4) },
      { ...input, sig: `${input.sig}AAAA` },
      { ...input, publicKey: "" },
      { ...input, publicKey: "not-base64-!!!" },
      { ...input, publicKey: input.publicKey.slice(0, -4) },
      { ...input, publicKey: `${input.publicKey}AAAA` },
      // A trusted-key entry is not a bare key: the caller splits it first.
      { ...input, publicKey: `${signer.keyId}:${input.publicKey}` },
      // An ECDSA-sized key (33-byte compressed point) is not ed25519.
      { ...input, publicKey: encodeBase64Url(new Uint8Array(33).fill(2)) },
    ];
    for (const candidate of malformed) expect(await verifyArtifactSignature(candidate)).toBe(false);
  });
});

// Both manifests were signed by the real `lode-cli manifest-sign`;
// see testdata/README.md.
describe("manifest signature", () => {
  const { signed, fresh } = manifests;
  const key = manifests.signer.publicKey;

  test("the canonical catalog sorts channels and versions by byte order and keeps asset order", () => {
    const lines = canonicalCatalog(signed).split("\n");
    expect(lines.filter(line => !line.startsWith("asset\t"))).toEqual([
      "channel\tbeta\t2.0.0-rc.1",
      "channel\tstable\t1.2.0",
      // Not semver order: "1.10.0" sorts before "1.2.0".
      "version\t1.10.0",
      "version\t1.2.0",
      "version\t2.0.0-rc.1",
      "",
    ]);
    const rc = signed.versions["2.0.0-rc.1"].assets[0]!;
    expect(lines).toContain(`asset\t${rc.name}\t${rc.sha256}\t./demo serve --port 8080\t./demo`);
    const darwin = signed.versions["1.2.0"].assets[0]!;
    expect(lines).toContain(`asset\t${darwin.name}\t${darwin.sha256}\t\t`);
  });

  test("lode's signature verifies over the rebuilt message", async () => {
    const catalog = canonicalCatalog(signed);
    expect(await verifyEd25519(key, signed.sig, manifestMessage(signed.name, signed.key_id, catalog))).toBe(true);
    expect(await keyIdOf(decodeBase64Flexible(key)!)).toBe(signed.key_id);
  });

  test("lode's expiry signature verifies, and the plain signature is the same with or without an expiry", async () => {
    const catalog = canonicalCatalog(fresh);
    expect(fresh.sig).toBe(signed.sig);
    expect(await verifyEd25519(key, fresh.expires_sig, manifestExpiryMessage(fresh.name, fresh.key_id, fresh.expires, catalog))).toBe(true);
    expect(await verifyEd25519(key, fresh.expires_sig, manifestExpiryMessage(fresh.name, fresh.key_id, fresh.expires + 1, catalog))).toBe(false);
    expect(await verifyEd25519(key, fresh.expires_sig, manifestMessage(fresh.name, fresh.key_id, catalog))).toBe(false);
  });

  test("any change to what is bound breaks it; the url, size and notes are not bound", async () => {
    const verifies = async (manifest: typeof signed, name = signed.name, keyId = signed.key_id) =>
      await verifyEd25519(key, signed.sig, manifestMessage(name, keyId, canonicalCatalog(manifest)));
    const edit = (change: (copy: typeof signed) => void) => {
      const copy = structuredClone(signed);
      change(copy);
      return copy;
    };

    expect(await verifies(edit((m) => {
      m.versions["1.2.0"].assets[0]!.url = "https://elsewhere.test/x";
      m.versions["1.2.0"].assets[0]!.size = 99;
      m.versions["2.0.0-rc.1"].notes = "other notes";
    }))).toBe(true);
    expect(await verifies(edit((m) => {
      m.channels.stable.latest = "1.10.0";
    }))).toBe(false);
    expect(await verifies(edit((m) => {
      m.versions["1.2.0"].assets.reverse();
    }))).toBe(false);
    expect(await verifies(edit((m) => {
      m.versions["1.2.0"].assets[1]!.run = "./demo other";
    }))).toBe(false);
    expect(await verifies(edit((m) => {
      m.versions["2.0.0-rc.1"].assets[0]!.sha256 = "0".repeat(64);
    }))).toBe(false);
    expect(await verifies(signed, "other")).toBe(false);
    expect(await verifies(signed, signed.name, "ffffffffffffffff")).toBe(false);
  });
});

// Signed by the real `lode-cli delegate`, `manifest-sign --delegation` and
// `revoke`; see testdata/README.md.
describe("delegation", () => {
  const { root, sub, delegation } = delegated;
  const messageOf = (d: typeof delegation, keyB64 = sub.publicKey) =>
    delegationMessage(d.name, keyB64, d.not_before, d.not_after);

  test("matches lode's canonical bytes", () => {
    expect(decoder.decode(delegationMessage("myapp", "AAAA", 10, 20))).toBe("lode.delegation.v1\nmyapp\ned25519\nAAAA\n10\n20");
  });

  test("lode's root signature verifies over the rebuilt message", async () => {
    expect(delegation.key).toBe(`ed25519:${sub.keyId}:${sub.publicKey}`);
    expect(await verifyEd25519(root.publicKey, delegation.sig, messageOf(delegation))).toBe(true);
  });

  test("every bound field breaks it, and only the root's key verifies it", async () => {
    const verifies = async (d: typeof delegation) => await verifyEd25519(root.publicKey, delegation.sig, messageOf(d));
    expect(await verifies({ ...delegation, name: "other" })).toBe(false);
    expect(await verifies({ ...delegation, not_before: delegation.not_before - 1 })).toBe(false);
    expect(await verifies({ ...delegation, not_after: delegation.not_after + 1 })).toBe(false);
    expect(await verifyEd25519(root.publicKey, delegation.sig, messageOf(delegation, delegated.other.publicKey))).toBe(false);
    expect(await verifyEd25519(sub.publicKey, delegation.sig, messageOf(delegation))).toBe(false);
  });

  test("the sub-key's manifest signature verifies like a root's", async () => {
    const { manifest } = delegated;
    const catalog = canonicalCatalog(manifest);
    expect(manifest.key_id).toBe(sub.keyId);
    expect(manifest.delegation).toEqual(delegation);
    expect(await verifyEd25519(sub.publicKey, manifest.sig, manifestMessage(manifest.name, manifest.key_id, catalog))).toBe(true);
    expect(await verifyEd25519(sub.publicKey, manifest.expires_sig, manifestExpiryMessage(manifest.name, manifest.key_id, manifest.expires, catalog))).toBe(true);
  });
});

describe("revocation list", () => {
  const { root, sub, revocationsByRoot, revocationsBySub } = delegated;
  const messageOf = (list: { key_id: string; issued_at: number; revoked: string[] }) =>
    revocationMessage(list.key_id, list.issued_at, list.revoked);

  test("matches lode's canonical bytes: ids sorted and deduplicated, no trailing newline", () => {
    expect(decoder.decode(revocationMessage("k", 5, ["b", "a", "b"]))).toBe("lode.revocations.v1\nk\n5\na\nb");
    expect(decoder.decode(revocationMessage("k", 5, []))).toBe("lode.revocations.v1\nk\n5");
  });

  test("lode's root- and sub-key-signed lists verify over the rebuilt message", async () => {
    expect(revocationsByRoot.key_id).toBe(root.keyId);
    expect(await verifyEd25519(root.publicKey, revocationsByRoot.sig, messageOf(revocationsByRoot))).toBe(true);
    expect(revocationsBySub.key_id).toBe(sub.keyId);
    expect(revocationsBySub.delegation).toEqual(delegated.delegation);
    expect(await verifyEd25519(sub.publicKey, revocationsBySub.sig, messageOf(revocationsBySub))).toBe(true);
  });

  test("the order of the ids is not bound; their set, the time and the signer are", async () => {
    const verifies = async (list: typeof revocationsBySub) => await verifyEd25519(sub.publicKey, revocationsBySub.sig, messageOf(list));
    expect(await verifies({ ...revocationsBySub, revoked: [...revocationsBySub.revoked].reverse() })).toBe(true);
    expect(await verifies({ ...revocationsBySub, revoked: revocationsBySub.revoked.slice(1) })).toBe(false);
    expect(await verifies({ ...revocationsBySub, issued_at: revocationsBySub.issued_at + 1 })).toBe(false);
    expect(await verifies({ ...revocationsBySub, key_id: root.keyId })).toBe(false);
  });
});
