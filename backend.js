import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "25mb" }));

const openai = new OpenAI({
  apiKey:
    process.env.OPENAI_API_KEY ??
    "REDACTED",
});

app.post("/ai-task", async (req, res) => {
  const { url, title, pageContext, task } = req.body;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: `
URL: ${url}
Title: ${title}

Task:
${task}

Page context:
${JSON.stringify(pageContext).slice(0, 20000)}

Return concise advice. Do not perform destructive actions.
`,
      },
    ],
  });

  res.json({ message: response.output_text });
});

app.listen(3000, () => console.log("Server running on 3000"));
