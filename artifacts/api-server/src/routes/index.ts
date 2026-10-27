import { Router, type IRouter } from "express";
import healthRouter from "./health";
import analysisRouter from "./analysis";
import marketScannerRouter from "./market-scanner";
import paperRouter from "./paper";
import radarRouter from "./radar";
import settingsRouter from "./settings";

const router: IRouter = Router();

router.use(healthRouter);
router.use(marketScannerRouter);
router.use(analysisRouter);
router.use(radarRouter);
router.use(paperRouter);
router.use(settingsRouter);

export default router;
