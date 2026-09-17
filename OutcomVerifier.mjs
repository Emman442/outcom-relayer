import { createAccount, createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";

function as0x(value) {
  if (!value) return value;
  return value.startsWith("0x") ? value : `0x${value}`;
}

export class OutcomVerifier {
  constructor(contractAddress, studioUrl, privateKey) {
    if (!contractAddress) throw new Error("GL_CONTRACT missing");
    if (!studioUrl) throw new Error("GL_RPC missing");

    this.contractAddress = as0x(contractAddress);

    const chain = {
      ...studioDevnet,
      id: 61997,
      name: "GenLayer Studio Next",
      rpcUrls: { default: { http: [studioUrl] } },
    };

    const config = {
      chain,
      endpoint: studioUrl,
    };

    if (privateKey) {
      config.account = createAccount(as0x(privateKey));
    }

    this.client = createClient(config);
  }
  async getTrialStatus(trialId) {
    return this.client.readContract({
      address: this.contractAddress,
      functionName: "get_trial_status",
      args: [String(trialId || "")],
    });
  }

  async estimateFees(functionName, args) {
    const write = {
      address: this.contractAddress,
      functionName,
      args,
    };

    if (typeof this.client.estimateTransactionFeesForWrite === "function") {
      return this.client.estimateTransactionFeesForWrite(write);
    }
    return null;
  }

  async write(functionName, args) {
    console.log("write", functionName, args);

    let fees;
    try {
      const estimate = await this.client.estimateTransactionFeesForWrite({
        address: this.contractAddress,
        functionName,
        args,
      });
      if (estimate?.feeValue && estimate.feeValue !== 0n && estimate.feeValue !== "0") {
        fees = {
          distribution: estimate.distribution,
          feeValue: estimate.feeValue,
        };
      }
    } catch (e) {
      console.warn("estimate failed, using fallback fee", e.message || e);
    }

    if (!fees) {
      fees = {
        feeValue: BigInt(process.env.GL_FALLBACK_FEE || "613822800010352"),
        distribution: {
          leaderTimeunitsAllocation: 100,
          validatorTimeunitsAllocation: 200,
          appealRounds: 0,
          rotations: [3],
          executionBudgetPerRound: 153455700000000n,
          totalMessageFees: 0n,
          maxPriceGenPerTimeUnit: 2,
          storageFeeMaxGasPrice: 300000000,
          receiptFeeMaxGasPrice: 300000000,
        },
      };
    }

    const txHash = await this.client.writeContract({
      address: this.contractAddress,
      functionName,
      args,
      value: 0n,
      fees,
    });

    return this.client.waitForTransactionReceipt({
      hash: txHash,
      waitUntil: "decided",
      retries: 60,
      interval: 5000,
    });
  }


  setTrial(trialId, definitionOfDone, requirements) {
    const id = String(trialId ?? "").trim();
    const dod = String(definitionOfDone ?? "").trim();


    if (!id) throw new Error("trialId missing");
    if (id.length > 32) throw new Error("trialId longer than 32");
    if (dod.length < 20) throw new Error("definitionOfDone too short");

    return this.write("set_trial", [String(trialId), String(definitionOfDone), String(requirements)]);
  }

  submitAndVerify(trialId, candidate, referrer, repo, deploy, extra) {
    return this.write("submit_and_verify", [
      String(trialId || ""),
      String(candidate || ""),
      String(referrer || ""),
      String(repo || ""),
      String(deploy || ""),
      String(extra || ""),
    ]);
  }
}

export function createAdminOutcom() {
  const key = process.env.GL_ADMIN_PRIVATE_KEY;
  if (!key) throw new Error("GL_ADMIN_PRIVATE_KEY missing");

  return new OutcomVerifier(
    process.env.GL_CONTRACT,
    process.env.GL_RPC,
    key
  );
}