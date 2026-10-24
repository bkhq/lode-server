// The operator-side `lode.toml` for a registry package: a complete file a
// host can run lode with. Only keys documented by lode are written.

export const ASSET_PLACEHOLDER = "<asset filename>";
export const PUBLIC_KEY_PLACEHOLDER = "<base64url-pubkey>";

// lode expands the variable from the operator's environment; it is not a
// JavaScript template.
// eslint-disable-next-line no-template-curly-in-string
const AUTH_HEADER = "Authorization: Bearer ${LODE_REGISTRY_TOKEN}";

export interface SnippetInput {
  /** Scheme and host the registry is served from, without a trailing slash. */
  readonly origin: string;
  readonly namespace: string;
  readonly slug: string;
  readonly visibility: "public" | "private";
  /** The channel the operator follows; left out, lode's own default applies. */
  readonly channel?: string | null;
  /** The asset this host installs, or null while the package has no published asset. */
  readonly asset: {
    readonly name: string;
    readonly key_id: string | null;
    /** Launch command published with the asset; lode uses it over `[command].run`. */
    readonly run?: string | null;
  } | null;
  /** The package's active signing keys, as far as the viewer may list them. */
  readonly keys: readonly { readonly key_id: string; readonly public_key: string }[];
  /** The package's live delegation: `key_id` signs for the registered `root_key_id`. */
  readonly delegation: { readonly key_id: string; readonly root_key_id: string } | null;
  /** The package publishes a revocation list. */
  readonly hasRevocations: boolean;
}

export interface Snippet {
  readonly manifestUrl: string;
  readonly text: string;
  /** The chosen asset carries a signature, so the file enforces it. */
  readonly signed: boolean;
  /** The signing key's public half is known, so it is filled in. */
  readonly keyKnown: boolean;
  /** Nothing in the file is a placeholder: it can be used as it is. */
  readonly complete: boolean;
}

/** The read feed sits at the origin root, whatever prefix the console is under. */
export function manifestUrl(origin: string, namespace: string, slug: string): string {
  return `${origin}/r/${namespace}/${slug}/manifest.json`;
}

/** The package's revocation list, beside its manifest. */
export function revocationsUrl(origin: string, namespace: string, slug: string): string {
  return `${origin}/r/${namespace}/${slug}/revocations.json`;
}

const str = (value: string) => JSON.stringify(value);

/** The `[report]` block that sends a host's status to this registry over OTLP. */
export function reportSnippet(origin: string): string {
  return [
    "[report]",
    "# Needs lode 0.2.0 or later.",
    "# Set LODE_REGISTRY_TOKEN on the host to a token with a read grant on this package.",
    `endpoint = ${str(`${origin}/r/otlp`)}`,
    `headers = [${str(AUTH_HEADER)}]`,
    "",
  ].join("\n");
}

export function buildSnippet(input: SnippetInput): Snippet {
  const url = manifestUrl(input.origin, input.namespace, input.slug);
  const signerId = input.asset?.key_id ?? null;
  // A host trusts the root; the sub-key is accepted through the delegation the manifest carries.
  const delegated = signerId !== null && signerId === input.delegation?.key_id;
  const keyId = delegated ? input.delegation!.root_key_id : signerId;
  const key = keyId === null
    ? undefined
    : input.keys.find(k => k.key_id === keyId);

  const blocks = [
    [
      `# lode.toml for ${input.namespace}/${input.slug}`,
      "# Save it as /srv/lode/lode.toml (or $LODE_DIR/lode.toml) and start lode.",
    ],
    ["[global]", `app = ${str(input.slug)}`],
    [
      "[update]",
      `manifest = ${str(url)}`,
      `asset = ${str(input.asset?.name ?? ASSET_PLACEHOLDER)}`,
      ...(input.channel
        ? [`channel = ${str(input.channel)}`]
        : []),
      "policy = \"auto\"",
    ],
  ];
  if (keyId !== null) {
    blocks.push([
      "[trust]",
      // Older lode refuses sub-key signatures and an unknown `revocation_url`.
      ...(delegated || input.hasRevocations
        ? ["# Needs lode 0.1.0 or later."]
        : []),
      "require_signature = \"enforce\"",
      `trusted_keys = [${str(`${keyId}:${key?.public_key ?? PUBLIC_KEY_PLACEHOLDER}`)}]`,
      ...(input.hasRevocations
        ? [`revocation_url = ${str(revocationsUrl(input.origin, input.namespace, input.slug))}`]
        : []),
    ]);
  }
  if (input.visibility === "private") {
    blocks.push([
      "[http]",
      "# Set LODE_REGISTRY_TOKEN on the host to a token with a read grant on this package.",
      `headers = [${str(AUTH_HEADER)}]`,
    ]);
  }
  // An asset that publishes its launch command needs none here.
  if (!input.asset?.run) {
    blocks.push([
      "[command]",
      "# Change this if the program inside the asset has another name.",
      `run = ${str(`./${input.slug}`)}`,
    ]);
  }

  return {
    manifestUrl: url,
    text: `${blocks.map(lines => lines.join("\n")).join("\n\n")}\n`,
    signed: keyId !== null,
    keyKnown: key !== undefined,
    complete: input.asset !== null && (keyId === null || key !== undefined),
  };
}
