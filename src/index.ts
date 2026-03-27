import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { initSocket } from "./lib/socket";
import { connectRabbitMQ, closeRabbitMQ } from "./lib/rabbitmq";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = http.createServer(app);

initSocket(httpServer);

connectRabbitMQ().catch((err) => {
  logger.warn({ err }, "RabbitMQ connection failed — continuing without broker");
});

httpServer.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});

process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, shutting down");
  await closeRabbitMQ();
  httpServer.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
});
