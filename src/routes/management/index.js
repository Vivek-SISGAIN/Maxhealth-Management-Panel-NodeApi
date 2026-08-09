const { Router } = require("express");
const overviewRouter = require("./overview.controller");
const departmentsRouter = require("./departments.controller");
const analyticsRouter = require("./analytics.controller");
const performanceRouter = require("./performance.controller");
const approvalsRouter = require("./approvals.controller");
const alertsRouter = require("./alerts.controller");
const chatRouter = require("./chat.controller");
const casesRouter = require("./cases.controller");
const brmRouter = require("./brm.controller");
const medicalRouter = require("./medical.controller");
const notificationsRouter = require("./notifications.controller");
const exportsRouter = require("./exports.controller");
const hrmsRouter = require("./hrms.controller");
const opsRouter = require("./ops.controller");

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
router.use(notificationsRouter); // Management inbox (sound / browser notify)
router.use(exportsRouter); // Scheduled / on-demand CSV export + audit log
router.use(hrmsRouter); // HRMS leave / workflow / oversight proxies
router.use(opsRouter); // Operations / Booking / AML Insights

module.exports = router;
