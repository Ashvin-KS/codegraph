export async function callLlm(prompt: string, url: string, timeoutMs = 8000): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        n_predict: 120,
        temperature: 0.2,
        stop: ["\n\n", "```"]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`llama.cpp returned HTTP ${response.status}`);
    }

    const data = (await response.json()) as { content?: string; stopped_word?: boolean };
    let content = (data.content ?? "").trim();
    if (!content) {
      throw new Error("llama.cpp returned empty content");
    }
    if (!data.stopped_word) {
      content = content.replace(/[^.!?\n]+$/, "").trim();
    }
    return content || (data.content ?? "").trim();
  } finally {
    clearTimeout(timeout);
  }
}
