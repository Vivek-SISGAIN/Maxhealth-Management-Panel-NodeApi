const { Router } = require("express");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const router = Router();

// Transform database fields to frontend format
const transformMessage = (msg) => ({
  id: msg.Id,
  sessionId: msg.SessionId,
  userId: msg.UserId,
  role: msg.Role,
  content: msg.Content,
  createdAt: msg.CreatedAt
});

const AI_RESPONSES = [
  "Based on the current dashboard data, revenue is trending upward at +12.5% compared to last month.",
  "The pending approvals queue has several high-priority items that require your attention today.",
  "Department metrics show that Finance & Accounting has 3 active alerts.",
  "The current policy sales are tracking at 85% of annual target.",
  "Based on your question, I recommend reviewing the consolidated analytics section.",
  "Real-time alerts indicate a high-volume claims processing situation in Operations.",
  "Employee retention is at 94.2%, which is 0.8% below the 95% annual target.",
  "The company's market share is at 18.5%, outperforming the industry average of 12.3%."
];

function generateAIResponse(userMessage) {
  const lowerMsg = userMessage.toLowerCase();
  if (lowerMsg.indexOf("revenue") !== -1 || lowerMsg.indexOf("sales") !== -1) return AI_RESPONSES[0];
  if (lowerMsg.indexOf("approval") !== -1 || lowerMsg.indexOf("pending") !== -1) return AI_RESPONSES[1];
  if (lowerMsg.indexOf("alert") !== -1 || lowerMsg.indexOf("warning") !== -1) return AI_RESPONSES[5];
  if (lowerMsg.indexOf("employee") !== -1 || lowerMsg.indexOf("hr") !== -1) return AI_RESPONSES[6];
  if (lowerMsg.indexOf("policy") !== -1 || lowerMsg.indexOf("insurance") !== -1) return AI_RESPONSES[3];
  if (lowerMsg.indexOf("market") !== -1 || lowerMsg.indexOf("performance") !== -1) return AI_RESPONSES[7];
  if (lowerMsg.indexOf("department") !== -1 || lowerMsg.indexOf("finance") !== -1) return AI_RESPONSES[2];
  return AI_RESPONSES[Math.floor(Math.random() * AI_RESPONSES.length)];
}

router.post("/chat", async (req, res) => {
  try {
    const { message, sessionId, userId } = req.body;
    if (!message || !sessionId) {
      res.status(400).json({ success: false, message: "message and sessionId are required" });
      return;
    }

    const userMessage = await prisma.managementChatMessage.create({
      data: { SessionId: sessionId, UserId: userId, Role: 'user', Content: message }
    });

    const aiText = generateAIResponse(message);
    const aiMessage = await prisma.managementChatMessage.create({
      data: { SessionId: sessionId, UserId: userId, Role: 'assistant', Content: aiText }
    });

    res.json({ success: true, data: { 
      userMessage: transformMessage(userMessage), 
      aiResponse: transformMessage(aiMessage) 
    }});
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to process chat" });
  }
});

router.get("/chat/:sessionId/history", async (req, res) => {
  try {
    const messages = await prisma.managementChatMessage.findMany({
      where: { SessionId: req.params.sessionId },
      orderBy: { CreatedAt: 'asc' }
    });
    res.json({ success: true, data: messages.map(transformMessage) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch history" });
  }
});

module.exports = router;