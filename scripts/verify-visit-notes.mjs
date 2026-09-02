import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

function loadEnv() {
  const envPath = resolve(process.cwd(), ".env");
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv();

const SAMPLE_MESSAGE =
  "Good afternoon. What happen? Doctor, I I was involved in a car accident this morning. My left shoulder hurt and I have some cuts on my arms. Did you lose consciousness or hit your head? No, but I feel dizzy for a few minutes after the accident. Any blur vision, hearing problem, chest pain or difficulty breathing? No doctor, just shoulder pain and some swelling.";

const AGENTS = [
  ["chiefComplaint", "questionnaire-chief-complaint-agent"],
  ["msk", "questionnaire-msk-agent"],
  ["tbi", "questionnaire-tbi-agent"],
  ["medical", "questionnaire-medical-agent"],
  ["functionality", "questionnaire-functionality-agent"],
];

const backendUrl =
  process.env.HIKIGAI_BASE_URL ||
  process.env.HIKIGAI_BACKEND_URL ||
  "https://backend.hikigaiplatform.io";
const apiKey = process.env.HIKIGAI_API_KEY || "";
const projectId = process.env.HIKIGAI_PROJECT_ID || "";

const {
  buildQuestionnaireCombinedMessage,
  extractAgentOutput,
  mergeQuestionnaireAgentOutputs,
  formatQuestionnaireVisitNotesText,
} = await import("../lib/questionnaire-visit-notes.ts");

function section(label, value) {
  const text = typeof value === "string" ? value.trim() : JSON.stringify(value);
  const status = text.length > 0 ? "OK" : "EMPTY";
  console.log(`[${status}] ${label}: ${text.length} chars`);
  if (text.length > 0 && text.length <= 200) {
    console.log(`  preview: ${text}`);
  } else if (text.length > 200) {
    console.log(`  preview: ${text.slice(0, 200)}...`);
  }
}

async function getAuthToken() {
  const response = await fetch(`${backendUrl}/api/v1/auth/exchange`, {
    method: "POST",
    headers: { "X-API-Key": apiKey },
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  return data.auth_token || data.access_token || data.token || data.data?.access_token;
}

async function invokeAgent(agentSlug, input, token) {
  const response = await fetch(`${backendUrl}/api/v1/agents/${agentSlug}/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Project-ID": projectId,
    },
    body: JSON.stringify({ input, timeout: 300 }),
  });
  if (!response.ok) throw new Error(`${agentSlug}: ${await response.text()}`);
  return response.json();
}

function runUnitTbiMergeCheck() {
  const merged = mergeQuestionnaireAgentOutputs({
    chiefComplaint: { chief_complaint: "Test CC" },
    msk: { msk_section: "Test MSK" },
    tbi: extractAgentOutput({
      output: {
        tbi: "",
        final_output: {
          structured_section:
            "B) TBI (Traumatic Brain Injury):\n\nSYMPTOMS:\n[-] Blurry vision",
          inline_summary: "B) TBI: [-] Blurry vision",
        },
      },
    }),
    medical: { medical: "Test Medical" },
    functionality: { functionality: "Test Functionality" },
  });

  if (!merged.visit_notes.tbi.includes("Blurry vision")) {
    throw new Error("Unit check failed: TBI not extracted from final_output");
  }
  console.log("Unit TBI merge check: PASS\n");
}

async function waitForServer(url, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok || response.status < 500) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function callProxyApi(port) {
  const response = await fetch(`http://localhost:${port}/api/visit-notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: SAMPLE_MESSAGE,
      questionnaire_responses: [],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Proxy API failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

runUnitTbiMergeCheck();

const combinedMessage = buildQuestionnaireCombinedMessage(SAMPLE_MESSAGE, [], new Date());
const input = { message: combinedMessage };
const token = await getAuthToken();

console.log("=== DIRECT AGENT INVOCATIONS ===\n");
const parsedByAgent = {};

for (const [key, slug] of AGENTS) {
  const raw = await invokeAgent(slug, input, token);
  parsedByAgent[key] = extractAgentOutput(raw);
  console.log(`Agent ${slug}: success`);
}

const merged = mergeQuestionnaireAgentOutputs({
  chiefComplaint: parsedByAgent.chiefComplaint,
  msk: parsedByAgent.msk,
  tbi: parsedByAgent.tbi,
  medical: parsedByAgent.medical,
  functionality: parsedByAgent.functionality,
});

console.log("\n=== MERGED SECTIONS (direct pipeline) ===\n");
section("chief_complaint", merged.visit_notes.chief_complaint);
section("msk", merged.visit_notes.msk);
section("tbi", merged.visit_notes.tbi);
section("medical", merged.visit_notes.medical);
section("functionality", merged.visit_notes.functionality);

const displayText = formatQuestionnaireVisitNotesText(merged.visit_notes);
section("visit_notes_text", displayText);

const emptySections = Object.entries(merged.visit_notes).filter(
  ([, value]) => !String(value).trim()
);
if (emptySections.length > 0) {
  console.warn(
    `\nWarning: empty merged sections: ${emptySections.map(([k]) => k).join(", ")}`
  );
}

console.log("\n=== PROXY API (/api/visit-notes) ===\n");
const port = process.env.PORT || "3000";
let devProcess = null;
let startedDev = false;

try {
  const alreadyUp = await waitForServer(`http://localhost:${port}/`, 1);
  if (!alreadyUp) {
    startedDev = true;
    devProcess = spawn("npm", ["run", "dev", "--", "-p", port], {
      cwd: process.cwd(),
      stdio: "ignore",
      detached: false,
    });
    const ready = await waitForServer(`http://localhost:${port}/`, 45);
    if (!ready) throw new Error(`Dev server did not start on port ${port}`);
    console.log(`Started dev server on port ${port}`);
  } else {
    console.log(`Using existing server on port ${port}`);
  }

  const proxyData = await callProxyApi(port);

  console.log("\n=== PROXY MERGED SECTIONS ===\n");
  section("chief_complaint", proxyData.visit_notes?.chief_complaint);
  section("msk", proxyData.visit_notes?.msk);
  section("tbi", proxyData.visit_notes?.tbi);
  section("medical", proxyData.visit_notes?.medical);
  section("functionality", proxyData.visit_notes?.functionality);
  section("visit_notes_text", proxyData.visit_notes_text?.[0] || "");

  const proxyEmpty = Object.entries(proxyData.visit_notes || {}).filter(
    ([, value]) => !String(value).trim()
  );
  if (proxyEmpty.length > 0) {
    console.warn(
      `Proxy empty sections: ${proxyEmpty.map(([k]) => k).join(", ")}`
    );
  }

  if (!proxyData.visit_notes?.tbi?.trim()) {
    throw new Error("Proxy API still returned empty TBI section");
  }

  console.log("\nAll checks completed successfully.");
} finally {
  if (startedDev && devProcess) {
    devProcess.kill("SIGTERM");
  }
}
