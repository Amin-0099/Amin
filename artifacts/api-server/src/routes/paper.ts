import { Router, type IRouter, type Response as ExpressResponse } from "express";
import {
  ClosePaperTradeBody,
  ClosePaperTradeParams,
  ClosePaperTradeResponse,
  GetPaperPortfolioQueryParams,
  GetPaperPortfolioResponse,
  GetPaperPerformanceQueryParams,
  GetPaperPerformanceResponse,
  OpenPaperTradeBody,
  OpenPaperTradeResponse,
  ResetPaperPortfolioBody,
  ResetPaperPortfolioResponse,
} from "@workspace/api-zod";
import {
  closePaperPosition,
  getPaperPortfolio,
  getPaperPerformance,
  openPaperPosition,
  PaperServiceError,
  resetPaperPortfolio,
} from "../lib/paper-service";

const router: IRouter = Router();

function sendError(
  res: ExpressResponse,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ code, error: message });
}

function sendPaperServiceError(res: ExpressResponse, error: unknown): boolean {
  if (!(error instanceof PaperServiceError)) return false;
  sendError(res, error.status, error.code, error.message);
  return true;
}

router.get("/paper/portfolio", async (req, res) => {
  const parsed = GetPaperPortfolioQueryParams.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, "INVALID_PAPER_ACCOUNT", "Konto-ID ist ungültig.");
    return;
  }

  try {
    const portfolio = await getPaperPortfolio(parsed.data.accountId);
    res.json(GetPaperPortfolioResponse.parse(portfolio));
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Unable to read paper portfolio",
    );
    sendError(res, 503, "PAPER_PORTFOLIO_UNAVAILABLE", "Das Demo-Portfolio ist nicht verfügbar.");
  }
});

router.get("/paper/performance", async (req, res) => {
  const parsed = GetPaperPerformanceQueryParams.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, "INVALID_PAPER_ACCOUNT", "Konto-ID ist ungültig.");
    return;
  }
  try {
    const performance = await getPaperPerformance(parsed.data.accountId);
    res.json(GetPaperPerformanceResponse.parse(performance));
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Unable to calculate paper-trading performance",
    );
    sendError(res, 503, "PAPER_PERFORMANCE_UNAVAILABLE", "Die Demo-Performance ist nicht verfügbar.");
  }
});

router.post("/paper/trades", async (req, res) => {
  const parsed = OpenPaperTradeBody.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "INVALID_PAPER_TRADE", "Die Demo-Position ist ungültig.");
    return;
  }

  try {
    const result = await openPaperPosition(parsed.data);
    res.status(201).json(OpenPaperTradeResponse.parse(result));
  } catch (error) {
    if (sendPaperServiceError(res, error)) return;
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Unable to open paper position",
    );
    sendError(res, 500, "PAPER_TRADE_FAILED", "Die Demo-Position konnte nicht eröffnet werden.");
  }
});

router.post("/paper/trades/:positionId/close", async (req, res) => {
  const parsedParams = ClosePaperTradeParams.safeParse(req.params);
  const parsedBody = ClosePaperTradeBody.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    sendError(res, 400, "INVALID_PAPER_CLOSE", "Positions-ID oder Konto-ID ist ungültig.");
    return;
  }

  try {
    const result = await closePaperPosition(
      parsedParams.data.positionId,
      parsedBody.data.accountId,
    );
    res.json(ClosePaperTradeResponse.parse(result));
  } catch (error) {
    if (sendPaperServiceError(res, error)) return;
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Unable to close paper position",
    );
    sendError(res, 500, "PAPER_CLOSE_FAILED", "Die Demo-Position konnte nicht geschlossen werden.");
  }
});

router.post("/paper/reset", async (req, res) => {
  const parsed = ResetPaperPortfolioBody.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "INVALID_PAPER_RESET", "Konto-ID oder Startkapital ist ungültig.");
    return;
  }

  try {
    const portfolio = await resetPaperPortfolio(
      parsed.data.accountId,
      parsed.data.startingBalanceEur,
    );
    res.json(ResetPaperPortfolioResponse.parse(portfolio));
  } catch (error) {
    if (sendPaperServiceError(res, error)) return;
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Unable to reset paper portfolio",
    );
    sendError(res, 500, "PAPER_RESET_FAILED", "Das Demo-Portfolio konnte nicht zurückgesetzt werden.");
  }
});

export default router;
