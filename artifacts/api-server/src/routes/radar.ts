import { Router, type IRouter, type Response as ExpressResponse } from "express";
import {
  GetRadarPerformanceResponse,
  GetRadarResponse,
  GetRadarSignalsResponse,
} from "@workspace/api-zod";
import { DEFAULT_SCORE_WEIGHTS } from "../lib/account-settings";
import { analyzeMarketSnapshot } from "../lib/analysis-engine";
import { getMarketSnapshot, getRadarAssets } from "../lib/market-data";
import {
  getRadarPerformance,
  getRadarSignalHistory,
  recordAndEvaluateRadarSignals,
} from "../lib/radar-evaluation";

const router: IRouter = Router();

router.get("/radar", async (req, res) => {
  try {
    const assets = await getRadarAssets();
    const observations = await Promise.all(assets.map(async (asset) => {
      const snapshot = await getMarketSnapshot(asset.symbol);
      const analysis = analyzeMarketSnapshot(snapshot, DEFAULT_SCORE_WEIGHTS);
      return {
        asset,
        snapshot,
        analysis,
      };
    }));
    let learningStatus: "saved" | "unavailable" = "saved";
    try {
      await recordAndEvaluateRadarSignals(observations.map(({ asset, snapshot, analysis }) => ({
        asset: asset.symbol,
        snapshot,
        report: analysis.report,
      })));
    } catch (error) {
      learningStatus = "unavailable";
      req.log?.error(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "Unable to persist or evaluate radar signals",
      );
    }
    const analyzedAssets = observations.map(({ asset, snapshot, analysis }) => ({
      ...asset,
      sourceStatuses: snapshot.sourceStatuses,
      momentumRating: analysis.momentum.rating,
      signal: analysis.report,
    }));
    const ordered = [...analyzedAssets].sort((left, right) => {
      if (left.radarScore === null && right.radarScore !== null) return 1;
      if (left.radarScore !== null && right.radarScore === null) return -1;
      return (right.radarScore ?? 0) - (left.radarScore ?? 0);
    });
    const response = GetRadarResponse.parse({
      generatedAt: new Date().toISOString(),
      learningStatus,
      assets: ordered,
    });
    res.json(response);
  } catch (error) {
    req.log?.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Unable to build market radar",
    );
    res.status(503).json({
      code: "RADAR_UNAVAILABLE",
      error: "The market radar could not be loaded.",
    });
  }
});

router.get("/radar/performance", async (req, res) => {
  try {
    const performance = await getRadarPerformance();
    res.json(GetRadarPerformanceResponse.parse({ performance }));
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Unable to read radar signal performance",
    );
    res.status(503).json({
      code: "RADAR_PERFORMANCE_UNAVAILABLE",
      error: "Radar signal performance is not available.",
    });
  }
});

router.get("/radar/signals", async (req, res) => {
  try {
    const signals = await getRadarSignalHistory();
    res.json(GetRadarSignalsResponse.parse({ signals }));
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Unable to read immutable radar signal snapshots",
    );
    res.status(503).json({
      code: "RADAR_SIGNAL_HISTORY_UNAVAILABLE",
      error: "Radar signal history is not available.",
    });
  }
});

export default router;
