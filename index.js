const express = require("express");
const os = require("node:os");
const puppeteer = require("puppeteer");
const path = require("node:path");
const Turndown = require("turndown");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

let browser;
let context;
let page;

app.use(express.json());

const NAVIGATION_TIMEOUT = process.env.MAX_TIMEOUT
  ? Number.parseInt(process.env.MAX_TIMEOUT, 10)
  : 30000;

const userDataDir = path.join(process.cwd(), "chrome-data");
const ongoingRequests = new Map();

async function initializeBrowser() {
  const launchOptions = {
    headless: process.env.HEADLESS === "true",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--start-maximized",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-popup-blocking",
      "--disable-notifications",
      "--disable-infobars",
      "--disable-session-crashed-bubble",
      "--window-size=800,600",
    ],
    userDataDir: userDataDir,
    defaultViewport: {
      width: 800,
      height: 600,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    },
    ignoreDefaultArgs: ["--enable-automation"], // This can help bypass some popups
  };

  // Check if running on Windows and EXECUTABLE_PATH is set
  if (os.platform() === "win32" && process.env.EXECUTABLE_PATH) {
    console.log(
      `Running on Windows. Using custom executable path: ${process.env.EXECUTABLE_PATH}`,
    );
    launchOptions.executablePath = process.env.EXECUTABLE_PATH;
  }

  try {
    browser = await puppeteer.launch(launchOptions);
    console.log("Browser launched successfully");

    const pages = await browser.pages();
    const pagesLength = pages.length; 
    context = browser.defaultBrowserContext();
    page = await context.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
    
    for (let i=0; i<pagesLength; i++) {
      // Close the initial tab and any previous browser tabs, but only after creating a new tab
      await pages[i].close();
    }

    await ensureLoggedIn();
  } catch (error) {
    console.error("Failed to launch browser:", error);
    throw error;
  }
}

async function ensureLoggedIn() {
  await page.goto("https://venice.ai/chat", { waitUntil: "networkidle2" });
  const userInfoSelector =
    "body > div.css-wi1irr > div.css-6o8pp7 > div.css-e8h8zp > div > div.css-oc1j8r > button.chakra-button.css-1rz9yxu > div > div > div > p";

  try {
    await page.waitForSelector(userInfoSelector, { timeout: 5000 });
    const userInfo = await page.$eval(userInfoSelector, (el) => el.textContent);
    if (!userInfo.includes("Venice Guest")) {
      console.log("Already logged in");
      return;
    }
  } catch (error) {
    console.log("Not logged in or error checking login status");
  }

  console.log("Logging in...");
  await login();
}

async function login() {
  await page.goto("https://venice.ai/sign-in", { waitUntil: "networkidle2" });

  await page.waitForSelector("#identifier");
  await page.type("#identifier", process.env.LOGIN_EMAIL);
  await page.click(
    "body > div.chakra-stack.css-165casq > div > div > div > div > div.chakra-card__body.css-2f8ovt > form > div > div.css-8atqhb > button",
  );

  await page.waitForSelector("#password");
  await page.type("#password", process.env.LOGIN_PASSWORD);
  await page.click(
    "body > div.chakra-stack.css-165casq > div > div > div > div > div.chakra-card__body.css-2f8ovt > form > button",
  );

  await page.waitForNavigation({ waitUntil: "networkidle2" });
  console.log("Login successful");
}

// Function to close inactive tabs
function closeInactiveTab(page, chatId) {
  setTimeout(
    async () => {
      try {
        if (!page.isClosed()) {
          console.log(`Closing inactive tab for chat ${chatId}`);
          await page.close();
        }
      } catch (error) {
        console.error(`Error closing tab for chat ${chatId}:`, error);
      }
    },
    5 * 60 * 1000,
  ); // 5 minutes
}

