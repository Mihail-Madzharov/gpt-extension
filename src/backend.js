import fs from "fs";
import path from "path";
import express from "express";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "25mb" }));

const firebaseServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const firebaseServiceAccountPath =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  path.resolve(
    process.cwd(),
    "gpt-embeded-firebase-adminsdk-fbsvc-6a91347930.json",
  );
const firebaseProjectId = process.env.FIREBASE_PROJECT_ID || "gpt-embeded";
let firebaseAdminInitialized = false;
let db = null;

try {
  // Check if already initialized
  if (getApps().length > 0) {
    console.log("Firebase Admin already initialized, skipping init...");
    firebaseAdminInitialized = true;
    db = getFirestore();
  } else {
    let serviceAccount;
    let initSource;

    console.log(
      "FIREBASE_SERVICE_ACCOUNT_JSON env var set?",
      !!firebaseServiceAccountJson,
    );

    // Try JSON environment variable first
    if (firebaseServiceAccountJson) {
      console.log("Attempting to parse FIREBASE_SERVICE_ACCOUNT_JSON...");
      try {
        serviceAccount = JSON.parse(firebaseServiceAccountJson);
        initSource = "FIREBASE_SERVICE_ACCOUNT_JSON environment variable";
        console.log(`✅ Successfully parsed Firebase credentials from env var`);
        console.log(
          `  Project ID in credentials: ${serviceAccount.project_id}`,
        );
      } catch (parseError) {
        console.error(
          "❌ Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:",
          parseError.message,
        );
        throw new Error(
          `Invalid JSON in FIREBASE_SERVICE_ACCOUNT_JSON: ${parseError.message}`,
        );
      }
    } else {
      console.log(
        `Attempting to read credentials from file: ${firebaseServiceAccountPath}`,
      );
      serviceAccount = JSON.parse(
        fs.readFileSync(firebaseServiceAccountPath, "utf8"),
      );
      initSource = `file path: ${firebaseServiceAccountPath}`;
      console.log(`✅ Successfully read Firebase credentials from file`);
      console.log(`  Project ID in credentials: ${serviceAccount.project_id}`);
    }

    console.log("Initializing Firebase Admin with credentials...");
    initializeApp({
      credential: cert(serviceAccount),
      projectId: firebaseProjectId,
    });
    firebaseAdminInitialized = true;
    db = getFirestore();
    console.log(`✅ Firebase Admin initialized using ${initSource}`);
  }
} catch (error) {
  console.error(
    `❌ Firebase Admin could not initialize from credentials: ${error.message}`,
  );
  console.error("Full error:", error);
  console.warn(
    "⚠️  Firebase Admin will not be available. Credentials must be set.",
  );
}

// OAuth Configuration
const OAUTH_CONFIG = {
  clientId: process.env.OPENAI_CLIENT_ID,
  clientSecret: process.env.OPENAI_CLIENT_SECRET,
  redirectUri:
    process.env.OPENAI_REDIRECT_URI ||
    "https://gpt-extension.onrender.com/oauth/callback",
};

const GOOGLE_OAUTH_CLIENT_ID =
  process.env.GOOGLE_OAUTH_CLIENT_ID ||
  "169950079174-j1ai4pdp22dem45484iuve3tn6gokpot.apps.googleusercontent.com";

// OAuth Authorization Endpoint
app.get("/oauth/authorize", (req, res) => {
  try {
    const requestedRedirectUri = req.query.redirect_uri;
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const redirectUri = encodeURIComponent(
      requestedRedirectUri || OAUTH_CONFIG.redirectUri,
    );
    const clientId = OAUTH_CONFIG.clientId;

    if (!clientId) {
      return res.status(500).json({
        error: "OAuth not configured on backend",
      });
    }

    const encodedState = encodeURIComponent(state);
    const authUrl = `https://platform.openai.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=offline_access${state ? `&state=${encodedState}` : ""}`;
    res.redirect(authUrl);
  } catch (error) {
    console.error("OAuth authorize error:", error);
    res.status(500).json({
      error: error.message || "Failed to start OAuth flow",
    });
  }
});

