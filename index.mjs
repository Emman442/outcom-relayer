import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "genlayer-js";
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  encodeBridgeEnvelope,
  messageIdFrom,
  bytesToHex,
  hexToBytes,
} from "./encode.mjs";

const PROCESSED = path.resolve("processed.json");

const cfg = {
  glRpc: must("GL_RPC"),
  glContract: must("GL_CONTRACT"),
  pollMs: Number(process.env.POLL_MS || 8000),
  srcEid: Number(must("SRC_EID")),
  dstEid: Number(must("DST_EID")),
  target: must("SOLANA_TARGET"),
  srcSender: must("SRC_SENDER"),
  hubRpc: process.env.HUB_RPC || "",
  hubPk: process.env.HUB_PRIVATE_KEY || "",
  hubForwarder: process.env.HUB_FORWARDER || "",
  dstReceiver: process.env.DST_RECEIVER || "",
  lzOptions: process.env.LZ_OPTIONS || "0x00030100110100000000000000000000000000030d40",
  dryRun: String(process.env.DRY_RUN || "true") === "true",
};

function must(k) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
}

function loadProcessed() {
  if (!fs.existsSync(PROCESSED)) return {};
  return JSON.parse(fs.readFileSync(PROCESSED, "utf8"));
}
function saveProcessed(map) {
  fs.writeFileSync(PROCESSED, JSON.stringify(map, null, 2));
}

function glClient() {
  return createClient({
    endpoint: cfg.glRpc,
    // studio-next / studioDevnet — if the RC exports studioDevnet, prefer:
    // chain: studioDevnet,
  });
}

async function readStatus(client) {
  const raw = await client.readContract({
    address: cfg.glContract,
    functionName: "get_trial_status",
    args: [],
  });
  return normalizeStatus(raw);
}

function normalizeStatus(raw) {
  const s = raw && raw[0] !== undefined && typeof raw !== "object" ? raw : raw;
  const obj = Array.isArray(s)
    ? {
        trial_id: s[0],
        verdict: s[1],
        payload_hex: s[2],
      }
    : s;
  return {
    admin: obj.admin ?? "",
    trial_id: String(obj.trial_id ?? ""),
    verdict: String(obj.verdict ?? "").toUpperCase(),
    score: obj.score ?? obj.verdict_score ?? 0,
    reasoning: obj.reasoning ?? "",
    payload_hex: String(obj.payload_hex ?? "").replace(/^0x/, ""),
    candidate_solana: obj.candidate_solana ?? "",
    referrer_solana: obj.referrer_solana ?? "",
    definition_of_done: obj.definition_of_done ?? "",
  };
}

function assertPayload(hex) {
  if (!hex || hex.length < 210) {
    throw new Error(`payload_hex too short (${hex.length} chars), need 105 bytes`);
  }
  const bytes = Buffer.from(hexToBytes(hex));
  if (bytes.length < 105) throw new Error("payload < 105 bytes");
  return bytes.subarray(0, 105);
}

function buildEnvelope(status) {
  const payload = assertPayload(status.payload_hex);
  const messageId = messageIdFrom(status.trial_id, status.payload_hex);
  const encoded = encodeBridgeEnvelope({
    messageId,
    sourceEid: cfg.srcEid,
    sourceSender: cfg.srcSender,
    target: cfg.target,
    payload,
  });
  return { messageId, payload, encoded };
}

const FORWARDER_ABI = parseAbi([
  "function quoteCallRemoteArbitrary(uint32 dstEid, bytes32 receiver, bytes payload, bytes options) view returns (uint256 nativeFee, uint256 lzTokenFee)",
  "function callRemoteArbitrary(uint32 dstEid, bytes32 receiver, bytes payload, bytes options) payable returns (bytes32 guid)",
]);