async function findOrCreateChatSession(contextId = null) {
  const pages = await browser.pages();
  let existingPage = null;

  if (contextId) {
    existingPage = pages.find((page) => {
      const url = page.url();
      return url.includes("/chat/") && url.endsWith(contextId);
    });
  }

  if (existingPage) {
    console.log(`[DEBUG] Found existing tab for chat ${contextId}`);
    await existingPage.bringToFront();
    return { chatId: contextId, page: existingPage };
  }

  console.log(`[DEBUG] Creating new tab for chat ${contextId || "new"}`);
  const newPage = await context.newPage();

  // Increase the navigation timeout
  const EXTENDED_TIMEOUT = 120000; // 2 minutes
  await newPage.setDefaultNavigationTimeout(EXTENDED_TIMEOUT);

  let shouldCreateNewChat = !contextId;

  try {
    const url = contextId
      ? `https://venice.ai/chat/${contextId}`
      : "https://venice.ai/chat";
    await newPage.goto(url, {
      waitUntil: "networkidle2",
      timeout: EXTENDED_TIMEOUT,
    });

    // Check if the URL has changed back to the main chat page
    const currentUrl = newPage.url();
    if (contextId && currentUrl === "https://venice.ai/chat") {
      console.log(
        `[DEBUG] Context ID ${contextId} not recognized, will create new chat`,
      );
      shouldCreateNewChat = true;
    }
  } catch (error) {
    console.error("[ERROR] Navigation failed:", error);
    throw error;
  }

  if (shouldCreateNewChat) {
    try {
      await newPage.waitForSelector(
        "body > div.css-wi1irr > div.css-6o8pp7 > div.css-135z2h5 > div > div > button:nth-child(1)",
        {
          timeout: EXTENDED_TIMEOUT,
        },
      );
      await newPage.click(
        "body > div.css-wi1irr > div.css-6o8pp7 > div.css-135z2h5 > div > div > button:nth-child(1)",
      );
      await newPage.waitForNavigation({
        waitUntil: "networkidle2",
        timeout: EXTENDED_TIMEOUT,
      });
    } catch (error) {
      console.error("[DEBUG] Error creating new chat:", error);
      throw error;
    }
  }

  const chatId = new URL(newPage.url()).pathname.split("/").pop();
  closeInactiveTab(newPage, chatId);
  return { chatId, page: newPage };
}


const models = {
  default: "hermes-2-theta-web",
  dogge: 'dogge-llama-3-70b',
  llama3: 'llama-3.1-405b'
}