// OAuth Callback Handler - Exchange code for token
app.post("/oauth/callback", async (req, res) => {
  const { code, redirectUri } = req.body;

  if (!code) {
    return res.status(400).json({
      error: "Authorization code is required",
    });
  }

  if (!OAUTH_CONFIG.clientId || !OAUTH_CONFIG.clientSecret) {
    return res.status(500).json({
      error: "OAuth not configured on backend",
    });
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch("https://api.openai.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret,
        code,
        redirect_uri: redirectUri || OAUTH_CONFIG.redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json();
      throw new Error(
        errorData.error_description || "Failed to exchange code for token",
      );
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // Optional: Verify the token by fetching user info
    const userResponse = await fetch("https://api.openai.com/v1/me", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!userResponse.ok) {
      throw new Error("Failed to verify OpenAI account");
    }

    // Return the access token as the API key
    res.json({
      apiKey: accessToken,
      expiresIn: tokenData.expires_in,
      tokenType: tokenData.token_type,
    });
  } catch (error) {
    console.error("OAuth callback error:", error);
    res.status(500).json({
      error: error.message || "OAuth authentication failed",
    });
  }
});

// AI Task Endpoint
app.post("/ai-task", async (req, res) => {
  const { url, title, pageContext, task, apiKey, screenshot, chatHistory } =
    req.body;

  // Use the provided API key or fall back to environment variable
  const key = apiKey || process.env.OPENAI_API_KEY;

  if (!key) {
    return res.status(400).json({
      error:
        "No API key provided. Please configure your OpenAI API key in the extension settings.",
    });
  }

  const openai = new OpenAI({
    apiKey: key,
  });

  try {
    const pageUrl = url || pageContext?.url || "";
    const pageTitle = title || pageContext?.title || "";

    const formatElementsList = (elements) => {
      if (!Array.isArray(elements) || elements.length === 0) {
        return "(no elements found)";
      }
      return elements
        .map((el) => {
          return `- <${el.tag}> "${el.text || "(no label)"}" selector="${el.selector || ""}" href="${el.href || ""}" value="${el.value || ""}"`;
        })
        .slice(0, 250)
        .join("\n");
    };
    const elementsText = formatElementsList(pageContext?.elements);

    const taskText = String(task || "").trim();
    const normalizedTaskText = taskText.toLowerCase();

    const normalizedChatHistory = Array.isArray(chatHistory)
      ? chatHistory
          .map((entry) => ({
            role: entry?.role === "assistant" ? "assistant" : "user",
            content: String(entry?.content || "").trim(),
          }))
          .filter((entry) => Boolean(entry.content))
          .slice(-12)
      : [];

    const chatHistoryText = normalizedChatHistory.length
      ? normalizedChatHistory
          .map((entry, index) => {
            const label = entry.role === "assistant" ? "Assistant" : "User";
            return `${index + 1}. ${label}: ${entry.content}`;
          })
          .join("\n")
      : "(no prior conversation)";

    const buildNavigationPrompt = ({ strictSelectorMode = false } = {}) => `
You are a web page assistant.

Decide the user's intent:

1. "explain"
Use this when the user asks what something means, how something works, why something happens, or asks for clarification.
Return only a plain explanation in JSON.

2. "navigate"
Use this when the user asks to go somewhere, open something, click something, find a page, submit, select, filter, search, or perform an action on the page.
Return navigation/action steps with selectors, hrefs, and URLs.

Return ONLY valid JSON.

Schema for explanation:
{
  "intent": "explain",
  "found": true,
  "confidence": 0,
  "explanation": "clear explanation only"
}

Schema for navigation:
{
  "intent": "navigate",
  "found": true,
  "confidence": 0,
  "summary": "short overview",
  "currentUrl": "${pageUrl}",
  "steps": [
    {
      "title": "short step title",
      "action": "what the user should do",
      "cssSelector": "best selector for clicking/querying the element",
      "journeySelector": "full CSS journey/path to the element",
      "href": "href value if the element is a link, otherwise empty string",
      "navigateUrl": "absolute URL to navigate to, otherwise empty string",
      "reason": "why this element was selected"
    }
  ],
  "reason": "short reason"
}

Rules:
- If the user asks a question, explanation, or asks "what/why/how", use intent="explain".
- If the user asks to navigate, click, open, go to, select, search, filter, submit, fill, or perform an action, use intent="navigate".
- For explain intent, do not return selectors, hrefs, steps, or navigation fields.
- For navigate intent, return one best matching target unless multiple steps are required.
- Use the screenshot and available page elements as the source of truth.
- Prefer exact text match, aria-label, title, placeholder, href, button text, and semantic meaning.
- If the element has href, return it in href.
- If href is relative, keep href as found and put the absolute URL in navigateUrl if possible.
- cssSelector must be the best stable selector for clicking/querying.
- journeySelector must be the full CSS path/journey to reach the element in the DOM.
- If the target cannot be found, set found=false, confidence below 80, steps=[] and explain in reason.
- Never invent selectors, hrefs, text, or URLs.
- Output valid JSON only.
- No markdown.
${strictSelectorMode ? "- CRITICAL: for navigate intent, every found step must include non-empty cssSelector and journeySelector." : ""}

Current URL: ${pageUrl}
Current Title: ${pageTitle}

User task:
${task}

Recent conversation context:
${chatHistoryText}

Available page elements:
${elementsText}
`;

    const parseJourneyFromText = (text) => {
      try {
        const parsed = JSON.parse(String(text || ""));
        if (parsed && typeof parsed === "object") {
          return parsed;
        }
      } catch {
        // Fallback below.
      }

      return {
        summary: String(text || "Follow these steps on the current page."),
        currentUrl: pageUrl,
        steps: [],
      };
    };

    const pickBestSelector = (step) => {
      if (!step || typeof step !== "object") return "";

      const candidates = [
        step.cssSelector,
        step.valueElementCssSelector,
        step.valueCssSelector,
        step.targetCssSelector,
        step.targetSelector,
        step.selector,
        step?.target?.cssSelector,
      ];

      for (const candidate of candidates) {
        const value = String(candidate || "").trim();
        if (value) return value;
      }

      return "";
    };

    const normalizeJourney = (inputJourney) => {
      const safeJourney =
        inputJourney && typeof inputJourney === "object"
          ? inputJourney
          : {
              found: false,
              confidence: 0,
              summary: "Follow these steps on the current page.",
              currentUrl: pageUrl,
              steps: [],
              reason: "Invalid journey response.",
            };

      const safeSteps = Array.isArray(safeJourney.steps)
        ? safeJourney.steps
        : [];

      return {
        intent: String(safeJourney.intent || "navigate"),
        found: Boolean(safeJourney.found),
        confidence: Number(safeJourney.confidence || 0),
        summary: String(
          safeJourney.summary || "Follow these steps on the current page.",
        ),
        currentUrl: String(safeJourney.currentUrl || pageUrl),
        explanation: String(safeJourney.explanation || ""),
        reason: String(safeJourney.reason || ""),

        steps: safeSteps.map((step) => {
          const cssSelector = pickBestSelector(step);

          return {
            title: String(step?.title || "Step"),
            action: String(step?.action || "Continue"),
            cssSelector,
            journeySelector: String(
              step?.journeySelector ||
                step?.fullCssSelector ||
                step?.cssPath ||
                cssSelector ||
                "",
            ),
            href: String(step?.href || ""),
            navigateUrl: String(step?.navigateUrl || ""),
            reason: String(step?.reason || ""),
          };
        }),
      };
    };

    const buildInputContent = (promptText) => {
      const content = [
        {
          type: "input_text",
          text: promptText,
        },
      ];

      if (screenshot) {
        content.push({
          type: "input_image",
          image_url: screenshot,
        });
      }

      return content;
    };

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: buildInputContent(buildNavigationPrompt()),
        },
      ],
    });

    let rawText = String(response.output_text || "");
    let journey = normalizeJourney(parseJourneyFromText(rawText));

    res.json({
      message: rawText,
      journey,
    });
  } catch (error) {
    console.error("OpenAI API error:", error);
    res.status(500).json({
      error: error.message || "Failed to process AI task",
    });
  }
});

