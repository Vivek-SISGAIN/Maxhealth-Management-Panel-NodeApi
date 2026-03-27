import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { logger } from "./logger";

let io: SocketIOServer | null = null;

export function initSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    },
    path: "/socket.io",
  });

  const managementNs = io.of("/management");

  managementNs.on("connection", (socket: Socket) => {
    logger.info({ socketId: socket.id }, "Management socket client connected");

    socket.on("join:room", (room: string) => {
      socket.join(room);
      logger.info({ socketId: socket.id, room }, "Socket joined room");
    });

    socket.on("disconnect", () => {
      logger.info({ socketId: socket.id }, "Management socket client disconnected");
    });
  });

  logger.info("Socket.IO initialized with /management namespace");
  return io;
}

export function getIO(): SocketIOServer {
  if (!io) throw new Error("Socket.IO not initialized. Call initSocket() first.");
  return io;
}

export function emitToManagement(event: string, data: unknown): void {
  try {
    getIO().of("/management").emit(event, data);
  } catch (err) {
    logger.error({ err, event }, "Failed to emit socket event");
  }
}
