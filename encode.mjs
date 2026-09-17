export const BRIDGE_ENVELOPE_VERSION = 1;
export const WORD = 32;
export const HEAD_WORDS = 6;

export function hexToBytes(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2) throw new Error(`odd hex: ${hex}`);
  return Uint8Array.from(h.match(/.{2}/g).map((b) => parseInt(b, 16)));
}

export function bytesToHex(bytes) {
  return "0x" + Buffer.from(bytes).toString("hex");
}

function wordFromU16(n) {
  const w = Buffer.alloc(WORD);
  w.writeUInt16BE(n, 30);
  return w;
}
function wordFromU32(n) {
  const w = Buffer.alloc(WORD);
  w.writeUInt32BE(n >>> 0, 28);
  return w;
}
function wordFromU64(n) {
  const w = Buffer.alloc(WORD);
  w.writeBigUInt64BE(BigInt(n), 24);
  return w;
}
function as32(hexOrBuf) {
  if (Buffer.isBuffer(hexOrBuf) && hexOrBuf.length === 32) return hexOrBuf;
  const b = Buffer.from(hexToBytes(String(hexOrBuf)));
  if (b.length !== 32) throw new Error(`need 32 bytes, got ${b.length}`);
  return b;
}

export function keccakMessageId(parts) {
  // optional: you can pass a fixed 32-byte id instead
  return as32(parts);
}

export function encodeBridgeEnvelope({
  messageId,
  sourceEid,
  sourceSender,
  target,
  payload,
}) {
  const payloadBuf = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(hexToBytes(payload));
  const payloadOffset = HEAD_WORDS * WORD;
  const pad = (WORD - (payloadBuf.length % WORD)) % WORD;

  return Buffer.concat([
    wordFromU16(BRIDGE_ENVELOPE_VERSION),
    as32(messageId),
    wordFromU32(sourceEid),
    as32(sourceSender),
    as32(target),
    wordFromU64(payloadOffset),
    wordFromU64(payloadBuf.length),
    payloadBuf,
    Buffer.alloc(pad),
  ]);
}

/** Build a deterministic 32-byte id from trial + payload */
export function messageIdFrom(trialId, payloadHex) {
  const crypto = awaitImportCrypto();
  const h = crypto
    .createHash("sha256")
    .update(String(trialId))
    .update(payloadHex)
    .digest();
  return h;
}

function awaitImportCrypto() {
  return awaitCrypto;
}
import crypto from "node:crypto";
const awaitCrypto = crypto;

export { crypto };