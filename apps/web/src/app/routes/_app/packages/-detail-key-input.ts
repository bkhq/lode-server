export type KeyInputError = "empty" | "privateKey" | "whitespace";

const RE_PRIVATE = /-----BEGIN|PRIVATE/i;
const RE_WHITESPACE = /\s/;

/**
 * Light check of a pasted public key before it is sent: catches the obvious
 * mistakes and nothing else. The server parses the key and stays the
 * authority on whether it is a valid ed25519 public key.
 */
export function keyInputError(input: string): KeyInputError | undefined {
  const key = input.trim();
  if (key === "")
    return "empty";
  // Before the whitespace check: a PEM block always spans several lines.
  if (RE_PRIVATE.test(key))
    return "privateKey";
  if (RE_WHITESPACE.test(key))
    return "whitespace";
  return undefined;
}
