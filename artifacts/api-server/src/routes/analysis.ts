import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter, type Response as ExpressResponse } from "express";
import {
  GetAnalysisHistoryQueryParams,
  GetAnalysisHistoryResponse,
  GetAnalysisRunQueryParams,
  GetAnalysisRunResponse,
  StartAnalysisRunBody,
  StopAnalysisRunBody,
} from "@workspace/api-zod";
import {
  analysisAgentOutputs,
  analysisRuns,
  db,
  type StoredRunEvent,
} from "@workspace/db";
import { ensurePaperAccount } from "../lib/account-settings";
import {
  agentDefinitions,
  executeAnalysisRun,
  getAnalysisRun,
  requestStopAnalysisRun,
} from "../lib/analysis-engine";

const router: IRouter = Router();

function sendError(
  res: ExpressResponse,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ code, error: message });
}

router.post("/analysis/run", async (req, res) => {
  const parsed = StartAnalysisRunBody.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "INVALID_ANALYSIS_REQUEST", "Frage, Asset oder Konto-ID ist ungültig.");
    return;
  }

  const { accountId, asset, question } = parsed.data;
  const runId = randomUUID();
  const timestamp = new Date().toISOString();
  const initialEvent: StoredRunEvent = {
    id: 1,
    agent: "Master Agent",
    message: "Run angenommen; serverseitige Analyse wird vorbereitet.",
    timestamp,
    kind: "info",
  };

  try {
    await ensurePaperAccount(accountId);
    await db.insert(analysisRuns).values({
      id: runId,
      accountId,
      asset,
      question,
      status: "queued",
      activity: [initialEvent],
    });
    await db.insert(analysisAgentOutputs).values(
      agentDefinitions.map((agent) => ({
        runId,
        accountId,
        agentId: agent.id,
        displayName: agent.displayName,
        status: "idle" as const,
        stance: "not_evaluable" as const,
        summary: "Wartet auf den serverseitigen Run.",
        confidence: 0,
        bullishFactors: [],
        bearishFactors: [],
        risks: [],
        rationale: "",
        evidence: [],
        source: "Noch keine Quelle abgefragt",
        timestamp: new Date(timestamp),
        dataStatus: "missing" as const,
        dataSources: [],
        rawSnapshot: {},
        error: null,
      })),
    );

    void executeAnalysisRun({ runId, accountId, question, asset }).catch((error) => {
      req.log.error(
        {
          runId,
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "Background analysis runner failed",
      );
    });
    res.status(202).json({ runId, status: "queued" });
  } catch (error) {
    req.log.error(
      { runId, errorName: error instanceof Error ? error.name : "unknown" },
      "Unable to create analysis run",
    );
    sendError(res, 503, "ANALYSIS_STORAGE_UNAVAILABLE", "Der Analyse-Run konnte nicht gespeichert werden.");
  }
});

router.get("/analysis/run", async (req, res) => {
  const parsed = GetAnalysisRunQueryParams.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, "INVALID_RUN_QUERY", "Run-ID oder Konto-ID ist ungültig.");
    return;
  }
  try {
    const run = await getAnalysisRun(parsed.data.runId, parsed.data.accountId);
    if (!run) {
      sendError(res, 404, "RUN_NOT_FOUND", "Der Analyse-Run wurde nicht gefunden.");
      return;
    }
    const validated = GetAnalysisRunResponse.parse(run);
    res.json(validated);
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Unable to read analysis run",
    );
    sendError(res, 500, "ANALYSIS_READ_FAILED", "Der Analyse-Run konnte nicht geladen werden.");
  }
});

router.post("/analysis/run/stop", async (req, res) => {
  const parsed = StopAnalysisRunBody.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "INVALID_STOP_REQUEST", "Run-ID oder Konto-ID ist ungültig.");
    return;
  }
  try {
    const found = await requestStopAnalysisRun(parsed.data.runId, parsed.data.accountId);
    if (!found) {
      sendError(res, 404, "RUN_NOT_FOUND", "Der Analyse-Run wurde nicht gefunden.");
      return;
    }
    const run = await getAnalysisRun(parsed.data.runId, parsed.data.accountId);
    res.json({ runId: parsed.data.runId, status: run?.status ?? "stopped" });
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Unable to stop analysis run",
    );
    sendError(res, 500, "ANALYSIS_STOP_FAILED", "Der Analyse-Run konnte nicht gestoppt werden.");
  }
});

router.get("/analysis/history", async (req, res) => {
  const parsed = GetAnalysisHistoryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, "INVALID_HISTORY_QUERY", "Konto-ID oder Limit ist ungültig.");
    return;
  }
  try {
    const rows = await db
      .select({
        runId: analysisRuns.id,
        asset: analysisRuns.asset,
        question: analysisRuns.question,
        status: analysisRuns.status,
        finalReport: analysisRuns.finalReport,
        confidenceScore: analysisRuns.confidence,
        createdAt: analysisRuns.createdAt,
      })
      .from(analysisRuns)
      .where(eq(analysisRuns.accountId, parsed.data.accountId))
      .orderBy(desc(analysisRuns.createdAt))
      .limit(parsed.data.limit);
    const runs = rows.map((row) => {
      const report = row.finalReport as { decision?: unknown } | null;
      return {
        runId: row.runId,
        asset: row.asset,
        question: row.question,
        status: row.status,
        decision: typeof report?.decision === "string" ? report.decision : null,
        confidenceScore: row.confidenceScore,
        createdAt: row.createdAt.toISOString(),
      };
    });
    res.json(GetAnalysisHistoryResponse.parse({ runs }));
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Unable to read analysis history",
    );
    sendError(res, 500, "ANALYSIS_HISTORY_FAILED", "Die Run-Historie konnte nicht geladen werden.");
  }
});

export default router;
