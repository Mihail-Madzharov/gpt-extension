const taskEl = document.getElementById("task");
const resultEl = document.getElementById("result");
const runBtn = document.getElementById("run");
const loadingEl = document.getElementById("loading");

// Navigation Confirmation Modal
const navModal = document.getElementById("nav-confirmation-modal");
const navUrlDisplay = document.getElementById("nav-url-display");
const navConfirmBtn = document.getElementById("nav-confirm-btn");
const navCancelBtn = document.getElementById("nav-cancel-btn");

let pendingNavigationUrl = null;
let navigationResolver = null;

// API Key Management
const apiKeyInput = document.getElementById("api-key");
const saveKeyBtn = document.getElementById("save-key");
const clearKeyBtn = document.getElementById("clear-key");
const toggleVisibilityBtn = document.getElementById("toggle-key-visibility");
const keyStatusEl = document.getElementById("key-status");
const authStatusEl = document.getElementById("auth-status");
const firebaseAuthStatusEl = document.getElementById("firebase-auth-status");

// Google Authentication
const googleLoginBtn = document.getElementById("google-login");
const googleLogoutBtn = document.getElementById("google-logout");
const openaiLoginBtn = document.getElementById("openai-login");
const openaiOAuthSectionEl = document.getElementById("openai-oauth-section");
const openaiOAuthDividerEl = document.getElementById("openai-oauth-divider");

let currentUser = null;
let idToken = null;
let activeJourney = null;
let activeStepIndex = 0;

// Tab Management
const tabBtns = document.querySelectorAll(".tab-btn");
const tabContents = document.querySelectorAll(".tab-content");

// Backend URL
const BACKEND_URL = "https://gpt-extension.onrender.com";
const GOOGLE_CLIENT_ID =
  "169950079174-j1ai4pdp22dem45484iuve3tn6gokpot.apps.googleusercontent.com";
const REDIRECT_URL = chrome.identity.getRedirectURL();

function generateOAuthState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Initialize on startup
document.addEventListener("DOMContentLoaded", () => {
  loadStoredAuth();
  updateAuthStatus();
  loadStoredApiKey();
  setupNavigationConfirmation();
});

// Navigation Confirmation Setup
function setupNavigationConfirmation() {
  navConfirmBtn.addEventListener("click", () => {
    if (navigationResolver) {
      navigationResolver(true);
      navigationResolver = null;
    }
    navModal.style.display = "none";
  });

  navCancelBtn.addEventListener("click", () => {
    if (navigationResolver) {
      navigationResolver(false);
      navigationResolver = null;
    }
    navModal.style.display = "none";
  });

  // Close modal when clicking outside
  navModal.addEventListener("click", (e) => {
    if (e.target === navModal) {
      if (navigationResolver) {
        navigationResolver(false);
        navigationResolver = null;
      }
      navModal.style.display = "none";
    }
  });
}

// Ask user for navigation confirmation
async function askForNavigation(url) {
  navUrlDisplay.textContent = url;
  navModal.style.display = "flex";

  return new Promise((resolve) => {
    navigationResolver = resolve;
  });
}

async function loadStoredAuth() {
  try {
    const data = await chrome.storage.sync.get(["idToken", "userEmail"]);
    if (data.idToken) {
      idToken = data.idToken;
      currentUser = { email: data.userEmail };
      updateFirebaseAuthStatus();
    }
  } catch (error) {
    console.error("Error loading stored auth:", error);
  }
}

function updateFirebaseAuthStatus() {
  if (currentUser && idToken) {
    firebaseAuthStatusEl.textContent = `Signed in as ${currentUser.email}`;
    firebaseAuthStatusEl.className = "auth-status authenticated";
    googleLoginBtn.style.display = "none";
    googleLogoutBtn.style.display = "inline-flex";
    openaiOAuthSectionEl.style.display = "flex";
    openaiOAuthDividerEl.style.display = "block";
  } else {
    firebaseAuthStatusEl.textContent = "Not signed in";
    firebaseAuthStatusEl.className = "auth-status unauthenticated";
    googleLoginBtn.style.display = "inline-flex";
    googleLogoutBtn.style.display = "none";
    openaiOAuthSectionEl.style.display = "none";
    openaiOAuthDividerEl.style.display = "none";
  }
}

