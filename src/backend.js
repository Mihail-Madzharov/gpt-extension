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
  const { url, title, pageContext, task, apiKey, screenshot } = req.body;

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

    const extractionIntentPatterns = [
      // English
      /\bextract\b/i,
      /\bget\b/i,
      /\bshow\b/i,
      /\bfind\b/i,
      /\breturn\b/i,
      /\bgive\s+me\b/i,

      // Bulgarian
      /извлечи/i,
      /покажи/i,
      /намери/i,
      /върни/i,
      /дай\s+ми/i,
      /вземи/i,
    ];

    const htmlTargetPatterns = [
      // English
      /\bhtml\b/i,
      /\bouterhtml\b/i,
      /\bmarkup\b/i,
      /\bdom\b/i,
      /\belement\b/i,
      /\bselector\b/i,
      /\bid\b/i,
      /\bclass\b/i,

      // Bulgarian
      /html/i,
      /маркъп/i,
      /dom/i,
      /елемент/i,
      /селектор/i,
      /идентификатор/i,
      /клас/i,
    ];

    const hasExtractionIntent = extractionIntentPatterns.some((pattern) =>
      pattern.test(normalizedTaskText),
    );
    const hasHtmlTarget = htmlTargetPatterns.some((pattern) =>
      pattern.test(normalizedTaskText),
    );
    const isHtmlExtractionTask = hasExtractionIntent && hasHtmlTarget;

    if (isHtmlExtractionTask) {
      const shouldReplyInBulgarian = /[\u0400-\u04FF]/.test(taskText);
      const extractionLanguage = shouldReplyInBulgarian
        ? "Bulgarian"
        : "English";

      const extractionResponse = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: `
You are an HTML extraction assistant.

The user asked: "${taskText}"

Respond in ${extractionLanguage}.

Return ONLY valid JSON in this exact schema:
{
  "found": true,
  "target": "short description of requested element",
  "html": "outerHTML for the best matching element, or empty string",
  "reason": "short reason if not found"
}

Rules:
- Use the available page elements as the primary source.
- If multiple candidates exist, return the most specific and relevant one.
- If HTML is not available, set found=false and html="" and explain in reason.
- No markdown and no extra text outside JSON.

Current URL: ${pageUrl}
Current Title: ${pageTitle}

Page elements available:
${elementsText}
`,
          },
        ],
      });

      const rawExtractionText = String(
        extractionResponse.output_text || "",
      ).trim();
      let extraction;

      try {
        extraction = JSON.parse(rawExtractionText);
      } catch {
        extraction = {
          found: false,
          target: taskText || "requested element",
          html: "",
          reason: rawExtractionText || "Could not parse extraction response.",
        };
      }

      const found =
        Boolean(extraction?.found) &&
        Boolean(String(extraction?.html || "").trim());
      const target = String(
        extraction?.target || taskText || "requested element",
      ).trim();
      const extractedHtml = String(extraction?.html || "");
      const reason = String(extraction?.reason || "").trim();

      return res.json({
        mode: "html_extraction",
        message: found
          ? `${shouldReplyInBulgarian ? "Намерих HTML за" : "Found HTML for"}: ${target}`
          : `${shouldReplyInBulgarian ? "Не успях да намеря точен елемент" : "Could not find an exact matching element"}${reason ? `. ${reason}` : "."}`,
        extraction: {
          found,
          target,
          html: extractedHtml,
          reason,
        },
        journey: {
          summary: "HTML extraction",
          currentUrl: pageUrl,
          steps: [],
        },
      });
    }

    const explanationIntentPatterns = [
      // English
      /\bexplain\b/i,
      /\bdescribe\b/i,
      /\bsummari[sz]e\b/i,
      /\boverview\b/i,
      /\bwalk\s+me\s+through\b/i,
      /\bwhat\s+is\s+this\b/i,
      /\bwhat\s+does\s+this\s+(page|screen|site|website)\s+do\b/i,
      /\bhow\s+does\s+this\s+(page|screen|site|website)\s+work\b/i,

      // Bulgarian
      /обясни/i,
      /опиши/i,
      /резюмирай/i,
      /какво\s+е\s+това/i,
      /за\s+какво\s+е\s+тази\s+страница/i,
      /как\s+работи\s+тази\s+страница/i,
      /разкажи\s+ми\s+за\s+тази\s+страница/i,
      /обобщи/i,
    ];

    const pageReferencePatterns = [
      // English
      /\bpage\b/i,
      /\bscreen\b/i,
      /\bsite\b/i,
      /\bwebsite\b/i,
      /\bcurrent\b/i,
      /\bthis\s+tab\b/i,

      // Bulgarian
      /страниц/i,
      /екран/i,
      /сайт/i,
      /уебсайт/i,
      /текущ/i,
      /този\s+таб/i,
      /тази\s+страница/i,
    ];

    const hasExplanationIntent = explanationIntentPatterns.some((pattern) =>
      pattern.test(normalizedTaskText),
    );
    const hasPageReference = pageReferencePatterns.some((pattern) =>
      pattern.test(normalizedTaskText),
    );
    const isPageExplanationTask = hasExplanationIntent && hasPageReference;

    if (isPageExplanationTask) {
      const shouldReplyInBulgarian = /[\u0400-\u04FF]/.test(taskText);
      const explanationLanguage = shouldReplyInBulgarian
        ? "Bulgarian"
        : "English";

      const explanationResponse = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: `
You are a web page explanation assistant.

The user asked: "${taskText}"

Respond in ${explanationLanguage}.

Write a concise explanation of the CURRENT page, based on the provided URL, title, and available elements.

Requirements:
- Keep it factual and grounded in the provided page data.
- Start with a 1-2 sentence summary.
- Then provide 4-8 short bullet points describing what this page is, key sections, and what the user can do here.
- Mention uncertain points as "might" or "appears to".
- No markdown headings.

Current URL: ${pageUrl}
Current Title: ${pageTitle}

Page elements available:
${elementsText}
`,
          },
        ],
      });

      const explanationText =
        String(explanationResponse.output_text || "").trim() ||
        "This page appears to contain content, but I could not confidently summarize it from the available context.";

      return res.json({
        mode: "page_explanation",
        message: explanationText,
        journey: {
          summary: "Current page explanation",
          currentUrl: pageUrl,
          steps: [],
        },
      });
    }

    const extractedSelectors = Array.isArray(pageContext?.elements)
      ? pageContext.elements
          .map((item) => String(item?.selector || "").trim())
          .filter(Boolean)
      : [];
    const extractedSelectorSet = new Set(extractedSelectors);

    const buildNavigationPrompt = ({ strictSelectorMode = false } = {}) => `
You are a web navigation assistant.

Return ONLY valid JSON with this exact schema:
{
  "found": true,
  "confidence": 0,
  "summary": "short overview",
  "currentUrl": "${pageUrl}",
  "steps": [
    {
      "title": "short step title",
      "action": "what to do",
      "cssSelector": "best selector for the element",
      "journeySelector": "full CSS journey/path to the element",
      "href": "href value if the element is a link, otherwise empty string",
      "navigateUrl": "absolute URL to navigate to, otherwise empty string",
      "reason": "why this element was selected"
    }
  ],
  "reason": "short reason"
}

Rules:
- Return one best matching target.
- Use the available page elements as the source of truth.
- Prefer elements with exact/semantic text match.
- If the element has href, return it in href.
- If href is relative, keep href as found and put the absolute URL in navigateUrl if possible.
- cssSelector should be the best selector for clicking/querying the element.
- journeySelector should describe the full path/journey to reach the element in the DOM.
- If the target cannot be found, set found=false, confidence below 80, steps=[] and explain in reason.
- Never invent selectors, hrefs, text, or URLs.
- Output valid JSON only.
- No markdown.
${strictSelectorMode ? "- CRITICAL: every found step must include non-empty cssSelector and journeySelector." : ""}

Current URL: ${pageUrl}
Current Title: ${pageTitle}

Task:
${task}

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
        found: Boolean(safeJourney.found),
        confidence: Number(safeJourney.confidence || 0),
        summary: String(
          safeJourney.summary || "Follow these steps on the current page.",
        ),
        currentUrl: String(safeJourney.currentUrl || pageUrl),
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

    const isValidIdClassPathSelector = (selector) => {
      const value = String(selector || "").trim();
      if (!value) return false;
      if (/:nth-child|:nth-of-type|:contains|:has\(|:text\(/i.test(value)) {
        return false;
      }
      if (!/[#.]/.test(value)) return false;
      if (/^#[A-Za-z0-9_-]+$/.test(value)) return true;
      if (!/[ >]/.test(value)) return false;

      const segments = value
        .split(/\s*>\s*|\s+/)
        .map((segment) => segment.trim())
        .filter(Boolean);

      if (segments.length < 2) return false;
      return segments.every((segment) => /[#.]/.test(segment));
    };

    const hasStepWithoutRequiredSelector = (normalizedJourney) =>
      normalizedJourney.steps.some((step) => {
        if (step.navigateUrl) return false;
        const existsInExtractedContext =
          extractedSelectorSet.size === 0 ||
          extractedSelectorSet.has(step.cssSelector);

        return (
          !isValidIdClassPathSelector(step.cssSelector) ||
          !existsInExtractedContext
        );
      });

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

    if (hasStepWithoutRequiredSelector(journey)) {
      const strictResponse = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: buildNavigationPrompt({ strictSelectorMode: true }),
          },
        ],
      });

      rawText = String(strictResponse.output_text || rawText);
      journey = normalizeJourney(parseJourneyFromText(rawText));
    }

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
