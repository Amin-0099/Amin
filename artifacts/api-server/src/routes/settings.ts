import { Router, type IRouter, type Response as ExpressResponse } from "express";
import {
  GetDeskSettingsQueryParams,
  GetDeskSettingsResponse,
  UpdateDeskSettingsBody,
  UpdateDeskSettingsResponse,
} from "@workspace/api-zod";
import { getDeskSettings } from "../lib/account-settings";
import { PaperServiceError, updateDeskSettings } from "../lib/paper-service";

const router: IRouter = Router();

function sendError(
  res: ExpressResponse,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ code, error: message });
}

router.get("/settings", async (req, res) => {
  const parsed = GetDeskSettingsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, "INVALID_SETTINGS_ACCOUNT", "Konto-ID ist ungültig.");
    return;
  }

  try {
    const settings = await getDeskSettings(parsed.data.accountId);
    res.json(GetDeskSettingsResponse.parse(settings));
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Unable to read desk settings",
    );
    sendError(res, 503, "SETTINGS_UNAVAILABLE", "Die Einstellungen sind nicht verfügbar.");
  }
});

router.put("/settings", async (req, res) => {
  const parsed = UpdateDeskSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "INVALID_SETTINGS", "Die Einstellungen sind ungültig.");
    return;
  }

  try {
    const settings = await updateDeskSettings(parsed.data.accountId, {
      startingBalanceEur: parsed.data.startingBalanceEur,
      scoreWeights: parsed.data.scoreWeights,
    });
    res.json(UpdateDeskSettingsResponse.parse(settings));
  } catch (error) {
    if (error instanceof PaperServiceError) {
      sendError(res, error.status, error.code, error.message);
      return;
    }
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Unable to update desk settings",
    );
    sendError(res, 500, "SETTINGS_UPDATE_FAILED", "Die Einstellungen konnten nicht gespeichert werden.");
  }
});

export default router;
