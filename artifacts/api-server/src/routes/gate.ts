import { Router, type IRouter, type Request, type Response } from "express";
import { upsertTelegramUser } from "../lib/database";
import { clearMembershipCache, getGateStatus } from "../lib/gate";
import { logger } from "../lib/logger";
import { getTelegramUserFromRequest, isPreviewUser } from "../lib/telegram-auth";

const router: IRouter = Router();

async function handleGateStatus(req: Request, res: Response, force = false) {
  const user = getTelegramUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    if (!isPreviewUser(user.id)) await upsertTelegramUser(user);
    const status = await getGateStatus(user.id, force);
    const username = (process.env.SUPPORT_USERNAME || "Azerjnt").replace(/^@/, "");
    res.json({ ...status, supportUrl: `https://t.me/${username}` });
  } catch (caught) {
    logger.error({ userId: user.id, err: caught }, "Could not read gate status");
    res.status(503).json({ error: "service_unavailable" });
  }
}

router.get("/gate/status", (req, res) => {
  void handleGateStatus(req, res);
});

router.post("/gate/recheck", (req, res) => {
  const user = getTelegramUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  clearMembershipCache(user.id);
  void handleGateStatus(req, res, true);
});

export default router;
