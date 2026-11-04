// Load probe: records what Pi loaded for this launch, then exits before any model call.
import { writeFileSync } from "node:fs";
export default function (pi: any) {
  pi.registerProvider("probe", { baseUrl: "http://127.0.0.1:9/v1", apiKey: "probe", api: "openai-completions",
    models: [{ id: "m", name: "probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] });
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    await new Promise(r => setTimeout(r, Number(process.env.PROBE_WAIT ?? 4000)));
    const o = event.systemPromptOptions ?? {};
    const prompt = event.systemPrompt ?? "";
    const src = (s: any) => s ? `${s.scope ?? "?"}:${s.source ?? "?"}` : "?";
    const out = {
      contextFiles: (o.contextFiles ?? []).map((f: any) => f.path),
      skills: (o.skills ?? []).map((s: any) => s.name),
      activeTools: pi.getActiveTools(),
      tools: pi.getAllTools().map((t: any) => `${t.name} [${src(t.sourceInfo)}] ${t.exposure ?? ""}`.trim()),
      commands: pi.getCommands().map((c: any) => `${c.name} [${src(c.sourceInfo)}]`),
      markers: ["HOST-AGENTS", "PARENT-AGENTS", "PROJECT-AGENTS", "PROJECT-APPEND", "HOST-APPEND"].filter(m => prompt.includes(m)),
    };
    writeFileSync(process.env.PROBE_OUT!, JSON.stringify(out, null, 2));
    process.exit(0);
  });
}
