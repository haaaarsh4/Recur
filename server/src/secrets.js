import crypto from "crypto";

const VERSION = "v1";
const keySource = process.env.INTEGRATION_ENCRYPTION_KEY || process.env.JWT_SECRET || "recur-development-secret";
const KEY = crypto.createHash("sha256").update(keySource).digest();

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptSecret(value) {
  if (!value || !String(value).startsWith(`${VERSION}.`)) return null;
  try {
    const [, ivText, tagText, encryptedText] = String(value).split(".");
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
  } catch (e) {
    return null;
  }
}

export { encryptSecret, decryptSecret };