googleLoginBtn.addEventListener("click", async () => {
  googleLoginBtn.disabled = true;
  googleLoginBtn.textContent = "Signing in...";

  try {
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&response_type=id_token&scope=openid%20email&redirect_uri=${encodeURIComponent(REDIRECT_URL)}&nonce=random_nonce`;

    const redirectUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true,
    });

    // Extract the ID token from the redirect URL
    const url = new URL(redirectUrl);
    const token = new URLSearchParams(url.hash.slice(1)).get("id_token");

    if (!token) {
      throw new Error("No ID token received from Google");
    }

    idToken = token;

    // Verify token with backend and create user
    const response = await backendRequest("/verify-google-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });

    currentUser = { email: response.email, uid: response.uid };

    // Store auth
    await chrome.storage.sync.set({
      idToken: token,
      userEmail: currentUser.email,
      userId: currentUser.uid,
    });

    showKeyStatus("✅ Signed in with Google", "success");
    updateFirebaseAuthStatus();
    await loadOpenAIKeyFromBackend();
  } catch (error) {
    showKeyStatus(`Google sign in failed: ${error.message}`, "error");
    console.error("Google login error:", error);
  } finally {
    googleLoginBtn.disabled = false;
    googleLoginBtn.textContent = "🔵 Sign in with Google";
  }
});

googleLogoutBtn.addEventListener("click", async () => {
  try {
    idToken = null;
    currentUser = null;
    await chrome.storage.sync.remove(["idToken", "userEmail", "userId"]);
    apiKeyInput.value = "";
    showKeyStatus("✅ Signed out", "success");
    updateAuthStatus();
    updateFirebaseAuthStatus();
  } catch (error) {
    showKeyStatus(`Sign out failed: ${error.message}`, "error");
  }
});

async function backendRequest(path, options = {}) {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Backend request failed");
  }

  return response.json();
}

async function loginWithOpenAI() {
  openaiLoginBtn.disabled = true;
  openaiLoginBtn.textContent = "Opening OpenAI login...";

  try {
    const health = await backendRequest("/health", { method: "GET" });
    if (!health.oauthConfigured) {
      throw new Error(
        "Backend OAuth is not configured. Set OPENAI_CLIENT_ID and OPENAI_CLIENT_SECRET on Render.",
      );
    }

    const redirectUri = chrome.identity.getRedirectURL("openai");
    const state = generateOAuthState();
    const authUrl = `${BACKEND_URL}/oauth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;

    const finalRedirectUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true,
    });

    const callbackUrl = new URL(finalRedirectUrl);
    const code = callbackUrl.searchParams.get("code");
    const oauthError = callbackUrl.searchParams.get("error");
    const returnedState = callbackUrl.searchParams.get("state");

    if (oauthError) {
      throw new Error(`OpenAI OAuth error: ${oauthError}`);
    }

    if (!code) {
      throw new Error("No OAuth code received from OpenAI.");
    }

    if (!returnedState || returnedState !== state) {
      throw new Error("Invalid OAuth state. Please retry login.");
    }

    const data = await backendRequest("/oauth/callback", {
      method: "POST",
      body: JSON.stringify({ code, redirectUri }),
    });

    if (!data.apiKey) {
      throw new Error("Backend did not return an API key.");
    }

    await chrome.storage.sync.set({
      openaiApiKey: data.apiKey,
      authMethod: "oauth",
    });

    if (currentUser && idToken) {
      await backendRequest("/openai-key", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ openaiApiKey: data.apiKey }),
      });
      await chrome.storage.sync.set({ authMethod: "oauth+firebase" });
    }

    apiKeyInput.value = data.apiKey;
    showKeyStatus("✅ OpenAI login successful. Credential saved.", "success");
    updateAuthStatus();
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("Authorization page could not be loaded")) {
      showKeyStatus(
        "OpenAI login failed: backend OAuth is not configured or redirect URI is not allowed.",
        "error",
      );
    } else {
      showKeyStatus(`OpenAI login failed: ${message}`, "error");
    }
    console.error("OpenAI OAuth error:", error);
  } finally {
    openaiLoginBtn.disabled = false;
    openaiLoginBtn.textContent = "Log in with OpenAI";
  }
}

openaiLoginBtn.addEventListener("click", loginWithOpenAI);

async function loadOpenAIKeyFromBackend() {
  if (!idToken) return;

  try {
    const data = await backendRequest("/openai-key", {
      method: "GET",
      headers: { Authorization: `Bearer ${idToken}` },
    });

    if (data.apiKey) {
      apiKeyInput.value = data.apiKey;
      await chrome.storage.sync.set({
        openaiApiKey: data.apiKey,
        authMethod: "firebase",
      });
    }
  } catch (error) {
    console.error("Error loading OpenAI key:", error);
  }
}

