import { Router, type IRouter } from "express";
import overviewRouter from "./overview.controller";
import departmentsRouter from "./departments.controller";
import analyticsRouter from "./analytics.controller";
import performanceRouter from "./performance.controller";
import approvalsRouter from "./approvals.controller";
import alertsRouter from "./alerts.controller";
import chatRouter from "./chat.controller";

const router: IRouter = Router();

router.use(overviewRouter);
router.use(departmentsRouter);
router.use(analyticsRouter);
router.use(performanceRouter);
router.use(approvalsRouter);
router.use(alertsRouter);
router.use(chatRouter);

export default router;
