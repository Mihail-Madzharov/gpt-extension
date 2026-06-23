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
  } else if (message.type === "HIGHLIGHT_TARGET") {
    highlightTargetOnActiveTab(message.targetText)
      .then(sendResponse)
      .catch((error) => {
        console.error(error);
        sendResponse({
          ok: false,
          error: error.message,
        });
      });

    return true;
  } else if (message.type === "NAVIGATE_TO_URL") {
    navigateActiveTab(message.url)
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
    html: document.documentElement.outerHTML,
    text: document.body.innerText.slice(0, 15000),
    elements,
  };
}

async function highlightTargetOnActiveTab(targetText) {
  if (!targetText || typeof targetText !== "string") {
    throw new Error("Target text is required.");
  }

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (needle) => {
      const selectors = [
        "button",
        "a",
        "input",
        "textarea",
        "select",
        "[role='button']",
        "[onclick]",
      ];

      const normalize = (value) => (value || "").trim().toLowerCase();
      const target = normalize(needle);
      const candidates = [...document.querySelectorAll(selectors.join(","))];

      const scored = candidates
        .map((el) => {
          const parts = [
            el.innerText,
            el.value,
            el.getAttribute("aria-label"),
            el.getAttribute("placeholder"),
            el.id,
            el.getAttribute("name"),
            el.getAttribute("title"),
          ].map(normalize);

          const combined = parts.join(" ").trim();
          if (!combined) return null;

          let score = 0;
          if (combined === target) score += 100;
          if (combined.startsWith(target)) score += 50;
          if (combined.includes(target)) score += 25;
          if (parts.some((p) => p === target)) score += 80;
          if (parts.some((p) => p.includes(target))) score += 20;
          if (el.tagName === "BUTTON" || el.tagName === "A") score += 5;

          return { el, score, combined };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

      const match = scored[0];
      if (!match || match.score <= 0) {
        return {
          ok: false,
          error: `Could not find a page element matching "${needle}"`,
        };
      }

      const existing = document.getElementById("gpt-assistant-highlight");
      if (existing) existing.remove();

      match.el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      match.el.style.outline = "3px solid #10a37f";
      match.el.style.outlineOffset = "2px";

      const badge = document.createElement("div");
      badge.id = "gpt-assistant-highlight";
      badge.textContent = `Next step: ${needle}`;
      badge.style.position = "fixed";
      badge.style.zIndex = "2147483647";
      badge.style.right = "16px";
      badge.style.bottom = "16px";
      badge.style.padding = "10px 12px";
      badge.style.borderRadius = "8px";
      badge.style.background = "#10a37f";
      badge.style.color = "white";
      badge.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      badge.style.fontSize = "12px";
      badge.style.boxShadow = "0 8px 24px rgba(0,0,0,0.25)";
      document.body.appendChild(badge);

      setTimeout(() => {
        match.el.style.outline = "";
        match.el.style.outlineOffset = "";
        const marker = document.getElementById("gpt-assistant-highlight");
        if (marker) marker.remove();
      }, 3500);

      return {
        ok: true,
        matchedText: match.combined,
      };
    },
    args: [targetText],
  });

  return result;
}

async function navigateActiveTab(url) {
  if (!url || typeof url !== "string") {
    throw new Error("A valid URL is required.");
  }

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  await chrome.tabs.update(tab.id, { url });
  return { ok: true, url };
}
