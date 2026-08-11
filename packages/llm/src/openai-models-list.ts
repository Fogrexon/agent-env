/**
 * Shared OpenAI-compatible `GET /models` helper (OpenAI, OpenRouter, local).
 */

export async function listOpenAiCompatibleModels(options: {
  apiKey: string;
  baseURL: string;
  abortSignal?: AbortSignal;
}): Promise<string[]> {
  const base = options.baseURL.replace(/\/+$/, '');
  const url = `${base}/models`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      Accept: 'application/json',
    },
    signal: options.abortSignal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `OpenAI models list failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    data?: Array<{ id?: string }>;
  };
  const ids = (json.data ?? [])
    .map((row) => row.id?.trim())
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}
