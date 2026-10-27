const DEFAULT_MODEL = "gemini-3.8-flash";
const GENERATE_CONTENT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

type GeminiPart = { text?: string };
type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
};

export type GeminiResult = {
  text: string;
  model: string;
  generatedAt: string;
};

export class GeminiServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GeminiServiceError";
  }
}

export async function generateGeminiContent(input: {
  question: string;
  systemInstruction: string;
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  maxOutputTokens?: number;
}): Promise<GeminiResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiServiceError(
      "Gemini is not configured on the server. Add GEMINI_API_KEY in Replit Secrets.",
      "GEMINI_NOT_CONFIGURED",
      503,
    );
  }

  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
    throw new GeminiServiceError(
      "The configured Gemini model name is invalid. Set GEMINI_MODEL to a supported model ID.",
      "GEMINI_MODEL_INVALID",
      503,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const abortFromCaller = () => controller.abort();
  input.signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const response = await fetch(
      `${GENERATE_CONTENT_BASE}/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: input.systemInstruction }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: input.question }],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: input.maxOutputTokens ?? 800,
            ...(input.responseSchema
              ? {
                  responseMimeType: "application/json",
                  responseSchema: input.responseSchema,
                }
              : {}),
          },
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      if (response.status === 429 || response.status === 402) {
        throw new GeminiServiceError(
          "Gemini quota or rate limit reached. No AI analysis was generated. Check the Gemini API quota and try again later.",
          "GEMINI_QUOTA_EXCEEDED",
          429,
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new GeminiServiceError(
          "Gemini rejected the server's configured API access. Check the key and project permissions in Replit Secrets.",
          "GEMINI_ACCESS_DENIED",
          503,
        );
      }
      throw new GeminiServiceError(
        "Gemini could not complete the analysis. No AI result was generated; try again later.",
        "GEMINI_UPSTREAM_ERROR",
        502,
      );
    }

    let payload: GeminiResponse;
    try {
      payload = (await response.json()) as GeminiResponse;
    } catch {
      throw new GeminiServiceError(
        "Gemini returned an unreadable response. No AI analysis was generated.",
        "GEMINI_INVALID_RESPONSE",
        502,
      );
    }

    const text = payload.candidates
      ?.flatMap((candidate) => candidate.content?.parts?.map((part) => part.text ?? "") ?? [])
      .filter(Boolean)
      .join("\n")
      .trim();

    if (!text) {
      throw new GeminiServiceError(
        "Gemini returned no analysis text. No AI result was generated; try rephrasing the question.",
        "GEMINI_EMPTY_RESPONSE",
        502,
      );
    }

    return { text, model, generatedAt: new Date().toISOString() };
  } catch (error) {
    if (error instanceof GeminiServiceError) throw error;
    if (controller.signal.aborted) {
      if (input.signal?.aborted) {
        throw new GeminiServiceError(
          "Gemini request was stopped.",
          "GEMINI_REQUEST_CANCELLED",
          499,
        );
      }
      throw new GeminiServiceError(
        "Gemini took too long to respond. No AI analysis was generated; try again.",
        "GEMINI_REQUEST_TIMEOUT",
        504,
      );
    }
    throw new GeminiServiceError(
      "Gemini could not be reached. No AI analysis was generated; try again later.",
      "GEMINI_CONNECTION_FAILED",
      502,
    );
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}
