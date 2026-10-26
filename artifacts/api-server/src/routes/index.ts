import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketScannerRouter from "./market-scanner";

const router: IRouter = Router();

router.use(healthRouter);
router.use(marketScannerRouter);

export default router;
