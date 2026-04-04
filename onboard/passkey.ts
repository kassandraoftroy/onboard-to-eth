import { toHex } from "viem";

/** Secp256r1 order / 2 — signatures with s above this are rejected on-chain (malleability). */
export const P256_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
export const P256_HALF_N =
  0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8n;

export type WebAuthnAuth = {
  authenticatorData: `0x${string}`;
  clientDataJSON: string;
  challengeIndex: bigint;
  typeIndex: bigint;
  r: bigint;
  s: bigint;
};

function bytesToBigIntBE(b: Uint8Array): bigint {
  let x = 0n;
  for (const byte of b) x = (x << 8n) + BigInt(byte);
  return x;
}

/** Parse ES256 signature (DER) from `AuthenticatorAssertionResponse.signature`. */
export function derP256SignatureToRS(signature: ArrayBuffer): { r: bigint; s: bigint } {
  const sig = new Uint8Array(signature);
  if (sig[0] !== 0x30) throw new Error("Invalid DER signature");
  let i = 2;
  if (sig[i++] !== 0x02) throw new Error("Invalid DER signature (r)");
  const rLen = sig[i++];
  let r = sig.slice(i, i + rLen);
  i += rLen;
  if (sig[i++] !== 0x02) throw new Error("Invalid DER signature (s)");
  const sLen = sig[i++];
  let s = sig.slice(i, i + sLen);
  if (r[0] === 0) r = r.slice(1);
  if (s[0] === 0) s = s.slice(1);
  if (r.length > 32 || s.length > 32) throw new Error("Invalid r/s length");
  const rb = new Uint8Array(32);
  const sb = new Uint8Array(32);
  rb.set(r, 32 - r.length);
  sb.set(s, 32 - s.length);
  let sn = bytesToBigIntBE(sb);
  if (sn > P256_HALF_N) sn = P256_N - sn;
  return { r: bytesToBigIntBE(rb), s: sn };
}

/** Indices required by on-chain `WebAuthn.verify` (Base / Coinbase layout). */
export function webAuthnJsonIndices(clientDataJSON: string): { typeIndex: bigint; challengeIndex: bigint } {
  const typeIndex = clientDataJSON.indexOf('"type":"webauthn.get"');
  const challengeIndex = clientDataJSON.indexOf('"challenge":"');
  if (typeIndex < 0) throw new Error('clientDataJSON must contain "type":"webauthn.get"');
  if (challengeIndex < 0) throw new Error('clientDataJSON must contain "challenge":"');
  return { typeIndex: BigInt(typeIndex), challengeIndex: BigInt(challengeIndex) };
}

/** Build the struct expected by `PasskeySmartAccount.execute` from a WebAuthn assertion. */
export function webAuthnAssertionToAuth(
  assertion: AuthenticatorAssertionResponse,
  clientDataJSON: string,
): WebAuthnAuth {
  const { typeIndex, challengeIndex } = webAuthnJsonIndices(clientDataJSON);
  const { r, s } = derP256SignatureToRS(assertion.signature);
  return {
    authenticatorData: toHex(new Uint8Array(assertion.authenticatorData)),
    clientDataJSON,
    challengeIndex,
    typeIndex,
    r,
    s,
  };
}
