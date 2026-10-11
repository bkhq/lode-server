const RE_HEX_64 = /^[0-9a-f]{64}$/;

/** Validate that an encryption key is a valid 64-char hex string. */
export function validateEncryptionKey(dekHex: string): void {
  if (!RE_HEX_64.test(dekHex)) {
    throw new Error("Invalid encryption key: expected 64-char lowercase hex string");
  }
}
