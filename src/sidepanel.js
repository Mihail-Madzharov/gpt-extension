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

// Firebase Authentication
const googleLoginBtn = document.getElementById("google-login");
const googleLogoutBtn = document.getElementById("google-logout");

let currentUser = null;
let firebaseAuth = null;

// Tab Management
const tabBtns = document.querySelectorAll(".tab-btn");
const tabContents = document.querySelectorAll(".tab-content");

// Initialize Firebase and load auth state on startup
document.addEventListener("DOMContentLoaded", () => {
  initFirebase();
  loadStoredApiKey();
  updateAuthStatus();
});

function initFirebase() {
  if (!window.firebase || !window.FIREBASE_CONFIG) {
    console.warn("Firebase is not configured. Please add your firebase-config.js with your project settings.");
    firebaseAuthStatusEl.textContent = "Firebase not configured";
    firebaseAuthStatusEl.className = "auth-status unauthenticated";
    return;
  }

  if (!firebase.apps.length) {
    firebase.initializeApp(window.FIREBASE_CONFIG);
  }

  firebaseAuth = firebase.auth();
  firebaseAuth.onAuthStateChanged(handleAuthStateChange);
}

async function getIdToken() {
  if (!currentUser) return null;
  try {
    return await currentUser.getIdToken();
  } catch (error) {
    console.error("Failed to get ID token:", error);
    return null;
  }
}

async function backendRequest(path, options = {}) {
  const baseUrl = window.BACKEND_URL || "https://gpt-extension.onrender.com";
  const token = await getIdToken();
  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Backend request failed");
  }

  return response.json();
}


async function handleAuthStateChange(user) {
  currentUser = user;

  if (user) {
    firebaseAuthStatusEl.textContent = `Signed in as ${user.email}`;
    firebaseAuthStatusEl.className = "auth-status authenticated";
    googleLoginBtn.style.display = "none";
    googleLogoutBtn.style.display = "inline-flex";
    await loadFirebaseOpenAIKey();
  } else {
    firebaseAuthStatusEl.textContent = "Not signed in to Firebase";
    firebaseAuthStatusEl.className = "auth-status unauthenticated";
    googleLoginBtn.style.display = "inline-flex";
    googleLogoutBtn.style.display = "none";
  }

  updateAuthStatus();
}

async function loadFirebaseOpenAIKey() {
  if (!currentUser) {
    return;
  }

  try {
    const data = await backendRequest("/openai-key", { method: "GET" });
    if (data.apiKey) {
      apiKeyInput.value = data.apiKey;
      await chrome.storage.sync.set({ openaiApiKey: data.apiKey, authMethod: "firebase" });
    }
  } catch (error) {
    console.error("Error loading OpenAI key from backend:", error);
  }
}

googleLoginBtn.addEventListener("click", async () => {
  if (!firebaseAuth) {
    showKeyStatus("Firebase is not configured.", "error");
    return;
  }

  const provider = new firebase.auth.GoogleAuthProvider();
  googleLoginBtn.disabled = true;
  googleLoginBtn.textContent = "Signing in...";

  try {
    await firebaseAuth.signInWithPopup(provider);
    showKeyStatus("✅ Signed in with Google", "success");
  } catch (error) {
    showKeyStatus(`Google sign in failed: ${error.message}`, "error");
  } finally {
    googleLoginBtn.disabled = false;
    googleLoginBtn.textContent = "🔵 Sign in with Google";
  }
});

googleLogoutBtn.addEventListener("click", async () => {
  if (!firebaseAuth) {
    return;
  }

  try {
    await firebaseAuth.signOut();
    showKeyStatus("✅ Signed out", "success");
    apiKeyInput.value = "";
    await chrome.storage.sync.remove(["openaiApiKey", "authMethod"]);
    updateAuthStatus();
  } catch (error) {
    showKeyStatus(`Sign out failed: ${error.message}`, "error");
  }
});

async function loadFirebaseOpenAIKey() {
  if (!currentUser) {
    return;
  }

  try {
    const data = await backendRequest("/openai-key", { method: "GET" });
    if (data.apiKey) {
      apiKeyInput.value = data.apiKey;
      await chrome.storage.sync.set({ openaiApiKey: data.apiKey, authMethod: "firebase" });
    }
  } catch (error) {
    console.error("Error loading OpenAI key from backend:", error);
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
    if (currentUser) {
      await backendRequest("/openai-key", {
        method: "POST",
        body: JSON.stringify({ openaiApiKey: key }),
      });
      await chrome.storage.sync.set({ openaiApiKey: key, authMethod: "firebase" });
      showKeyStatus("✅ OpenAI key saved to Firebase backend", "success");
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
    if (currentUser) {
      await backendRequest("/openai-key", {
        method: "DELETE",
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
      const method = data.authMethod === "firebase" ? "Firebase" : data.authMethod === "oauth" ? "OpenAI OAuth" : "Manual API Key";
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
