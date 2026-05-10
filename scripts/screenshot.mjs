/**
 * Headless screenshot driver for Token Dashboard.
 * Uses CDP via puppeteer-core against the system Chrome.
 *
 * Usage: node scripts/screenshot.mjs
 *   BASE=http://127.0.0.1:8080  override URL
 *   OUT_DIR=docs/screenshots     override output dir
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const CHROME =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "http://127.0.0.1:8080";
const OUT_DIR = resolve(process.env.OUT_DIR || "docs/screenshots");
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 };

const TABS = [
  { route: "overview", file: "overview" },
  { route: "prompts",  file: "prompts"  },
  { route: "sessions", file: "sessions" },
  { route: "work",     file: "token-sink" },
  { route: "tips",     file: "tips"     },
  { route: "settings", file: "settings" },
];

const THEMES = [
  { id: "bench",       file: "theme-bench"        },
  { id: "forge",       file: "theme-forge"        },
  { id: "forest",      file: "theme-forest"       },
  { id: "dusk",        file: "theme-dusk"         },
  { id: "ocean",       file: "theme-ocean"        },
  { id: "matrix",      file: "theme-matrix"       },
  { id: "rose",        file: "theme-rose"         },
  { id: "bb-dark",     file: "theme-breaking-bad" },
  { id: "cyber-dark",  file: "theme-cyberpunk"    },
  { id: "paper",       file: "theme-paper"        },
  { id: "linen",       file: "theme-linen"        },
  { id: "mint",        file: "theme-mint"         },
  { id: "lilac",       file: "theme-lilac"        },
  { id: "bb-light",    file: "theme-bb-light"     },
  { id: "cyber-light", file: "theme-cyber-light"  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForReady(page) {
  await page.waitForSelector(".dir-a-root", { timeout: 15000 });
  await page.waitForFunction(
    () => {
      const root = document.querySelector(".dir-a-root");
      return root && root.querySelectorAll(".a-card, .a-kpi, .a-table").length > 0;
    },
    { timeout: 15000 }
  ).catch(() => {});
  await sleep(1200);
}

async function setTheme(page, id) {
  await page.evaluate((id) => {
    localStorage.setItem("td.theme.v2", id);
  }, id);
}

async function shoot(page, route, outFile) {
  await page.goto(`${BASE}/#/${route}`, { waitUntil: "domcontentloaded" });
  await waitForReady(page);
  await page.screenshot({ path: outFile, type: "png" });
  console.log("  →", outFile);
}

(async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: VIEWPORT,
    args: [
      "--hide-scrollbars",
      "--disable-gpu",
      "--no-sandbox",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ],
  });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  // Warm up + set default theme
  await page.goto(`${BASE}/#/overview`, { waitUntil: "domcontentloaded" });
  await waitForReady(page);

  console.log("Tabs (default theme)…");
  for (const t of TABS) {
    await setTheme(page, "bench");
    await shoot(page, t.route, `${OUT_DIR}/${t.file}.png`);
  }

  console.log("Themes (overview)…");
  for (const th of THEMES) {
    await setTheme(page, th.id);
    await shoot(page, "overview", `${OUT_DIR}/${th.file}.png`);
  }

  await browser.close();
  console.log("Done →", OUT_DIR);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
