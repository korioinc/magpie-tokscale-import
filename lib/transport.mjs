const ENDPOINT = "https://tokscale.ai/api/submit";

export class SubmissionError extends Error {
  constructor(message, kind, retryAfterMs = 0) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export async function submit(payload, token) {
  let response;
  const signal = AbortSignal.timeout(30000);
  try {
    response = await fetch(ENDPOINT, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify(payload),
    });
  } catch { throw new SubmissionError("Tokscale network failure or timeout; the same daily snapshot can be retried.", "retry"); }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {});
    throw new SubmissionError("Tokscale authentication/permission rejected. Replace the token before retrying.", "auth");
  }
  if (response.status === 429 || response.status >= 500) {
    const header = response.headers.get("retry-after");
    const parsed = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header || "") - Date.now();
    await response.body?.cancel().catch(() => {});
    throw new SubmissionError("Tokscale temporarily unavailable (HTTP " + response.status + ").", "retry", Number.isFinite(parsed) ? Math.max(0, parsed) : 0);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new SubmissionError("Tokscale rejected the payload (HTTP " + response.status + "). Inspect compatibility before retrying.", "permanent");
  }
  if (!response.body) throw new SubmissionError("Empty Tokscale response; success not confirmed.", "permanent");
  let text = "";
  try {
    const reader = response.body.getReader();
    let bytes = 0;
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 1024 * 1024) {
        await reader.cancel().catch(() => {});
        throw new SubmissionError("Tokscale response too large; compatibility check required.", "permanent");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof SubmissionError) throw error;
    throw new SubmissionError("Tokscale response interrupted; the same daily snapshot can be retried.", "retry");
  }
  let body;
  try { body = JSON.parse(text); }
  catch { throw new SubmissionError("Unexpected Tokscale response; compatibility check required.", "permanent"); }
  const reportedTokens = typeof body?.metrics?.totalTokens === "string" && /^(0|[1-9][0-9]*)$/.test(body.metrics.totalTokens) ? Number(body.metrics.totalTokens) : body?.metrics?.totalTokens;
  if (body?.success !== true || typeof body.submissionId !== "string" || !body.submissionId || typeof body.username !== "string" || !["create", "merge"].includes(body.mode) || !body.metrics || !Number.isSafeInteger(reportedTokens) || reportedTokens < 0 || (body.warnings !== undefined && (!Array.isArray(body.warnings) || body.warnings.some(v => typeof v !== "string")))) {
    throw new SubmissionError("Unexpected Tokscale response; success not confirmed.", "permanent");
  }
  // Never log or persist server-supplied text: it may echo credentials or private data.
  const warnings = body.warnings?.length ?? 0;
  if (warnings) throw new SubmissionError("Tokscale returned " + warnings + " warning(s); requested snapshot may not be fully applied. Check the profile before retrying.", "permanent");
  return { mode: body.mode };
}
