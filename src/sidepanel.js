const taskEl = document.getElementById("task");
const resultEl = document.getElementById("result");
const runBtn = document.getElementById("run");

runBtn.addEventListener("click", async () => {
  resultEl.textContent = "Reading page...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_PAGE_CONTEXT",
      task: taskEl.value,
    });

    if (!response.ok) {
      throw new Error(response.error);
    }

    resultEl.textContent =
      response.aiResult.message || JSON.stringify(response.aiResult, null, 2);
  } catch (error) {
    resultEl.textContent = error.message;
  }
});
