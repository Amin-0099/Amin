import { eq } from "drizzle-orm";
import type { DeskSettings, ScoreWeights } from "@workspace/api-zod";
import { db, paperAccounts, paperSettings } from "@workspace/db";

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  trend: 12,
  ema: 12,
  rsi: 8,
  atr: 6,
  momentum: 12,
  volume: 10,
  breakout: 10,
  news: 5,
  sentiment: 5,
  macro: 5,
  risk: 8,
  consensus: 7,
};

export async function ensurePaperAccount(
  accountId: string,
  startingBalanceEur = 10_000,
): Promise<void> {
  const amount = startingBalanceEur.toFixed(2);
  await db
    .insert(paperAccounts)
    .values({
      accountId,
      startingBalanceEur: amount,
      cashBalanceEur: amount,
    })
    .onConflictDoNothing();
  await db
    .insert(paperSettings)
    .values({ accountId, scoreWeights: DEFAULT_SCORE_WEIGHTS })
    .onConflictDoNothing();
}

export async function getDeskSettings(accountId: string): Promise<DeskSettings> {
  await ensurePaperAccount(accountId);
  const [account] = await db
    .select()
    .from(paperAccounts)
    .where(eq(paperAccounts.accountId, accountId))
    .limit(1);
  const [settings] = await db
    .select()
    .from(paperSettings)
    .where(eq(paperSettings.accountId, accountId))
    .limit(1);

  return {
    accountId,
    startingBalanceEur: Number(account?.startingBalanceEur ?? 10_000),
    scoreWeights: settings?.scoreWeights ?? DEFAULT_SCORE_WEIGHTS,
  };
}
