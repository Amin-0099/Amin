import { Router, type IRouter, type Response as ExpressResponse } from "express";
import { GetRadarResponse } from "@workspace/api-zod";
import { getRadarAssets } from "../lib/market-data";

const router: IRouter = Router();

router.get("/radar", async (req, res) => {
  try {
    const assets = await getRadarAssets();
    const ordered = [...assets].sort((left, right) => {
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
