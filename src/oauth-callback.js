// Get the authorization code from the URL
const params = new URLSearchParams(window.location.search);
const code = params.get("code");
const error = params.get("error");
const errorDescription = params.get("error_description");

const errorEl = document.getElementById("error");
const successEl = document.getElementById("success");

async function handleOAuthCallback() {
  if (error) {
    showError(`${error}: ${errorDescription || "Unknown error"}`);
    return;
  }

  if (!code) {
    showError("No authorization code received");
    return;
  }

  try {
    // Exchange the code for an API key
    const response = await fetch(
      "https://gpt-extension.onrender.com/oauth/callback",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          code,
          redirectUri: chrome.identity.getRedirectURL(),
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "OAuth token exchange failed");
    }

    const data = await response.json();

    if (data.apiKey) {
      // Store the API key in Chrome storage
      await chrome.storage.sync.set({
        openaiApiKey: data.apiKey,
        authMethod: "oauth",
      });

      // Notify the sidepanel of successful authentication
      chrome.runtime.sendMessage(
        {
          type: "OAUTH_CALLBACK",
          success: true,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.log("Sidepanel may not be open, but data was saved");
          }
        }
      );

      showSuccess();
    } else {
      throw new Error("No API key returned from OAuth provider");
    }
  } catch (err) {
    console.error("OAuth callback error:", err);
    showError(err.message);
  }
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.style.display = "block";
  document.querySelector(".spinner").style.display = "none";
  document.querySelector(".message").style.display = "none";
}

function showSuccess() {
  successEl.style.display = "block";
  document.querySelector(".spinner").style.display = "none";
  document.querySelector(".message").style.display = "none";

  // Close the window after 2 seconds
  setTimeout(() => {
    window.close();
  }, 2000);
}

// Start the OAuth callback flow
handleOAuthCallback();