function getIdTokenFromRequest(req) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function verifyGoogleIdToken(req, res) {
  if (!firebaseAdminInitialized) {
    res.status(500).json({ error: "Firebase Admin is not initialized." });
    return null;
  }

  const idToken = getIdTokenFromRequest(req);
  if (!idToken) {
    res.status(401).json({ error: "Authorization token is required." });
    return null;
  }

  try {
    const tokenInfoResponse = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    );

    if (!tokenInfoResponse.ok) {
      throw new Error("Google token verification failed");
    }

    const tokenInfo = await tokenInfoResponse.json();

    if (
      tokenInfo.iss !== "accounts.google.com" &&
      tokenInfo.iss !== "https://accounts.google.com"
    ) {
      throw new Error("Invalid token issuer");
    }

    if (!tokenInfo.sub || !tokenInfo.email) {
      throw new Error("Google token is missing account information");
    }

    return {
      uid: tokenInfo.sub,
      email: tokenInfo.email,
      name: tokenInfo.name,
      picture: tokenInfo.picture,
      audience: tokenInfo.aud,
    };
  } catch (error) {
    console.error("Failed to verify ID token:", error);
    res.status(401).json({ error: "Invalid authorization token." });
    return null;
  }
}

// Verify Google ID token and create/update user
app.post("/verify-google-token", async (req, res) => {
  const idToken = getIdTokenFromRequest(req);
  if (!idToken) {
    return res.status(401).json({ error: "Authorization token is required." });
  }

  try {
    const decodedToken = await verifyGoogleIdToken(req, res);
    if (!decodedToken) return;

    const uid = decodedToken.uid;
    const email = decodedToken.email;

    // Create or update user in Firestore
    await db.collection("users").doc(uid).set(
      {
        email,
        createdAt: FieldValue.serverTimestamp(),
        lastSignIn: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    res.json({ uid, email });
  } catch (error) {
    console.error("Failed to verify Google token:", error);
    res.status(401).json({ error: "Invalid authorization token." });
  }
});

app.get("/openai-key", async (req, res) => {
  const decodedToken = await verifyGoogleIdToken(req, res);
  if (!decodedToken) return;

  try {
    const userDoc = await db.collection("users").doc(decodedToken.uid).get();
    const data = userDoc.data() || {};
    res.json({ apiKey: data.openaiApiKey || null });
  } catch (error) {
    console.error("Failed to fetch OpenAI key:", error);
    res.status(500).json({ error: "Unable to fetch OpenAI key." });
  }
});

app.post("/openai-key", async (req, res) => {
  const decodedToken = await verifyGoogleIdToken(req, res);
  if (!decodedToken) return;

  const { openaiApiKey } = req.body;
  if (!openaiApiKey || typeof openaiApiKey !== "string") {
    return res.status(400).json({ error: "openaiApiKey is required." });
  }

  try {
    await db.collection("users").doc(decodedToken.uid).set(
      {
        openaiApiKey,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    res.json({ ok: true });
  } catch (error) {
    console.error("Failed to save OpenAI key:", error);
    res.status(500).json({ error: "Unable to save OpenAI key." });
  }
});

app.delete("/openai-key", async (req, res) => {
  const decodedToken = await verifyGoogleIdToken(req, res);
  if (!decodedToken) return;

  try {
    await db.collection("users").doc(decodedToken.uid).update({
      openaiApiKey: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    res.json({ ok: true });
  } catch (error) {
    console.error("Failed to delete OpenAI key:", error);
    res.status(500).json({ error: "Unable to delete OpenAI key." });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    oauthConfigured: !!(OAUTH_CONFIG.clientId && OAUTH_CONFIG.clientSecret),
    firebaseAdmin: firebaseAdminInitialized && getApps().length > 0,
    firebaseProjectId: firebaseProjectId,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (!OAUTH_CONFIG.clientId || !OAUTH_CONFIG.clientSecret) {
    console.warn(
      "⚠️  Warning: OAuth not configured. Set OPENAI_CLIENT_ID and OPENAI_CLIENT_SECRET to enable OAuth login.",
    );
  } else {
    console.log("✅ OAuth is configured and available");
  }
});
