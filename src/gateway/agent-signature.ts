import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  JsonWebKey,
} from "node:crypto";
import { canonicalBytes } from "../mandate/canonical";

const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{128}$/;

export interface AgentSignedPayload {
  mandate_id: string;
  amount: number;
  category: string;
  item_description: string;
  timestamp: number;
  nonce: string;
}

export function generateAgentKeypair(): { publicKey: string; privateKeyJwk: JsonWebKey } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  const privJwk = privateKey.export({ format: "jwk" }) as JsonWebKey;
  return { publicKey: pubJwk.x as string, privateKeyJwk: privJwk };
}

export function signAgentRequest(payload: AgentSignedPayload, privateKeyJwk: JsonWebKey): string {
  const keyObject = createPrivateKey({ key: privateKeyJwk as Record<string, unknown>, format: "jwk" });
  return cryptoSign(null, canonicalBytes(payload), keyObject).toString("hex");
}

export function verifyAgentSignature(
  payload: AgentSignedPayload,
  signatureHex: string,
  publicKeyBase64Url: string
): boolean {
  if (!SIGNATURE_PATTERN.test(signatureHex)) return false;
  if (!PUBLIC_KEY_PATTERN.test(publicKeyBase64Url)) return false;
  try {
    const keyObject = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: publicKeyBase64Url },
      format: "jwk",
    });
    return cryptoVerify(null, canonicalBytes(payload), keyObject, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}
