const { Router } = require("express");
const inbox = require("../../services/managementInbox.service");

const router = Router();

/** GET /management/notifications/inbox */
router.get("/notifications/inbox", async (_req, res) => {
  try {
    const data = await inbox.listInbox();
    res.json({
      success: true,
      data: data.items,
      unreadCount: data.unreadCount,
    });
  } catch (err) {
    console.error("[management/notifications]", err);
    res.status(500).json({ success: false, message: err?.message || "Inbox failed" });
  }
});

/** PUT /management/notifications/inbox/:id/read */
router.put("/notifications/inbox/:id/read", async (req, res) => {
  try {
    await inbox.markRead(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to mark read" });
  }
});

/** PUT /management/notifications/inbox/read-all */
router.put("/notifications/inbox/read-all", async (_req, res) => {
  try {
    await inbox.markAllRead();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to mark all read" });
  }
});

module.exports = router;
