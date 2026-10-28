import { Router, type IRouter, type Response as ExpressResponse } from "express";
import { GetRadarResponse } from "@workspace/api-zod";
import { DEFAULT_SCORE_WEIGHTS } from "../lib/account-settings";
import { analyzeMarketSnapshot } from "../lib/analysis-engine";
import { getMarketSnapshot, getRadarAssets } from "../lib/market-data";

const router: IRouter = Router();

router.get("/radar", async (req, res) => {
  try {
    const assets = await getRadarAssets();
    const analyzedAssets = await Promise.all(assets.map(async (asset) => {
      const snapshot = await getMarketSnapshot(asset.symbol);
      const analysis = analyzeMarketSnapshot(snapshot, DEFAULT_SCORE_WEIGHTS);
      return {
        ...asset,
        sourceStatuses: snapshot.sourceStatuses,
        signal: analysis.report.confidenceBreakdown.liveAgentCount > 0
          ? analysis.report
          : null,
      };
    }));
    const ordered = [...analyzedAssets].sort((left, right) => {
      if (left.radarScore === null && right.radarScore !== null) return 1;
      if (left.radarScore !== null && right.radarScore === null) return -1;
      return (right.radarScore ?? 0) - (left.radarScore ?? 0);
    });
    const response = GetRadarResponse.parse({
      generatedAt: new Date().toISOString(),
      assets: ordered,
    });
    res.json(response);
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Unable to build market radar",
    );
    res.status(503).json({
      code: "RADAR_UNAVAILABLE",
      error: "The market radar could not be loaded.",
    });
  }
});

export default router;
