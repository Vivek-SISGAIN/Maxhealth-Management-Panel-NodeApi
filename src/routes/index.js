const { Router } = require("express");
const overviewRouter = require("./management/overview.controller");
const departmentsRouter = require("./management/departments.controller");
const analyticsRouter = require("./management/analytics.controller");
const performanceRouter = require("./management/performance.controller");
const approvalsRouter = require("./management/approvals.controller");
const alertsRouter = require("./management/alerts.controller");
const chatRouter = require("./management/chat.controller");
const casesRouter = require("./management/cases.controller");

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