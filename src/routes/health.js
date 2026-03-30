const { Router } = require("express");

const router = Router();

router.get("/healthz", (req, res) => {
  res.json({ status: "ok" });
});

module.exports = router;