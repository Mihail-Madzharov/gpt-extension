chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({
    openPanelOnActionClick: true,
  });
});

// OAuth Configuration
const OAUTH_CONFIG = {
  clientId: "YOUR_OPENAI_CLIENT_ID", // Will be set via backend
  redirectUri: chrome.identity.getRedirectURL(),
  authUrl: "https://gpt-extension.onrender.com/oauth/authorize",
  tokenUrl: "https://gpt-extension.onrender.com/oauth/token",
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START_OAUTH_FLOW") {
    handleOAuthFlow(sender.tab.windowId)
      .then(sendResponse)
      .catch((error) => {
        console.error(error);
        sendResponse({
          ok: false,
          error: error.message,
        });
      });
    return true;
  } else if (message.type === "GET_PAGE_CONTEXT") {
    handleGetPageContext(message.task, message.apiKey)
      .then(sendResponse)
      .catch((error) => {
        console.error(error);
        sendResponse({
          ok: false,
          error: error.message,
        });
      });

    return true;
  }
});

// Handle OAuth Flow
async function handleOAuthFlow(windowId) {
  const authUrl = `${OAUTH_CONFIG.authUrl}?redirect_uri=${encodeURIComponent(OAUTH_CONFIG.redirectUri)}`;
  
  try {
    // Open a popup window for OAuth
    const popup = await chrome.windows.create({
      url: authUrl,
      type: "popup",
      width: 500,
      height: 600,
      focused: true,
    });

    return new Promise((resolve, reject) => {
      const checkPopup = setInterval(async () => {
        try {
          const windows = await chrome.windows.getAll();
          const popupExists = windows.some((w) => w.id === popup.id);

          if (!popupExists) {
            clearInterval(checkPopup);
            // Check if API key was stored
            const data = await chrome.storage.sync.get("openaiApiKey");
            if (data.openaiApiKey) {
              resolve({ ok: true });
            } else {
              reject(new Error("OAuth cancelled"));
            }
          }
        } catch (error) {
          clearInterval(checkPopup);
          reject(error);
        }
      }, 500);

      // Timeout after 5 minutes
      setTimeout(() => {
        clearInterval(checkPopup);
        reject(new Error("OAuth timeout"));
      }, 300000);
    });
  } catch (error) {
    throw new Error(`Failed to start OAuth flow: ${error.message}`);
  }
}

async function handleGetPageContext(task, apiKey) {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!tab?.id) {
    throw new Error("No active tab found");
  }

  const [{ result: pageContext }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: getPageContextFromDom,
  });

  const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });

  const aiResult = await fetch("https://gpt-extension.onrender.com/ai-task", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      task,
      tab: {
        url: tab.url,
        title: tab.title,
      },
      pageContext,
      screenshot,
      apiKey: apiKey || undefined,
    }),
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(await response.text());
    }

    return response.json();
  });

  return {
    ok: true,
    pageContext,
    aiResult,
  };
}

function getPageContextFromDom() {
  const elements = [
    ...document.querySelectorAll("button, a, input, textarea, select"),
  ]
    .slice(0, 200)
    .map((el, index) => ({
      index,
      tag: el.tagName,
      text:
        el.innerText ||
        el.value ||
        el.placeholder ||
        el.getAttribute("aria-label") ||
        "",
      id: el.id || "",
      name: el.getAttribute("name") || "",
      type: el.getAttribute("type") || "",
      href: el.href || "",
    }));

  return {
    url: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 15000),
    elements,
  };
}