async function sendPrompt(page, { prompt, model }) {
  const textareaSelector = 'textarea[placeholder="Ask a question..."]';
  const sendButtonSelector = 'button[data-testid="chatInputSubmitButton"]';
  const modelDropdownButtonSelector = '#menu-button-\\:rj\\:';
  const modelListSelector = '#menu-list-\\:rj\\:';

  async function checkUIState() {
    const state = await page.evaluate((dropdownSelector, listSelector, textareaSelector, sendButtonSelector) => {
      const dropdown = document.querySelector(dropdownSelector);
      const list = document.querySelector(listSelector);
      const textarea = document.querySelector(textareaSelector);
      const sendButton = document.querySelector(sendButtonSelector);
      return {
        dropdownText: dropdown.textContent,
        dropdownExpanded: dropdown.getAttribute('aria-expanded') === 'true',
        listVisible: list && window.getComputedStyle(list).visibility !== 'hidden',
        textareaEnabled: !textarea.disabled,
        sendButtonEnabled: !sendButton.disabled
      };
    }, modelDropdownButtonSelector, modelListSelector, textareaSelector, sendButtonSelector);
    console.log("[DEBUG] Current UI State:", JSON.stringify(state, null, 2));
    return state;
  }


  try {
     /**
     * 
     * 
     * 
     * 
     */

    // SELECT MODEL
    if (!Object.values(models).includes(model)) {
      throw new Error(`Invalid model: ${model}. Must be one of ${Object.values(models).join(', ')}`);
    }

    console.log("[DEBUG] Checking current model and selecting if necessary:", model);
    // await checkUIState();

    // Check if the current model is already the desired one without opening the dropdown
    const isModelSelected = await page.evaluate((buttonSelector, modelValue) => {
      function modelMatches(buttonText, modelValue) {
        const buttonLower = buttonText.toLowerCase();
        const modelLower = modelValue.toLowerCase();
        return buttonLower.includes(modelLower.replace(/-/g, ' '));
      }
      const button = document.querySelector(buttonSelector);
      return modelMatches(button.textContent, modelValue);
    }, modelDropdownButtonSelector, model);

    if (!isModelSelected) {
      console.log("[DEBUG] Need to change the model");

      // Click the dropdown button to open the menu
      await page.click(modelDropdownButtonSelector);
      console.log("[DEBUG] Clicked model dropdown button to open");
      // await checkUIState();

      // Wait for the dropdown to become visible
      await page.waitForSelector(modelListSelector, { visible: true, timeout: 5000 });
      console.log("[DEBUG] Dropdown menu is now visible");
      // await checkUIState();

      // Click the desired model option using the button's value attribute
      const modelOptionSelector = `${modelListSelector} button[value="${model}"]`;
      await page.waitForSelector(modelOptionSelector, { visible: true, timeout: 5000 });
      await page.click(modelOptionSelector);
      console.log(`[DEBUG] Clicked on model option: ${model}`);
      // await checkUIState();

      // Wait for the dropdown to close
      await page.waitForFunction((listSelector) => {
        const list = document.querySelector(listSelector);
        return !list || window.getComputedStyle(list).visibility === 'hidden';
      }, { timeout: 5000 }, modelListSelector);
      console.log("[DEBUG] Dropdown menu is now closed");
      // await checkUIState();

      // Verify that the correct model is selected
      const finalModelCheck = await page.evaluate((buttonSelector, modelValue) => {
        function modelMatches(buttonText, modelValue) {
          const buttonLower = buttonText.toLowerCase();
          const modelLower = modelValue.toLowerCase();
          return buttonLower.includes(modelLower.replace(/-/g, ' '));
        }
        const button = document.querySelector(buttonSelector);
        return modelMatches(button.textContent, modelValue);
      }, modelDropdownButtonSelector, model);

      if (!finalModelCheck) {
        console.error(`Failed to select the correct model: ${model}`);
      }
      console.log("[DEBUG] Model selection confirmed");
    } else {
      console.log("[DEBUG] Desired model is already selected");
    }
    // END SELECT MODEL
    /**
     * 
     * 
     * 
     * 
     */

    console.log("[DEBUG] Waiting for textarea");
    await page.waitForSelector(textareaSelector, {
      timeout: NAVIGATION_TIMEOUT,
      visible: true,
    });
    console.log("[DEBUG] Textarea found");
    // await checkUIState();

    console.log("[DEBUG] Focusing on textarea");
    await page.focus(textareaSelector);

    console.log("[DEBUG] Clearing textarea");
    await page.evaluate((selector) => {
      document.querySelector(selector).value = "";
    }, textareaSelector);

    console.log("[DEBUG] Typing prompt into textarea");
    await page.type(textareaSelector, prompt);
    // await checkUIState();

    console.log("[DEBUG] Verifying entered text");
    const enteredText = await page.$eval(textareaSelector, (el) => el.value);
    console.log("[DEBUG] Text in textarea:", enteredText);

    if (enteredText !== prompt) {
      throw new Error("Prompt was not correctly entered into the textarea");
    }

    console.log("[DEBUG] Setting up XHR listener");
    const responsePromise = new Promise((resolve) => {
      page.on("response", async (response) => {
        if (
          response.url().includes("/api/inference/chat") &&
          response.request().method() === "POST"
        ) {
          const responseBody = await response.text();
          resolve(responseBody);
        }
      });
    });

    console.log("[DEBUG] Waiting for send button to be enabled");
    await page.waitForSelector(`${sendButtonSelector}:not(:disabled)`, {
      timeout: NAVIGATION_TIMEOUT,
      visible: true,
    });
    // await checkUIState();

    await page.click(sendButtonSelector);
    console.log("[DEBUG] Clicked send button");
    await responsePromise;

    console.log("[DEBUG] Waiting for assistant response in UI");
    await page.waitForSelector(".assistant", { timeout: NAVIGATION_TIMEOUT });
    console.log("[DEBUG] Assistant response appeared in UI");

    console.log("[DEBUG] Extracting response content");
    const { responseContent, references } = await page.evaluate(() => {
      const assistantDivs = document.querySelectorAll(".assistant");
      if (assistantDivs.length === 0) {
        console.log("[DEBUG] No assistant divs found");
        return { responseContent: null, references: null };
      }

      const lastAssistantDiv = assistantDivs[assistantDivs.length - 1];

      // Extract main response
      const mainResponse = lastAssistantDiv.querySelector(".prose");

      // Extract references
      const referencesLinks = lastAssistantDiv.querySelector(".chakra-stack");

      let referencesList = [];
      if (referencesLinks) {
        referencesList = Array.from(referencesLinks.querySelectorAll("a")).map(
          (a) => {
            return {
              number: a.querySelector("sup").textContent,
              text: a.querySelector(".chakra-text").textContent,
              url: a.href,
            };
          },
        );
      }

      return {
        responseContent: mainResponse ? mainResponse.innerHTML : null,
        references: referencesList,
      };
    });

    console.log("[DEBUG] RESPONSE: ", responseContent);
    console.log("[DEBUG] REFERENCES: ", references);

    // Convert HTML to Markdown
    const turndownService = new Turndown();
    const markdown = turndownService.turndown(responseContent);

    // Convert references to markdown list
    const referencesMarkdown = references
      .map((ref) => `${ref.number}. [${ref.text}](${ref.url})`)
      .join("\n");

    console.log("[DEBUG] markdown: ", markdown);
    console.log("[DEBUG] references markdown: ", referencesMarkdown);

    return {
      response: markdown.trim(),
      references: referencesMarkdown,
    };
  } catch (error) {
    console.error("[DEBUG] Error in sendPrompt:", error);
    console.error("[DEBUG] Error stack:", error.stack);
    throw error;
  }
}

