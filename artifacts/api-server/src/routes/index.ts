import { Router, type IRouter } from "express";
import healthRouter from "./health";
import gateRouter from "./gate";
import adsRouter from "./ads";
import mailRouter from "./mail";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(gateRouter);
router.use(adsRouter);
router.use(mailRouter);
router.use("/admin", adminRouter);

export default router;
