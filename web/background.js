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
    handleOAuthFlow(sender.tab?.windowId)
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
    highlightTargetOnActiveTab(message.cssSelector)
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

async function getActiveTab(preferredWindowId) {
  if (Number.isInteger(preferredWindowId)) {
    const inPreferredWindow = await chrome.tabs.query({
      active: true,
      windowId: preferredWindowId,
    });
    if (inPreferredWindow[0]?.id) {
      return inPreferredWindow[0];
    }
  }

  const inLastFocusedWindow = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (inLastFocusedWindow[0]?.id) {
    return inLastFocusedWindow[0];
  }

  const anyActiveTab = await chrome.tabs.query({ active: true });
  return anyActiveTab[0] || null;
}

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
  const tab = await getActiveTab();

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
  console.log("Screenshot captured:", screenshot);
  console.log("Page context:", pageContext);
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
  const escape = (v) =>
    CSS?.escape
      ? CSS.escape(String(v))
      : String(v).replace(/[^a-zA-Z0-9_-]/g, "\\$&");

  const getSelector = (el) => {
    if (!(el instanceof Element)) return "";

    if (el.id) return `#${escape(el.id)}`;

    const parts = [];
    let current = el;

    while (
      current &&
      current.nodeType === Node.ELEMENT_NODE &&
      parts.length < 8
    ) {
      const tag = current.tagName.toLowerCase();

      let part = tag;

      if (current.getAttribute("name")) {
        part += `[name="${current.getAttribute("name").replace(/"/g, '\\"')}"]`;
      } else if (current.getAttribute("aria-label")) {
        part += `[aria-label="${current.getAttribute("aria-label").replace(/"/g, '\\"')}"]`;
      } else {
        const parent = current.parentElement;
        if (parent) {
          const sameTag = [...parent.children].filter(
            (x) => x.tagName === current.tagName,
          );
          if (sameTag.length > 1) {
            part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
          }
        }
      }

      parts.unshift(part);
      current = current.parentElement;
    }

    return parts.join(" > ");
  };

  const getLabelText = (el) => {
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label?.innerText) return label.innerText;
    }

    const wrappedLabel = el.closest("label");
    if (wrappedLabel?.innerText) return wrappedLabel.innerText;

    return "";
  };

  const getElementText = (el) => {
    return (
      getLabelText(el) ||
      el.innerText ||
      el.textContent ||
      el.placeholder ||
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("name") ||
      el.getAttribute("value") ||
      ""
    ).trim();
  };

  const elements = [
    ...document.querySelectorAll(`
      button,
      a,
      input,
      textarea,
      select,
      option,
      [role="button"],
      [role="link"],
      [role="checkbox"],
      [role="radio"],
      [role="textbox"],
      [tabindex],
      [contenteditable="true"]
    `),
  ].map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type") || "",
    role: el.getAttribute("role") || "",
    text: getElementText(el).slice(0, 200),
    value: "value" in el ? el.value : "",
    checked: "checked" in el ? el.checked : undefined,
    selected: "selected" in el ? el.selected : undefined,
    href: el.href || "",
    disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
    visible: !!(
      el.offsetWidth ||
      el.offsetHeight ||
      el.getClientRects().length
    ),
    selector: getSelector(el),
  }));

  return {
    url: location.href,
    title: document.title,
    bodyText: document.body.innerText.slice(0, 15000),
    elements,
  };
}

