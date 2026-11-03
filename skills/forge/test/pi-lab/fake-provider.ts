// Registers provider "fake" pointing at tools/fake-model.mjs.
export default function (pi: any) {
  pi.registerProvider("fake", { baseUrl: `http://127.0.0.1:${process.env.FAKE_PORT}/v1`, apiKey: "fake", api: "openai-completions",
    models: [{ id: "m", name: "fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] });
}
