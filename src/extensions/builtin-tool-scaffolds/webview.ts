import { scaffold } from "./_scaffold-helper";

export const WEBVIEW = scaffold(
	"webview",
	"Interact with Obsidian's Web Viewer tab. Use 'read' to get page content as Markdown, 'click' to click a link by visible text, or 'navigate' to load a URL. Desktop only.",
	"write",
	`params:
  action:
    type: string
    description: "The action to perform: 'read' extracts page content, 'click' clicks a link by text, 'navigate' loads a URL."
    enum:
      - read
      - click
      - navigate
  scope:
    type: string
    description: "Which Web Viewer to use. 'conversation' uses a dedicated leaf for this conversation. 'active' reads the user's currently focused Web Viewer tab."
    enum:
      - conversation
      - active
    default: "conversation"
  text:
    type: string
    description: "For 'click' action: the visible text of the link to click (case-insensitive partial match)."
  url:
    type: string
    description: "For 'navigate' action: the URL to load."
settings:
  webview_max_output_chars:
    name: "Max Output Characters"
    type: number
    description: "Maximum characters returned to the LLM. Longer content is truncated."
    default: 50000
    min: 1000
    max: 500000`,
	`const log = utils.logger("webview");

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("The webview tool requires Obsidian Desktop (Electron). It is not available on mobile.");
}

if (!utils.webview) {
  throw new Error("Webview subsystem unavailable.");
}

const action = params.action as string;
if (!action || !["read", "click", "navigate"].includes(action)) {
  throw new Error("Missing or invalid 'action' parameter. Must be 'read', 'click', or 'navigate'.");
}

const scope = (params.scope as string) || "conversation";
const maxOutputChars = settings.webview_max_output_chars as number;

function initTurndown(): any {
  const td = new libs.Turndown({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  td.use(libs.turndownGfm.gfm);
  td.addRule("stripNav", {
    filter: ["nav", "footer", "aside"],
    replacement: () => "",
  });
  td.addRule("stripForms", {
    filter: ["form", "input", "select", "button"],
    replacement: () => "",
  });
  return td;
}

async function getWebview(): Promise<{ leaf: any; webviewEl: any }> {
  if (scope === "active") {
    const result = utils.webview!.getActiveWebview();
    if (!result) {
      throw new Error("No Web Viewer tab is currently active. Switch to a Web Viewer tab and try again, or use scope: 'conversation' for autonomous browsing.");
    }
    return result;
  }
  const result = await utils.webview!.getConversationWebview();
  if (!result) {
    throw new Error("Could not open or find a Web Viewer leaf. Ensure Obsidian's Web Viewer core plugin is enabled.");
  }
  return result;
}

if (action === "read") {
  const { leaf, webviewEl } = await getWebview();
  await utils.webview!.waitForReady(webviewEl, scope === "conversation", leaf);

  const url = await webviewEl.executeJavaScript("window.location.href");
  const title = await webviewEl.executeJavaScript("document.title");

  const links = await webviewEl.executeJavaScript(\`
    Array.from(document.querySelectorAll('a[href]'))
      .filter(a => a.innerText.trim().length > 0)
      .filter(a => {
        const href = a.getAttribute('href');
        return href && !href.startsWith('#') && !href.startsWith('javascript:');
      })
      .slice(0, 50)
      .map(a => ({ text: a.innerText.trim().substring(0, 100), href: a.href }))
  \`);

  const html = await webviewEl.executeJavaScript("document.documentElement.outerHTML");
  let content: string;
  try {
    content = initTurndown().turndown(html);
  } catch {
    content = html;
  }

  let truncated = false;
  if (content.length > maxOutputChars) {
    content = content.substring(0, maxOutputChars);
    truncated = true;
  }

  const result: any = { url, title, links, content };
  if (truncated) {
    result.note = \`Content truncated at \${maxOutputChars.toLocaleString()} characters.\`;
  }

  log.info("Read webview", { url, title, linkCount: links.length, contentLength: content.length, truncated });
  return result;
}

if (action === "navigate") {
  const targetUrl = params.url as string;
  if (!targetUrl || typeof targetUrl !== "string") {
    throw new Error("Missing required parameter: 'url' (required for navigate action).");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    throw new Error(\`Invalid URL: \${targetUrl}\`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(\`Unsupported protocol: \${parsedUrl.protocol}. Only http:// and https:// URLs are accepted.\`);
  }

  const denyCheck = utils.isDomainBlocked(targetUrl, shared.domain_denylist ?? []);
  if (denyCheck.blocked) {
    log.info("Domain blocked by denylist", { url: targetUrl, pattern: denyCheck.pattern });
    throw new Error(\`Domain \${parsedUrl.hostname} is blocked by your denylist.\`);
  }

  const { leaf, webviewEl } = await getWebview();

  await webviewEl.loadURL(targetUrl);
  await utils.webview!.waitForReady(webviewEl, scope === "conversation", leaf);

  const newUrl = await webviewEl.executeJavaScript("window.location.href");
  const newTitle = await webviewEl.executeJavaScript("document.title");

  if (scope === "conversation") {
    const convId = utils.webview!.getConversationId();
    if (convId) {
      await utils.webview!.persistUrl(convId, newUrl);
    }
  }

  log.info("Navigate webview", { targetUrl, newUrl, newTitle });
  return { url: newUrl, title: newTitle };
}

if (action === "click") {
  const text = params.text as string;
  if (!text || typeof text !== "string") {
    throw new Error("Missing required parameter: 'text' (required for click action).");
  }

  const { leaf, webviewEl } = await getWebview();
  await utils.webview!.waitForReady(webviewEl, scope === "conversation", leaf);

  const safeText = JSON.stringify(text);
  const clickResult = await webviewEl.executeJavaScript(\`
    (function(targetText) {
      const links = Array.from(document.querySelectorAll('a'));
      const target = targetText.toLowerCase();
      const match = links.find(a =>
        a.innerText.trim().toLowerCase().includes(target)
      );
      if (match) {
        match.click();
        return { found: true, text: match.innerText.trim().substring(0, 100), href: match.href };
      }
      const available = links
        .filter(a => a.innerText.trim().length > 0)
        .slice(0, 20)
        .map(a => a.innerText.trim().substring(0, 80));
      return { found: false, available };
    })(\${safeText})
  \`);

  if (!clickResult.found) {
    const availableStr = clickResult.available?.length > 0
      ? \`\\n\\nAvailable link texts: \${clickResult.available.map((t: string) => \`"\${t}"\`).join(", ")}\`
      : "";
    throw new Error(\`No link found with text matching "\${text}".\${availableStr}\`);
  }

  await utils.webview!.waitForReady(webviewEl, scope === "conversation", leaf);

  const newUrl = await webviewEl.executeJavaScript("window.location.href");
  const newTitle = await webviewEl.executeJavaScript("document.title");

  if (scope === "conversation") {
    const convId = utils.webview!.getConversationId();
    if (convId) {
      await utils.webview!.persistUrl(convId, newUrl);
    }
  }

  log.info("Click webview", { text, clicked: clickResult.text, newUrl, newTitle });
  return { clicked: clickResult.text, new_url: newUrl, new_title: newTitle };
}

throw new Error(\`Unknown action: \${action}\`);`,
);
