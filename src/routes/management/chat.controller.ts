import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { managementChatMessagesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { emitToManagement } from "../../lib/socket";

const router: IRouter = Router();

const AI_RESPONSES = [
  "Based on the current dashboard data, revenue is trending upward at +12.5% compared to last month. The operations department is performing at 96.8% efficiency.",
  "The pending approvals queue has several high-priority items that require your attention today. I recommend reviewing the pre-authorization requests first.",
  "Department metrics show that Finance & Accounting has 3 active alerts. Would you like me to summarize the key issues?",
  "The current policy sales are tracking at 85% of annual target. At this rate, you are on track to exceed the target by Q4.",
  "Based on your question, I recommend reviewing the consolidated analytics section for a comprehensive view of cross-department performance.",
  "Real-time alerts indicate a high-volume claims processing situation in Operations. This may require immediate attention.",
  "Employee retention is at 94.2%, which is 0.8% below the 95% annual target. HR department is monitoring this closely.",
  "The company's market share is at 18.5%, outperforming the industry average of 12.3%. This is a strong competitive position.",
];

function generateAIResponse(userMessage: string): string {
  const lowerMsg = userMessage.toLowerCase();
  if (lowerMsg.includes("revenue") || lowerMsg.includes("sales")) return AI_RESPONSES[0];
  if (lowerMsg.includes("approval") || lowerMsg.includes("pending")) return AI_RESPONSES[1];
  if (lowerMsg.includes("alert") || lowerMsg.includes("warning")) return AI_RESPONSES[5];
  if (lowerMsg.includes("employee") || lowerMsg.includes("hr")) return AI_RESPONSES[6];
  if (lowerMsg.includes("policy") || lowerMsg.includes("insurance")) return AI_RESPONSES[3];
  if (lowerMsg.includes("market") || lowerMsg.includes("performance")) return AI_RESPONSES[7];
  if (lowerMsg.includes("department") || lowerMsg.includes("finance")) return AI_RESPONSES[2];
  return AI_RESPONSES[Math.floor(Math.random() * AI_RESPONSES.length)];
}

router.post("/chat", async (req: Request, res: Response): Promise<void> => {
  try {
    const { message, sessionId, userId } = req.body;

    if (!message || !sessionId) {
      res.status(400).json({ success: false, message: "message and sessionId are required" });
      return;
    }

    const [userMsg] = await db
      .insert(managementChatMessagesTable)
      .values({ sessionId, userId, role: "user", content: message })
      .returning();

    const aiText = generateAIResponse(message);

    const [aiMsg] = await db
      .insert(managementChatMessagesTable)
      .values({ sessionId, userId, role: "assistant", content: aiText })
      .returning();

    emitToManagement("management:chat:message", { sessionId, userMessage: userMsg, aiResponse: aiMsg });

    res.json({ success: true, data: { userMessage: userMsg, aiResponse: aiMsg } });
  } catch (err) {
    req.log.error({ err }, "Error processing chat message");
    res.status(500).json({ success: false, message: "Failed to process message" });
  }
});

router.get("/chat/:sessionId/history", async (req: Request, res: Response): Promise<void> => {
  try {
    const sessionId = req.params.sessionId as string;
    const { limit = "50" } = req.query as Record<string, string>;

    const messages = await db
      .select()
      .from(managementChatMessagesTable)
      .where(eq(managementChatMessagesTable.sessionId, sessionId))
      .orderBy(managementChatMessagesTable.createdAt)
      .limit(Math.min(200, parseInt(limit)));

    res.json({ success: true, data: messages });
  } catch (err) {
    req.log.error({ err }, "Error fetching chat history");
    res.status(500).json({ success: false, message: "Failed to fetch chat history" });
  }
});

export default router;
