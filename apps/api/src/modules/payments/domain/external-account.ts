// The keyed hash of a connected account's default external account id (HP-1 condition 2).
// `hmac-sha256:k<version>:<hex>`: the key version is part of the value, so a key rotation is not
// read as a changed bank account.

const PATTERN = /^hmac-sha256:k([1-9][0-9]{0,3}):([0-9a-f]{64})$/;

/** The version of the key a stored value was made with, or null when the value is malformed. */
export function hmacVersion(value: string): number | null {
  const parts = PATTERN.exec(value);
  return parts === null ? null : Number(parts[1]);
}

/** The text before the digest, `hmac-sha256:k<version>:`, or null when malformed. */
export function hmacPrefix(value: string): string | null {
  const version = hmacVersion(value);
  return version === null ? null : `hmac-sha256:k${version}:`;
}
