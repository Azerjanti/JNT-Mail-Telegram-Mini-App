import { Router, type IRouter } from "express";
import { adminRateLimit, requireAdmin } from "../lib/admin";
import adminSummaryRouter from "./admin-summary";
import adminChannelsRouter from "./admin-channels";
import adminBansRouter from "./admin-bans";
import adminAnnouncementsRouter from "./admin-announcements";
import adminAdsRouter from "./admin-ads";

const router: IRouter = Router();

router.use(adminRateLimit);
router.use(requireAdmin);
router.use(adminSummaryRouter);
router.use(adminChannelsRouter);
router.use(adminBansRouter);
router.use(adminAnnouncementsRouter);
router.use(adminAdsRouter);

export { resumePendingAnnouncements } from "./admin-announcements";
export default router;
