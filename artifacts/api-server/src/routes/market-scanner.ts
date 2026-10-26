import { Router, type IRouter, type Response } from "express";
import {
  AnalyzeMarketScannerBody,
  AnalyzeMarketScannerResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const MODEL = "gemini-3.8-flash";
const GENERATE_CONTENT_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const REQUEST_TIMEOUT_MS = 30_000;
const MARKET_SCANNER_INSTRUCTION = [
  "You are AMIN AI DESK's Market Scanner, a market-analysis specialist.",
  "Analyze the user's market question carefully and give a concise, balanced response.",
  "You have no live market-data tools or feeds. Do not invent or imply current prices,",
  "charts, volume, headlines, social posts, on-chain data, or timestamps. Separate",
  "information stated in the question from assumptions and general analysis.",
  "Include relevant bullish considerations, bearish considerations, key risks, and",
  "what evidence would be needed to confirm the view. If the question lacks enough",
  "context, say what is missing. This is general information, not financial advice.",
  "Do not suggest or execute transactions.",
].join(" ");

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
};

function sendError(
  res: Response,
  status: number,
  code: string,
  error: string,
): void {
  res.status(status).json({ code, error });
}

router.post("/market-scanner/analyze", async (req, res): Promise<void> => {
  const parsedBody = AnalyzeMarketScannerBody.safeParse(req.body);
  const question =
    parsedBody.success && typeof parsedBody.data.question === "string"
      ? parsedBody.data.question.trim()
      : "";

  if (!parsedBody.success || !question) {
    sendError(
      res,
      400,
      "INVALID_QUESTION",
      "Enter a market-analysis question between 1 and 2000 characters.",
    );
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    sendError(
      res,
      503,
      "GEMINI_NOT_CONFIGURED",
      "Gemini is not configured on the server. Add GEMINI_API_KEY in Replit Secrets.",
    );
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let upstream: Response;

  try {
    upstream = await fetch(GENERATE_CONTENT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: MARKET_SCANNER_INSTRUCTION }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: question }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 800,
        },
      }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      req.log.warn({ code: "GEMINI_REQUEST_TIMEOUT" }, "Market Scanner Gemini request timed out");
      sendError(
        res,
        504,
        "GEMINI_REQUEST_TIMEOUT",
        "Gemini took too long to respond. No Market Scanner analysis was generated; try again.",
      );
      return;
    }

    req.log.warn({ code: "GEMINI_CONNECTION_FAILED" }, "Market Scanner Gemini connection failed");
    sendError(
      res,
      502,
      "GEMINI_CONNECTION_FAILED",
      "Gemini could not be reached. No Market Scanner analysis was generated; try again later.",
    );
    return;
  } finally {
    clearTimeout(timeout);
  }

  if (!upstream.ok) {
    if (upstream.status === 429 || upstream.status === 402) {
      req.log.warn({ upstreamStatus: upstream.status }, "Market Scanner Gemini quota limit reached");
      sendError(
        res,
        429,
        "GEMINI_QUOTA_EXCEEDED",
        "Gemini quota or rate limit reached. No Market Scanner analysis was generated. Check the Gemini API quota and try again later.",
      );
      return;
    }

    if (upstream.status === 401 || upstream.status === 403) {
      req.log.warn({ upstreamStatus: upstream.status }, "Market Scanner Gemini access was denied");
      sendError(
        res,
        503,
        "GEMINI_ACCESS_DENIED",
        "Gemini rejected the server's configured API access. Check the key and project permissions in Replit Secrets.",
      );
      return;
    }

    req.log.warn({ upstreamStatus: upstream.status }, "Market Scanner Gemini request failed");
    sendError(
      res,
      502,
      "GEMINI_UPSTREAM_ERROR",
      "Gemini could not complete the analysis. No Market Scanner result was generated; try again later.",
    );
    return;
  }

  let payload: GeminiGenerateContentResponse;
  try {
    payload = (await upstream.json()) as GeminiGenerateContentResponse;
  } catch {
    req.log.warn({ code: "GEMINI_INVALID_RESPONSE" }, "Market Scanner Gemini response was invalid");
    sendError(
      res,
      502,
      "GEMINI_INVALID_RESPONSE",
      "Gemini returned an unreadable response. No Market Scanner analysis was generated.",
    );
    return;
  }

  const analysis = payload.candidates
    ?.flatMap((candidate) => candidate.content?.parts?.map((part) => part.text ?? "") ?? [])
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!analysis) {
    req.log.info({ code: "GEMINI_EMPTY_RESPONSE" }, "Market Scanner Gemini returned no analysis text");
    sendError(
      res,
      502,
      "GEMINI_EMPTY_RESPONSE",
      "Gemini returned no analysis text. No Market Scanner result was generated; try rephrasing the question.",
    );
    return;
  }

  const response = AnalyzeMarketScannerResponse.parse({ analysis });
  res.json(response);
});

export default router;
