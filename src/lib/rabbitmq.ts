import amqplib from "amqplib";
import { logger } from "./logger";

const RABBITMQ_URL = process.env.RABBITMQ_URL ?? "amqp://localhost:5672";
const MANAGEMENT_EXCHANGE = "management";

type AmqpChannel = Awaited<ReturnType<Awaited<ReturnType<typeof amqplib.connect>>["createChannel"]>>;

let channel: AmqpChannel | null = null;
let isConnecting = false;

export async function connectRabbitMQ(): Promise<void> {
  if (isConnecting || channel) return;
  isConnecting = true;

  try {
    const conn = await amqplib.connect(RABBITMQ_URL);
    channel = await conn.createChannel();

    await channel.assertExchange(MANAGEMENT_EXCHANGE, "topic", { durable: true });

    const queues: { name: string; pattern: string }[] = [
      { name: "management.alerts", pattern: "management.alert.*" },
      { name: "management.approvals", pattern: "management.approval.*" },
      { name: "management.kpis", pattern: "management.kpi.*" },
    ];

    for (const q of queues) {
      await channel.assertQueue(q.name, { durable: true });
      await channel.bindQueue(q.name, MANAGEMENT_EXCHANGE, q.pattern);
    }

    logger.info({ url: RABBITMQ_URL }, "RabbitMQ connected and exchange/queues ready");
  } catch (err) {
    logger.warn({ err }, "RabbitMQ not available — running without message broker");
    channel = null;
  } finally {
    isConnecting = false;
  }
}

export function publishManagementEvent(routingKey: string, payload: unknown): void {
  if (!channel) {
    logger.debug({ routingKey }, "RabbitMQ not connected, skipping publish");
    return;
  }

  try {
    const message = Buffer.from(JSON.stringify(payload));
    channel.publish(MANAGEMENT_EXCHANGE, routingKey, message, {
      persistent: true,
      contentType: "application/json",
      timestamp: Date.now(),
    });
    logger.debug({ routingKey }, "Management event published");
  } catch (err) {
    logger.error({ err, routingKey }, "Failed to publish management event");
  }
}

export async function closeRabbitMQ(): Promise<void> {
  try {
    await channel?.close();
  } catch (_) {}
}
