const { Router } = require("express");
const overviewRouter = require("./management/overview.controller");
const departmentsRouter = require("./management/departments.controller");
const analyticsRouter = require("./management/analytics.controller");
const performanceRouter = require("./management/performance.controller");
const approvalsRouter = require("./management/approvals.controller");
const alertsRouter = require("./management/alerts.controller");
const chatRouter = require("./management/chat.controller");
const casesRouter = require("./management/cases.controller");
const brmRouter = require("./management/brm.controller");
const medicalRouter = require("./management/medical.controller");
const notificationsRouter = require("./management/notifications.controller");
const exportsRouter = require("./management/exports.controller");
const hrmsRouter = require("./management/hrms.controller");

const router = Router();

router.use(overviewRouter);
router.use(departmentsRouter);
router.use(analyticsRouter);
router.use(performanceRouter);
router.use(approvalsRouter);
router.use(alertsRouter);
router.use(chatRouter);
router.use(casesRouter); // Medical cases, tasks, members
router.use(brmRouter); // BRM executive insights (shared DB)
router.use(medicalRouter); // Medical Insights overview / doctor load
router.use(notificationsRouter);
router.use(exportsRouter); // Scheduled / on-demand CSV export + audit log
router.use(hrmsRouter); // HRMS leave / workflow / oversight proxies

module.exports = router;
