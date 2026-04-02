const { Router } = require("express");
const overviewRouter = require("./overview.controller");
const departmentsRouter = require("./departments.controller");
const analyticsRouter = require("./analytics.controller");
const performanceRouter = require("./performance.controller");
const approvalsRouter = require("./approvals.controller");
const alertsRouter = require("./alerts.controller");
const chatRouter = require("./chat.controller");
const casesRouter = require("./cases.controller");

const router = Router();

router.use(overviewRouter);
router.use(departmentsRouter);
router.use(analyticsRouter);
router.use(performanceRouter);
router.use(approvalsRouter);
router.use(alertsRouter);
router.use(chatRouter);
router.use(casesRouter); // Medical cases, tasks, members

module.exports = router;