import fs from "node:fs";
import path from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

function loadKeypair(p) {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export async function settleOnSolana({ trialId, payloadHex, candidate, referrer }) {
  if (!payloadHex || payloadHex.length < 210) {
    throw new Error("payload_hex missing or too short");
  }

  const connection = new Connection(
    process.env.SOLANA_RPC || "https://api.devnet.solana.com",
    "confirmed"
  );
  const payer = loadKeypair(
    process.env.SOLANA_PAYER_KEYPAIR || path.resolve("../keys/id.json")
  );
  const endpoint = loadKeypair(
    process.env.MOCK_ENDPOINT_KEYPAIR || path.resolve("../keys/mock-endpoint.json")
  );

  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const idlPath = path.resolve(process.cwd(), "target/outcom.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const programId = new PublicKey(must("OUTCOM_PROGRAM_ID"));
  const program = new Program(idl, provider);
  program.programId = programId;

  const srcEid = Number(process.env.SRC_EID || "1");
  const peerHex = (process.env.PEER_ADDRESS || "0x" + "00".repeat(31) + "01").replace(
    /^0x/,
    ""
  );
  const peerBytes = Array.from(Buffer.from(peerHex, "hex"));

  const employer = new PublicKey(must("TRIAL_EMPLOYER"));
  const usdcMint = new PublicKey(must("USDC_MINT"));
  const candidatePk = new PublicKey(candidate);
  const referrerPk =
    referrer && referrer.replace(/0/g, "") !== ""
      ? new PublicKey(referrer)
      : null;

  const [oappPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("OApp")],
    programId
  );
  const eidBuf = Buffer.alloc(4);
  eidBuf.writeUInt32BE(srcEid >>> 0, 0);
  const [peerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("Peer"), oappPda.toBuffer(), eidBuf],
    programId
  );
  const [trialPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("Trial"), employer.toBuffer(), Buffer.from(trialId)],
    programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("Vault"), trialPda.toBuffer()],
    programId
  );

  const candidateAta = getAssociatedTokenAddressSync(usdcMint, candidatePk);
  const referrerAta = referrerPk
    ? getAssociatedTokenAddressSync(usdcMint, referrerPk)
    : null;

  const payload = Buffer.from(payloadHex.replace(/^0x/, ""), "hex");

  const tx = await program.methods
    .lzReceive({
      srcEid,
      sender: peerBytes,
      nonce: new anchor.BN(Date.now()),
      guid: Array.from(Buffer.alloc(32)),
      payload,
      extraData: Buffer.from([]),
    })
    .accountsPartial({
      endpointProgram: endpoint.publicKey,
      oappConfig: oappPda,
      peerConfig: peerPda,
      trialAccount: trialPda,
      vaultAccount: vaultPda,
      candidateTokenAccount: candidateAta,
      referrerTokenAccount: referrerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([endpoint])
    .rpc();

  return { tx, trialPda: trialPda.toBase58() };
}