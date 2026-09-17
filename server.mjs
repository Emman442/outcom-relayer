import "dotenv/config";
import http from "node:http";
import { createAdminOutcom } from "./OutcomVerifier.mjs";
import { settleOnSolana } from "./settle.mjs";


const port = Number(process.env.PORT || 8787);

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}



async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

http
  .createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const path = (req.url || "").split("?")[0];

    try {
      if (
        req.method === "POST" &&
        (path === "/set-trial" || path === "/set_trial")
      ) {
        const parsed = await readJson(req);
        const trialId = parsed.trialId || parsed.trial_id;
        const definitionOfDone =
          parsed.definitionOfDone || parsed.definition_of_done;
        const requirements = parsed.requirements || "";

        console.log("set_trial", trialId);
        const outcom = createAdminOutcom();
        const receipt = await outcom.setTrial(
          trialId,
          definitionOfDone,
          requirements
        );
        send(res, 200, { ok: true, receipt });
        return;
      }

      if (
        req.method === "POST" &&
        (path === "/submit-and-verify" || path === "/submit_and_verify")
      ) {
        const parsed = await readJson(req);
        const trialId = parsed.trialId || parsed.trial_id;
        const candidate = parsed.candidate || parsed.candidate_solana;
        const referrer = parsed.referrer || parsed.referrer_solana || "";
        const repo = parsed.githubRepoUrl || parsed.repo;
        const deploy = parsed.deployedAppUrl || parsed.deploy;
        const extra = parsed.extraUrl || parsed.extra || "";

        console.log("submit_and_verify", { trialId, candidate });
        const outcom = createAdminOutcom();
        const receipt = await outcom.submitAndVerify(
          trialId,
          candidate,
          referrer,
          repo,
          deploy,
          extra
        );
        send(res, 200, { ok: true, receipt });
        return;
      }

      if (req.method === "POST" && path === "/settle") {
        const parsed = await readJson(req);
        const trialId = parsed.trialId || parsed.trial_id;
        const outcom = createAdminOutcom();
        const status = await outcom.getTrialStatus(trialId);

        const verdict = String(status.verdict || "").toUpperCase();
        if (verdict !== "PASS") {
          send(res, 400, { ok: false, error: `not PASS (${verdict || "empty"})`, status });
          return;
        }

        const result = await settleOnSolana({
          trialId,
          payloadHex: status.payload_hex,
          candidate: status.candidate_solana,
          referrer: status.referrer_solana,
        });
        send(res, 200, { ok: true, result, status });
        return;
      }

      if (
        req.method === "GET" &&
        (path === "/status" || path.startsWith("/status/"))
      ) {
        const url = new URL(req.url, "http://localhost");
        const trialId =
          url.searchParams.get("trialId") || path.split("/")[2] || "";
        const outcom = createAdminOutcom();
        const status = await outcom.getTrialStatus(trialId);
        send(res, 200, { ok: true, status });
        return;
      }

      send(res, 404, { ok: false, error: `no route ${req.method} ${path}` });
    } catch (e) {
      console.error(e);
      send(res, 500, { ok: false, error: String(e.message || e) });
    }
  })
  .listen(port, () => console.log("relayer http", port));