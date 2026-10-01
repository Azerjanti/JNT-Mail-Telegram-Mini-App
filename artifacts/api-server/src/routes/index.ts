import { Router, type IRouter } from "express";
import healthRouter from "./health";
import gateRouter from "./gate";
import adsRouter from "./ads";
import mailRouter from "./mail";
import adminRouter from "./admin";
import jaiRouter from "./jai";

const router: IRouter = Router();

router.use(healthRouter);
router.use(gateRouter);
router.use(adsRouter);
router.use(mailRouter);
router.use(jaiRouter);
router.use("/admin", adminRouter);

export default router;