// Tab switching
tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const tabName = btn.getAttribute("data-tab");

    tabBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    tabContents.forEach((tab) => tab.classList.remove("active"));
    document.getElementById(`${tabName}-tab`).classList.add("active");
  });
});

// Toggle API key visibility
toggleVisibilityBtn.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  toggleVisibilityBtn.textContent = isPassword ? "🙈" : "👁️";
});

// Save API key
saveKeyBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();

  if (!key) {
    showKeyStatus("Please enter an API key", "error");
    return;
  }

  if (!key.startsWith("sk-")) {
    showKeyStatus("Invalid API key format (should start with 'sk-')", "error");
    return;
  }

  try {
    if (currentUser && idToken) {
      await backendRequest("/openai-key", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ openaiApiKey: key }),
      });
      await chrome.storage.sync.set({
        openaiApiKey: key,
        authMethod: "firebase",
      });
      showKeyStatus("✅ OpenAI key saved to backend", "success");
    } else {
      await chrome.storage.sync.set({
        openaiApiKey: key,
        authMethod: "manual",
      });
      showKeyStatus("✅ API key saved locally", "success");
    }

    updateAuthStatus();
  } catch (error) {
    showKeyStatus(`Error saving key: ${error.message}`, "error");
  }
});

// Clear API key
clearKeyBtn.addEventListener("click", async () => {
  if (!confirm("Are you sure you want to remove your credentials?")) {
    return;
  }

  try {
    if (currentUser && idToken) {
      await backendRequest("/openai-key", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${idToken}` },
      });
    }

    await chrome.storage.sync.remove(["openaiApiKey", "authMethod"]);
    apiKeyInput.value = "";
    showKeyStatus("✅ Credentials removed", "success");
    updateAuthStatus();
  } catch (error) {
    showKeyStatus(`Error removing credentials: ${error.message}`, "error");
  }
});

// Load stored API key from chrome storage
async function loadStoredApiKey() {
  try {
    const data = await chrome.storage.sync.get(["openaiApiKey", "authMethod"]);
    if (data.openaiApiKey) {
      apiKeyInput.value = data.openaiApiKey;
    }
  } catch (error) {
    console.error("Error loading API key:", error);
  }
}

// Update authentication status display
async function updateAuthStatus() {
  try {
    const data = await chrome.storage.sync.get(["openaiApiKey", "authMethod"]);
    if (data.openaiApiKey) {
      const method =
        data.authMethod === "firebase"
          ? "Firebase"
          : data.authMethod === "oauth+firebase"
            ? "OpenAI OAuth + Firebase"
            : data.authMethod === "oauth"
              ? "OpenAI OAuth"
              : "Manual API Key";
      authStatusEl.textContent = `✅ Authenticated via ${method}`;
      authStatusEl.className = "auth-status authenticated";
    } else {
      authStatusEl.textContent = "⚠️ Not authenticated";
      authStatusEl.className = "auth-status unauthenticated";
    }
  } catch (error) {
    console.error("Error updating auth status:", error);
  }
}

// Show status message
function showKeyStatus(message, type) {
  keyStatusEl.textContent = message;
  keyStatusEl.className = `status-message ${type}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeJourney(aiResult) {
  const journey = aiResult?.journey;
  if (!journey || !Array.isArray(journey.steps)) return null;

  return {
    summary: String(journey.summary || "Follow these steps on the page."),
    steps: journey.steps.map((step, index) => ({
      title: String(step?.title || `Step ${index + 1}`),
      action: String(step?.action || "Continue"),
      cssSelector: String(step?.cssSelector || ""),
      navigateUrl: String(step?.navigateUrl || ""),
      reason: String(step?.reason || ""),
    })),
  };
}

function findFallbackNavigateUrl(stepIndex) {
  if (!activeJourney?.steps?.length) return "";

  for (let i = stepIndex; i < activeJourney.steps.length; i += 1) {
    const candidate = activeJourney.steps[i]?.navigateUrl;
    if (candidate) return candidate;
  }

  for (let i = stepIndex - 1; i >= 0; i -= 1) {
    const candidate = activeJourney.steps[i]?.navigateUrl;
    if (candidate) return candidate;
  }

  return "";
}

function normalizeNavigationUrl(rawUrl, baseUrl) {
  let candidate = String(rawUrl || "").trim();
  candidate = candidate.replace(/[),.;!?]+$/g, "");

  if (candidate.startsWith("/") && baseUrl) {
    candidate = new URL(candidate, baseUrl).href;
  }

  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  const parsed = new URL(candidate);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported redirect protocol: ${parsed.protocol}. Only http/https are allowed.`
    );
  }

  return parsed.href;
}

async function navigateToJourneyUrl(rawUrl) {
  if (!rawUrl) {
    throw new Error("Missing redirect URL.");
  }

  // Try background navigation first.
  try {
    const navResponse = await chrome.runtime.sendMessage({
      type: "NAVIGATE_TO_URL",
      url: rawUrl,
    });

    if (navResponse?.ok) {
      return navResponse.url || rawUrl;
    }
  } catch {
    // Fall through to direct navigation fallback.
  }

  // Fallback: navigate directly from sidepanel using tabs API.
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  const normalizedUrl = normalizeNavigationUrl(rawUrl, tab?.url || "");

  if (tab?.id) {
    try {
      await chrome.tabs.update(tab.id, { url: normalizedUrl });
      return normalizedUrl;
    } catch {
      // Try opening a new tab next.
    }
  }

  await chrome.tabs.create({ url: normalizedUrl, active: true });
  return normalizedUrl;
}

async function runJourneyStep(stepIndex) {
  if (!activeJourney) return;
  const step = activeJourney.steps[stepIndex];
  if (!step) return;

  // Check if navigation is required but not done yet
  if (step.navigateUrl) {
    throw new Error(
      `This step requires navigating to another page. Click "Open Required Page" to navigate.`
    );
  }

  // Only highlight the target on the current page
  if (step.cssSelector) {
    const highlightResponse = await chrome.runtime.sendMessage({
      type: "HIGHLIGHT_TARGET",
      cssSelector: step.cssSelector,
    });

    if (!highlightResponse?.ok) {
      throw new Error(highlightResponse?.error || "Could not locate target on current page.");
    }
  }
}

function renderActiveJourney() {
  if (!activeJourney || !activeJourney.steps.length) {
    resultEl.innerHTML = `<div class="journey-raw">No guidance returned.</div>`;
    return;
  }

  const step = activeJourney.steps[activeStepIndex];
  const isFirst = activeStepIndex === 0;
  const isLast = activeStepIndex === activeJourney.steps.length - 1;

  resultEl.innerHTML = `
    <div class="journey-toolbar">
      <button id="journey-prev" class="btn-secondary" ${isFirst ? "disabled" : ""}>Previous</button>
      <button id="journey-run-step">${step.cssSelector ? "Take Me to Target" : "Guide Me Here"}</button>
      <button id="journey-next" class="btn-secondary" ${isLast ? "disabled" : ""}>Next</button>
    </div>
    <div class="journey-summary">${escapeHtml(activeJourney.summary)}</div>
    <div class="journey-progress">Step ${activeStepIndex + 1} of ${activeJourney.steps.length}</div>
    <div class="journey-step">
      <div class="journey-step-title">${activeStepIndex + 1}. ${escapeHtml(step.title)}</div>
      <div class="journey-step-action">${escapeHtml(step.action)}</div>
      ${step.navigateUrl ? `<div class="journey-step-target">Navigate to: <a href="${escapeHtml(step.navigateUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(step.navigateUrl)}</a></div>` : ""}
      ${step.cssSelector ? `<div class="journey-step-target">Selector: <strong>${escapeHtml(step.cssSelector)}</strong></div>` : ""}
      ${step.reason ? `<div class="help-text">${escapeHtml(step.reason)}</div>` : ""}
      <div class="journey-step-buttons">
        ${step.navigateUrl ? `<button id="journey-nav-only" class="btn-secondary">Open Required Page</button>` : ""}
        ${step.cssSelector ? `<button id="journey-highlight-only" class="btn-secondary">Take Me to Target</button>` : ""}
      </div>
    </div>
  `;
}

function renderJourney(aiResult) {
  if (aiResult?.mode === "html_extraction") {
    activeJourney = null;
    activeStepIndex = 0;

    const extraction = aiResult?.extraction || {};
    const hasHtml = Boolean(String(extraction?.html || "").trim());
    const targetLabel = String(extraction?.target || "requested element");

    resultEl.innerHTML = `
      <div class="journey-summary">Element HTML Extraction</div>
      <div class="journey-step-target">${escapeHtml(aiResult?.message || "")}</div>
      <div class="journey-step-target">Target: <strong>${escapeHtml(targetLabel)}</strong></div>
      ${hasHtml ? `<div class="journey-raw">${escapeHtml(extraction.html)}</div>` : `<div class="journey-raw">No HTML extracted.</div>`}
    `;
    return;
  }

  if (aiResult?.mode === "page_explanation") {
    activeJourney = null;
    activeStepIndex = 0;
    resultEl.innerHTML = `<div class="journey-summary">Current Page Explanation</div><div class="journey-raw">${escapeHtml(aiResult?.message || "No explanation returned.")}</div>`;
    return;
  }

  activeJourney = normalizeJourney(aiResult);
  activeStepIndex = 0;

  if (!activeJourney || !activeJourney.steps.length) {
    resultEl.innerHTML = `<div class="journey-raw">${escapeHtml(aiResult?.message || "No guidance returned.")}</div>`;
    return;
  }

  renderActiveJourney();
}

async function safeGuideStep(stepIndex) {
  try {
    await runJourneyStep(stepIndex);
  } catch (error) {
    const fallbackUrl = findFallbackNavigateUrl(stepIndex);
    resultEl.insertAdjacentHTML(
      "afterbegin",
      `<div class="status-message error" style="display:block; margin-bottom: 8px;">${escapeHtml(error.message || "Failed to guide this step.")}${
        fallbackUrl
          ? `<div style="margin-top:8px;"><a href="${escapeHtml(fallbackUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(fallbackUrl)}</a></div><div style="margin-top:8px;"><button id="journey-fallback-nav" class="btn-secondary" data-url="${escapeHtml(fallbackUrl)}">Open Suggested Page</button></div>`
          : ""
      }</div>`,
    );
  }
}

resultEl.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (target.id === "journey-prev") {
    if (activeStepIndex > 0) {
      activeStepIndex -= 1;
      renderActiveJourney();
      await safeGuideStep(activeStepIndex);
    }
    return;
  }

  if (target.id === "journey-next") {
    if (activeJourney && activeStepIndex < activeJourney.steps.length - 1) {
      activeStepIndex += 1;
      renderActiveJourney();
      await safeGuideStep(activeStepIndex);
    }
    return;
  }

  if (target.id === "journey-run-step") {
    await safeGuideStep(activeStepIndex);
    return;
  }

  if (target.id === "journey-nav-only") {
    const step = activeJourney?.steps?.[activeStepIndex];
    if (!step?.navigateUrl) return;

    try {
      await navigateToJourneyUrl(step.navigateUrl);
    } catch (error) {
      resultEl.insertAdjacentHTML(
        "afterbegin",
        `<div class="status-message error" style="display:block; margin-bottom: 8px;">${escapeHtml(error?.message || "Failed to open required page.")}</div>`,
      );
      return;
    }
    return;
  }

  if (target.id === "journey-highlight-only") {
    await safeGuideStep(activeStepIndex);
    return;
  }

  if (target.id === "journey-fallback-nav") {
    const url = target.dataset.url;
    if (!url) return;

    try {
      await navigateToJourneyUrl(url);
    } catch (error) {
      resultEl.insertAdjacentHTML(
        "afterbegin",
        `<div class="status-message error" style="display:block; margin-bottom: 8px;">${escapeHtml(error?.message || "Failed to open suggested page.")}</div>`,
      );
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1200));
    await safeGuideStep(activeStepIndex);
  }
});

// Main task execution
runBtn.addEventListener("click", async () => {
  if (!taskEl.value.trim()) {
    resultEl.textContent = "⚠️ Please enter a task";
    return;
  }

  resultEl.textContent = "";
  loadingEl.classList.add("active");
  runBtn.disabled = true;

  try {
    const data = await chrome.storage.sync.get("openaiApiKey");
    const apiKey = data.openaiApiKey || null;

    const response = await chrome.runtime.sendMessage({
      type: "GET_PAGE_CONTEXT",
      task: taskEl.value,
      apiKey,
    });

    if (!response.ok) {
      throw new Error(response.error);
    }

    renderJourney(response.aiResult);
    await safeGuideStep(0);
  } catch (error) {
    resultEl.textContent = `❌ Error: ${error.message}`;
  } finally {
    loadingEl.classList.remove("active");
    runBtn.disabled = false;
  }
});

// Keyboard shortcuts: Enter submits, Shift+Enter adds a new line.
taskEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    runBtn.click();
  }
});

apiKeyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    saveKeyBtn.click();
  }
});
