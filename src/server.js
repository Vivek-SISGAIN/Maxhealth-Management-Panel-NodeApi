require("dotenv").config();
const app = require("./app");
const http = require("http");
const { startScheduler } = require("./services/scheduledExport.service");

const PORT = process.env.MANAGEMENT_PORT || 7008;
const server = http.createServer(app);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Management Panel API running on port ${PORT}`);
  console.log(`Endpoints: http://localhost:${PORT}/management/*`);
  try {
    startScheduler();
    console.log("Scheduled export light cron started (60s tick)");
  } catch (err) {
    console.warn("Scheduled export cron failed to start", err?.message || err);
  }
});