async function highlightTargetOnActiveTab(cssSelector) {
  const normalizedCssSelector = String(cssSelector || "").trim();

  if (!normalizedCssSelector) {
    throw new Error("CSS selector is required.");
  }

  const tab = await getActiveTab();

  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: ({ cssSelector }) => {
      const normalize = (value) =>
        String(value || "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

      const escapeCssValue = (value) => {
        const raw = String(value || "");
        if (window.CSS && typeof window.CSS.escape === "function") {
          return window.CSS.escape(raw);
        }
        return raw.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      };

      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden")
          return false;
        if (Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const buildSelectorAlternatives = (selector) => {
        const alternatives = new Set([selector]);

        // querySelector does not support jQuery-like text pseudos; retry without them.
        const withoutTextPseudos = String(selector || "")
          .replace(/:contains\([^)]*\)/gi, "")
          .replace(/:text\([^)]*\)/gi, "")
          .replace(/\s+/g, " ")
          .trim();
        if (withoutTextPseudos && withoutTextPseudos !== selector) {
          alternatives.add(withoutTextPseudos);
        }

        const hrefMatch = selector.match(/\[href\s*=\s*['\"]([^'\"]+)['\"]\]/i);

        if (hrefMatch) {
          const hrefValue = String(hrefMatch[1] || "").trim();

          if (hrefValue.startsWith("/")) {
            try {
              const absoluteHref = new URL(hrefValue, location.origin).href;
              alternatives.add(
                selector.replace(hrefMatch[0], `[href='${absoluteHref}']`),
              );
            } catch {
              // Ignore malformed URL and keep base selector only.
            }

            alternatives.add(
              selector.replace(hrefMatch[0], `[href$='${hrefValue}']`),
            );
          }
        }

        const idMatch = selector.match(/#([A-Za-z0-9_-]+)/);
        if (idMatch) {
          const elementId = idMatch[1];
          alternatives.add(`#${elementId}`);
          alternatives.add(`label[for='${elementId}']`);
          alternatives.add(`#${elementId} + span a`);
          alternatives.add(`#${elementId} ~ span a`);
        }

        return Array.from(alternatives);
      };

      const findHighlightableElement = (el) => {
        if (!el) return null;
        if (isVisible(el)) return el;

        if (el instanceof HTMLInputElement && el.id) {
          const forLabel = document.querySelector(
            `label[for='${escapeCssValue(el.id)}']`,
          );
          if (forLabel && isVisible(forLabel)) return forLabel;
        }

        const childLink = el.querySelector?.("a, button, [role='button']");
        if (childLink && isVisible(childLink)) return childLink;

        let parent = el.parentElement;
        let safety = 0;
        while (parent && safety < 5) {
          if (isVisible(parent)) return parent;
          parent = parent.parentElement;
          safety += 1;
        }

        return null;
      };

      try {
        const selectorAlternatives = buildSelectorAlternatives(cssSelector);
        let matchedSelector = "";
        let directBySelector = null;

        for (const alternative of selectorAlternatives) {
          const candidate = document.querySelector(alternative);
          if (candidate) {
            directBySelector = candidate;
            matchedSelector = alternative;
            if (isVisible(candidate)) break;
          }
        }

        const highlightTarget = findHighlightableElement(directBySelector);

        if (!directBySelector || !highlightTarget) {
          const selectorHint = selectorAlternatives
            .filter((value) => value !== cssSelector)
            .slice(0, 3)
            .join(" or ");

          return {
            ok: false,
            error: selectorHint
              ? `Could not find a visible page element for selector \"${cssSelector}\". Try selector ${selectorHint}.`
              : `Could not find a visible page element for selector \"${cssSelector}\".`,
          };
        }

        const selectorText = normalize(
          highlightTarget.innerText ||
            highlightTarget.textContent ||
            highlightTarget.getAttribute("aria-label") ||
            highlightTarget.getAttribute("title") ||
            highlightTarget.id,
        );

        const existing = document.getElementById("gpt-assistant-highlight");
        if (existing) existing.remove();

        highlightTarget.scrollIntoView({
          behavior: "smooth",
          block: "center",
          inline: "center",
        });
        highlightTarget.style.outline = "3px solid #10a37f";
        highlightTarget.style.outlineOffset = "2px";

        const badge = document.createElement("div");
        badge.id = "gpt-assistant-highlight";
        badge.textContent = `Next step selector: ${matchedSelector || cssSelector}`;
        badge.style.position = "fixed";
        badge.style.zIndex = "2147483647";
        badge.style.right = "16px";
        badge.style.bottom = "16px";
        badge.style.padding = "10px 12px";
        badge.style.borderRadius = "8px";
        badge.style.background = "#10a37f";
        badge.style.color = "white";
        badge.style.fontFamily =
          "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        badge.style.fontSize = "12px";
        badge.style.boxShadow = "0 8px 24px rgba(0,0,0,0.25)";
        document.body.appendChild(badge);

        setTimeout(() => {
          highlightTarget.style.outline = "";
          highlightTarget.style.outlineOffset = "";
          const marker = document.getElementById("gpt-assistant-highlight");
          if (marker) marker.remove();
        }, 3500);

        return {
          ok: true,
          matchedText: selectorText,
          matchedBy: "cssSelector",
        };
      } catch {
        return {
          ok: false,
          error: `Invalid CSS selector: \"${cssSelector}\"`,
        };
      }
    },
    args: [
      {
        cssSelector: normalizedCssSelector,
      },
    ],
  });

  return result;
}

async function navigateActiveTab(url) {
  if (!url || typeof url !== "string") {
    throw new Error("A valid URL is required.");
  }

  const tab = await getActiveTab();

  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  const normalizedUrl = normalizeNavigationUrl(url, tab.url || "");
  try {
    await chrome.tabs.update(tab.id, { url: normalizedUrl });
    return { ok: true, url: normalizedUrl, method: "update" };
  } catch (updateError) {
    try {
      await chrome.tabs.create({ url: normalizedUrl, active: true });
      return { ok: true, url: normalizedUrl, method: "create" };
    } catch (createError) {
      throw new Error(
        `Navigation failed for ${normalizedUrl}. update error: ${updateError?.message || "unknown"}; create error: ${createError?.message || "unknown"}`,
      );
    }
  }
}

function normalizeNavigationUrl(rawUrl, baseUrl) {
  let candidate = String(rawUrl).trim();

  // Common LLM artifact: trailing punctuation at sentence boundaries.
  candidate = candidate.replace(/[),.;!?]+$/g, "");

  // Relative path support using current tab URL as base.
  if (candidate.startsWith("/") && baseUrl) {
    try {
      candidate = new URL(candidate, baseUrl).href;
    } catch {
      throw new Error(`Invalid relative redirect URL: ${rawUrl}`);
    }
  }

  // Accept host-only URLs like example.com/settings.
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid redirect URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported redirect protocol: ${parsed.protocol}. Only http/https are allowed.`,
    );
  }

  return parsed.href;
}
