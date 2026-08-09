require("dotenv").config();
const express = require("express");
const cors = require("cors");

const router = require("./routes");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Mount management routes (gateway may forward /api/management or /management)
app.use("/management", router);
app.use("/api/management", router);

// Health Check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Management Panel API", timestamp: new Date().toISOString() });
});

// Root
app.get("/", (req, res) => {
  res.json({ success: true, message: "Management Panel API", version: "1.0.0" });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, message: "Internal server error" });
});

module.exports = app;