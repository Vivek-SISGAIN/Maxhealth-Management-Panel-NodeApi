require("dotenv").config();
const app = require("./app");
const http = require("http");

const PORT = process.env.MANAGEMENT_PORT || 7008;
const server = http.createServer(app);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Management Panel API running on port ${PORT}`);
  console.log(`Endpoints: http://localhost:${PORT}/management/*`);
});