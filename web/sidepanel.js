const taskEl = document.getElementById("task");
const resultEl = document.getElementById("result");
const runBtn = document.getElementById("run");
const loadingEl = document.getElementById("loading");

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

let currentUser = null;
let idToken = null;

// Tab Management
const tabBtns = document.querySelectorAll(".tab-btn");
const tabContents = document.querySelectorAll(".tab-content");

// Backend URL
const BACKEND_URL = "https://gpt-extension.onrender.com";
const GOOGLE_CLIENT_ID = "169950079174-j1ai4pdp22dem45484iuve3tn6gokpot.apps.googleusercontent.com";
const REDIRECT_URL = chrome.identity.getRedirectURL();

// Initialize on startup
document.addEventListener("DOMContentLoaded", () => {
  loadStoredAuth();
  updateAuthStatus();
  loadStoredApiKey();
});

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
  } else {
    firebaseAuthStatusEl.textContent = "Not signed in";
    firebaseAuthStatusEl.className = "auth-status unauthenticated";
    googleLoginBtn.style.display = "inline-flex";
    googleLogoutBtn.style.display = "none";
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
    const redirectUri = chrome.identity.getRedirectURL("openai");
    const authUrl = `${BACKEND_URL}/oauth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`;

    const finalRedirectUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true,
    });

    const callbackUrl = new URL(finalRedirectUrl);
    const code = callbackUrl.searchParams.get("code");
    const oauthError = callbackUrl.searchParams.get("error");

    if (oauthError) {
      throw new Error(`OpenAI OAuth error: ${oauthError}`);
    }

    if (!code) {
      throw new Error("No OAuth code received from OpenAI.");
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

    apiKeyInput.value = data.apiKey;
    showKeyStatus("✅ OpenAI login successful. Credential saved.", "success");
    updateAuthStatus();
  } catch (error) {
    showKeyStatus(`OpenAI login failed: ${error.message}`, "error");
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
      await chrome.storage.sync.set({ openaiApiKey: data.apiKey, authMethod: "firebase" });
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
      await chrome.storage.sync.set({ openaiApiKey: key, authMethod: "firebase" });
      showKeyStatus("✅ OpenAI key saved to backend", "success");
    } else {
      await chrome.storage.sync.set({ openaiApiKey: key, authMethod: "manual" });
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
      const method = data.authMethod === "firebase"
        ? "Firebase"
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
      apiKey: apiKey,
    });

    if (!response.ok) {
      throw new Error(response.error);
    }

    resultEl.textContent = response.aiResult.message || JSON.stringify(response.aiResult, null, 2);
  } catch (error) {
    resultEl.textContent = `❌ Error: ${error.message}`;
  } finally {
    loadingEl.classList.remove("active");
    runBtn.disabled = false;
  }
});
