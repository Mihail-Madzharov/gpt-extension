import fs from "fs";
import path from "path";
import express from "express";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "25mb" }));

const firebaseServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const firebaseServiceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.resolve(process.cwd(), "gpt-embeded-firebase-adminsdk-fbsvc-6a91347930.json");
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

    console.log("FIREBASE_SERVICE_ACCOUNT_JSON env var set?", !!firebaseServiceAccountJson);

    // Try JSON environment variable first
    if (firebaseServiceAccountJson) {
      console.log("Attempting to parse FIREBASE_SERVICE_ACCOUNT_JSON...");
      try {
        serviceAccount = JSON.parse(firebaseServiceAccountJson);
        initSource = "FIREBASE_SERVICE_ACCOUNT_JSON environment variable";
        console.log(`✅ Successfully parsed Firebase credentials from env var`);
        console.log(`  Project ID in credentials: ${serviceAccount.project_id}`);
      } catch (parseError) {
        console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:", parseError.message);
        throw new Error(`Invalid JSON in FIREBASE_SERVICE_ACCOUNT_JSON: ${parseError.message}`);
      }
    } else {
      console.log(`Attempting to read credentials from file: ${firebaseServiceAccountPath}`);
      serviceAccount = JSON.parse(fs.readFileSync(firebaseServiceAccountPath, "utf8"));
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
    `❌ Firebase Admin could not initialize from credentials: ${error.message}`
  );
  console.error("Full error:", error);
  console.warn("⚠️  Firebase Admin will not be available. Credentials must be set.");
}

// OAuth Configuration
const OAUTH_CONFIG = {
  clientId: process.env.OPENAI_CLIENT_ID,
  clientSecret: process.env.OPENAI_CLIENT_SECRET,
  redirectUri: process.env.OPENAI_REDIRECT_URI || "https://gpt-extension.onrender.com/oauth/callback",
};

const GOOGLE_OAUTH_CLIENT_ID =
  process.env.GOOGLE_OAUTH_CLIENT_ID ||
  "169950079174-j1ai4pdp22dem45484iuve3tn6gokpot.apps.googleusercontent.com";

// OAuth Authorization Endpoint
app.get("/oauth/authorize", (req, res) => {
  try {
    const requestedRedirectUri = req.query.redirect_uri;
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const redirectUri = encodeURIComponent(requestedRedirectUri || OAUTH_CONFIG.redirectUri);
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
        errorData.error_description || "Failed to exchange code for token"
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
  const { url, title, pageContext, task, apiKey } = req.body;

  // Use the provided API key or fall back to environment variable
  const key = apiKey || process.env.OPENAI_API_KEY;
  
  if (!key) {
    return res.status(400).json({
      error: "No API key provided. Please configure your OpenAI API key in the extension settings.",
    });
  }

  const openai = new OpenAI({
    apiKey: key,
  });

  try {
    const pageHtml = typeof pageContext?.html === "string" ? pageContext.html : "";
    const pageUrl = url || pageContext?.url || "";
    const pageTitle = title || pageContext?.title || "";

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: `
You are a web navigation assistant.

Return ONLY valid JSON with this exact schema:
{
  "summary": "short overview",
  "currentUrl": "${pageUrl}",
  "steps": [
    {
      "title": "short step title",
      "action": "what to do",
      "targetText": "exact visible text/id/label to find in current page html",
      "navigateUrl": "absolute url or empty string",
      "reason": "optional short reason"
    }
  ]
}

Rules:
- 3 to 8 steps.
- If current page is wrong for task, first step must include navigateUrl.
- Prefer targetText that exists in provided HTML.
- If no navigation needed, use navigateUrl as empty string.
- No markdown. No extra text outside JSON.
- Do not include destructive actions.

Current URL: ${pageUrl}
Current Title: ${pageTitle}

Task:
${task}

Current page HTML (full):
${pageHtml}

Page context:
${JSON.stringify(pageContext).slice(0, 20000)}
`,
        },
      ],
    });

    const rawText = response.output_text || "";
    let journey;

    try {
      journey = JSON.parse(rawText);
    } catch {
      journey = {
        summary: rawText || "Follow these steps on the current page.",
        currentUrl: pageUrl,
        steps: [],
      };
    }

    if (!journey || typeof journey !== "object") {
      journey = {
        summary: "Follow these steps on the current page.",
        currentUrl: pageUrl,
        steps: [],
      };
    }

    if (!Array.isArray(journey.steps)) {
      journey.steps = [];
    }

    journey.steps = journey.steps.map((step) => ({
      title: String(step?.title || "Step"),
      action: String(step?.action || "Continue"),
      targetText: String(step?.targetText || ""),
      navigateUrl: String(step?.navigateUrl || ""),
      reason: String(step?.reason || ""),
    }));

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
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
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
      { merge: true }
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
      { merge: true }
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
    oauthConfigured: !!(
      OAUTH_CONFIG.clientId && OAUTH_CONFIG.clientSecret
    ),
    firebaseAdmin:
      firebaseAdminInitialized && getApps().length > 0,
    firebaseProjectId: firebaseProjectId,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (!OAUTH_CONFIG.clientId || !OAUTH_CONFIG.clientSecret) {
    console.warn(
      "⚠️  Warning: OAuth not configured. Set OPENAI_CLIENT_ID and OPENAI_CLIENT_SECRET to enable OAuth login."
    );
  } else {
    console.log("✅ OAuth is configured and available");
  }
});