function cleanupOngoingRequests() {
  const staleTimeout = 5 * 60 * 1000; // 5 minutes
  for (const [chatId, timestamp] of ongoingRequests.entries()) {
    if (Date.now() - timestamp > staleTimeout) {
      console.log(`Pruning staled ongoing requests of ${chatId}`);
      ongoingRequests.delete(chatId);
    }
  }
}



app.post("/chat", async (req, res) => {
  const { prompt, contextId, withRefs = false, model = 'default' } = req.body;

  if (!prompt) {
    return res.status(400).send("No prompt provided");
  }

  let chatId;
  let page;

  try {
    console.log("[DEBUG] Finding or creating chat session");
    try {
      ({ chatId, page } = await findOrCreateChatSession(contextId));
      console.log("[DEBUG] Chat session found or created successfully");
    } catch (error) {
      console.error("[DEBUG] Error finding or creating chat session:", error);
      console.error("[DEBUG] Error stack:", error.stack);
      return res.status(500).json({
        error: "Failed to find or create chat session",
        details: error.message,
        stack: error.stack,
      });
    }

    // Check if there's an ongoing request for this chatId
    if (ongoingRequests.has(chatId)) {
      console.log(`[DEBUG] Waiting for ongoing request for chat ${chatId}`);
      const result = await ongoingRequests.get(chatId);
      return res.json({ chatId, result });
    }

    // Create a new promise for this request
    const requestPromise = new Promise((resolve, reject) => {
      try {
        console.log("[DEBUG] Calling sendPrompt");
        resolve(sendPrompt(page, { prompt, model: models[model] }));
        console.log("[DEBUG] sendPrompt completed");
      } catch (error) {
        reject(error);
      }
    });

    // Set the ongoing request
    ongoingRequests.set(chatId, requestPromise);

    // Wait for the request to complete
    const fullResult = await requestPromise;
    const result = withRefs ? fullResult : { response: fullResult.response };
    // Remove the ongoing request marker
    ongoingRequests.delete(chatId);

    console.log("[DEBUG] Sending response");
    res.json({ chatId, ...result });
  } catch (error) {
    // Remove the ongoing request marker in case of error
    if (chatId) ongoingRequests.delete(chatId);

    console.error("[DEBUG] Error in /chat endpoint:", error);
    console.error("[DEBUG] Error stack:", error.stack);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

async function startServer() {
  await initializeBrowser().then(() => {
    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
      setInterval(cleanupOngoingRequests, 5 * 60 * 1000);
    });
  });
}

startServer();

process.on("SIGINT", async () => {
  console.log("Shutting down server...");

  if (browser) {
    console.log("[DEBUG] Closing browser");
    await browser.close();
  }

  await server.close();
  console.log("Shutdown complete");
  process.exit();
});