async function sendOnHub(encoded) {
  if (!cfg.hubRpc || !cfg.hubPk || !cfg.hubForwarder || !cfg.dstReceiver) {
    throw new Error(
      "Hub send not configured. Set HUB_RPC, HUB_PRIVATE_KEY, HUB_FORWARDER, DST_RECEIVER or DRY_RUN=true"
    );
  }
  const account = privateKeyToAccount(
    cfg.hubPk.startsWith("0x") ? cfg.hubPk : `0x${cfg.hubPk}`
  );
  const publicClient = createPublicClient({ transport: http(cfg.hubRpc) });
  const wallet = createWalletClient({
    account,
    transport: http(cfg.hubRpc),
  });

  const receiver = cfg.dstReceiver.startsWith("0x")
    ? cfg.dstReceiver
    : `0x${cfg.dstReceiver}`;

  let nativeFee = 0n;
  try {
    const quote = await publicClient.readContract({
      address: cfg.hubForwarder,
      abi: FORWARDER_ABI,
      functionName: "quoteCallRemoteArbitrary",
      args: [cfg.dstEid, receiver, bytesToHex(encoded), cfg.lzOptions],
    });
    nativeFee = Array.isArray(quote) ? BigInt(quote[0]) : BigInt(quote.nativeFee ?? quote);
    console.log("quoted nativeFee wei", nativeFee.toString());
  } catch (e) {
    console.warn("quote failed, sending 0 value (only ok on mock hub)", e.shortMessage || e.message);
  }

  const hash = await wallet.writeContract({
    address: cfg.hubForwarder,
    abi: FORWARDER_ABI,
    functionName: "callRemoteArbitrary",
    args: [cfg.dstEid, receiver, bytesToHex(encoded), cfg.lzOptions],
    value: nativeFee,
    account,
  });
  return hash;
}

async function dispatch(status) {
  if (status.verdict !== "PASS" && status.verdict !== "FAIL") {
    console.log("no verdict yet", status.trial_id || "(no trial)");
    return { skipped: "no-verdict" };
  }

  const key = `${status.trial_id}:${status.payload_hex}`;
  const done = loadProcessed();
  if (done[key]) {
    console.log("already dispatched", done[key]);
    return { skipped: "duplicate", ...done[key] };
  }

  const { messageId, encoded, payload } = buildEnvelope(status);
  const out = {
    trial_id: status.trial_id,
    verdict: status.verdict,
    score: String(status.score),
    payload_hex: Buffer.from(payload).toString("hex"),
    message_id: Buffer.from(messageId).toString("hex"),
    envelope_hex: encoded.toString("hex"),
    src_eid: cfg.srcEid,
    dst_eid: cfg.dstEid,
  };
  console.log(JSON.stringify(out, null, 2));

  if (cfg.dryRun) {
    fs.writeFileSync("last-envelope.json", JSON.stringify(out, null, 2));
    console.log("DRY_RUN=true — envelope written to last-envelope.json");
    return { dryRun: true, ...out };
  }

  const tx = await sendOnHub(encoded);
  done[key] = { tx, at: new Date().toISOString(), verdict: status.verdict };
  saveProcessed(done);
  console.log("hub tx", tx);
  return { tx, ...out };
}

async function once() {
  const client = glClient();
  const status = await readStatus(client);
  console.log("status", {
    trial_id: status.trial_id,
    verdict: status.verdict,
    payload_len: status.payload_hex.length,
  });
  return dispatch(status);
}

async function watch() {
  const client = glClient();
  console.log("watching", cfg.glContract, "every", cfg.pollMs, "ms");
  for (;;) {
    try {
      const status = await readStatus(client);
      if (status.verdict === "PASS" || status.verdict === "FAIL") {
        await dispatch(status);
      } else {
        process.stdout.write(".");
      }
    } catch (e) {
      console.error("\npoll error", e.message || e);
    }
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
}

const cmd = process.argv[2] || "once";
if (cmd === "watch") watch();
else once().catch((e) => {
  console.error(e);
  process.exit(1);
});