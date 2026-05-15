import crypto from "node:crypto";

export type EncryptedPayload = {
  iv: string;
  tag: string;
  ciphertext: string;
  keyVersion: string;
};

export function encryptSecret(plaintext: string, masterKeyBase64: string): EncryptedPayload {
  const key = Buffer.from(masterKeyBase64, "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIALS_MASTER_KEY must decode to 32 bytes");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: enc.toString("base64"),
    keyVersion: "v1",
  };
}

export function decryptSecret(payload: EncryptedPayload, masterKeyBase64: string): string {
  const key = Buffer.from(masterKeyBase64, "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIALS_MASTER_KEY must decode to 32 bytes");
  }
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

export function fingerprintUsername(username: string): string {
  return crypto.createHash("sha256").update(username.toLowerCase().trim()).digest("hex");
}
