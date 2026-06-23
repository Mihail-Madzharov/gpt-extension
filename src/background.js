chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({
    openPanelOnActionClick: true,
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_PAGE_CONTEXT") {
    handleGetPageContext(message.task)
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

async function handleGetPageContext(task) {
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

  const aiResult = await fetch("https://your-render-app.onrender.com/ai-task", {
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
