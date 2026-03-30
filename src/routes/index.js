const { Router } = require("express");
const healthRouter = require("./health");
const managementRouter = require("./management");

const router = Router();

router.use(healthRouter);
router.use("/", managementRouter);

module.exports = router;