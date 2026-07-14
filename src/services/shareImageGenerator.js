const puppeteer = require("puppeteer");

/*
|--------------------------------------------------------------------------
| Contriba Share Image Generator
|--------------------------------------------------------------------------
|
| This service does not manually redesign the event card.
|
| It opens the real React ShareCardPage, waits for the existing EventCard
| to load with real event data, and screenshots the full 1200 × 630 canvas.
|
*/

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

/*
|--------------------------------------------------------------------------
| Frontend URL
|--------------------------------------------------------------------------
|
| Local:
| FRONTEND_URL=http://localhost:5173
|
| Production:
| FRONTEND_URL=https://contriba.online
|
*/

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  "http://localhost:5173";

let browserPromise = null;

/*
|--------------------------------------------------------------------------
| Normalize frontend URL
|--------------------------------------------------------------------------
*/

function getFrontendUrl() {
  return String(FRONTEND_URL)
    .trim()
    .replace(/\/+$/, "");
}

/*
|--------------------------------------------------------------------------
| Build the real React share-card page URL
|--------------------------------------------------------------------------
*/

function buildShareCardUrl(eventId) {
  const baseUrl =
    getFrontendUrl();

  return `${baseUrl}/share-card/${encodeURIComponent(
    eventId
  )}`;
}

/*
|--------------------------------------------------------------------------
| Start or reuse Puppeteer browser
|--------------------------------------------------------------------------
*/

async function getBrowser() {
  if (!browserPromise) {
    browserPromise =
      puppeteer
        .launch({
          headless: true,

          executablePath:
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  undefined,

          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-software-rasterizer",
            "--no-zygote",
          ],
        })
        .catch((error) => {
          browserPromise = null;
          throw error;
        });
  }

  return browserPromise;
}

/*
|--------------------------------------------------------------------------
| Wait for fonts and images
|--------------------------------------------------------------------------
*/

async function waitForPageAssets(page) {
  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }

    const images =
      Array.from(
        document.images
      );

    await Promise.all(
      images.map((image) => {
        if (
          image.complete &&
          image.naturalWidth > 0
        ) {
          return Promise.resolve();
        }

        return new Promise(
          (resolve) => {
            const finish = () => {
              resolve();
            };

            image.addEventListener(
              "load",
              finish,
              {
                once: true,
              }
            );

            image.addEventListener(
              "error",
              finish,
              {
                once: true,
              }
            );

            setTimeout(
              finish,
              10000
            );
          }
        );
      })
    );
  });
}

/*
|--------------------------------------------------------------------------
| Generate the Open Graph image
|--------------------------------------------------------------------------
*/

async function generateEventShareImage(
  event
) {
  if (!event?.id) {
    throw new Error(
      "A valid event is required to generate a share image."
    );
  }

  const browser =
    await getBrowser();

  const page =
    await browser.newPage();

  try {
    /*
    |--------------------------------------------------------------------------
    | Create the exact Open Graph viewport
    |--------------------------------------------------------------------------
    */

    await page.setViewport({
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      deviceScaleFactor: 1,
    });

    /*
    |--------------------------------------------------------------------------
    | Helpful browser error logging
    |--------------------------------------------------------------------------
    */

    page.on(
      "console",
      (message) => {
        const type =
          message.type();

        if (
          type === "error" ||
          type === "warning"
        ) {
          console.log(
            `Share card browser ${type}:`,
            message.text()
          );
        }
      }
    );

    page.on(
      "pageerror",
      (error) => {
        console.error(
          "Share card page error:",
          error.message
        );
      }
    );

    /*
    |--------------------------------------------------------------------------
    | Open the real React ShareCardPage
    |--------------------------------------------------------------------------
    */

    const shareCardUrl =
      buildShareCardUrl(
        event.id
      );

    console.log(
      "Rendering real Contriba EventCard:",
      shareCardUrl
    );

    const response =
      await page.goto(
        shareCardUrl,
        {
          waitUntil:
            "domcontentloaded",

          timeout: 45000,
        }
      );

    if (
      !response ||
      !response.ok()
    ) {
      const status =
        response?.status();

      throw new Error(
        `Share card page returned status ${
          status || "unknown"
        }.`
      );
    }

    /*
    |--------------------------------------------------------------------------
    | Wait for ShareCardPage to finish loading the real event
    |--------------------------------------------------------------------------
    */

    await page.waitForFunction(
      () => {
        const isReady =
          window
            .__CONTRIBA_SHARE_CARD_READY__ ===
            true ||
          document.documentElement.getAttribute(
            "data-share-card-ready"
          ) === "true";

        const hasError =
          window
            .__CONTRIBA_SHARE_CARD_ERROR__ ===
            true ||
          document.documentElement.getAttribute(
            "data-share-card-error"
          ) === "true";

        return (
          isReady ||
          hasError
        );
      },
      {
        timeout: 35000,
      }
    );

    /*
    |--------------------------------------------------------------------------
    | Stop if the React page failed to load the event
    |--------------------------------------------------------------------------
    */

    const pageFailed =
      await page.evaluate(() => {
        return (
          window
            .__CONTRIBA_SHARE_CARD_ERROR__ ===
            true ||
          document.documentElement.getAttribute(
            "data-share-card-error"
          ) === "true"
        );
      });

    if (pageFailed) {
      throw new Error(
        "The React ShareCardPage could not load the event."
      );
    }

    /*
    |--------------------------------------------------------------------------
    | Confirm that the real EventCard exists
    |--------------------------------------------------------------------------
    */

    await page.waitForSelector(
  "#contriba-share-card .social-preview",
  {
    visible: true,
    timeout: 15000,
  }
);

    /*
    |--------------------------------------------------------------------------
    | Wait for the real event image and fonts
    |--------------------------------------------------------------------------
    */

    await waitForPageAssets(
      page
    );

    /*
    |--------------------------------------------------------------------------
    | Give the browser two final frames to finish layout
    |--------------------------------------------------------------------------
    */

    await page.evaluate(() => {
      return new Promise(
        (resolve) => {
          requestAnimationFrame(
            () => {
              requestAnimationFrame(
                resolve
              );
            }
          );
        }
      );
    });

    /*
    |--------------------------------------------------------------------------
    | Ensure screenshot starts at the top-left
    |--------------------------------------------------------------------------
    */

    await page.evaluate(() => {
      window.scrollTo(
        0,
        0
      );
    });

    /*
    |--------------------------------------------------------------------------
    | Screenshot the full 1200 × 630 canvas
    |--------------------------------------------------------------------------
    |
    | This keeps the actual EventCard exactly as React rendered it.
    |
    */

    const screenshot =
      await page.screenshot({
        type: "png",

        clip: {
          x: 0,
          y: 0,
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
        },

        captureBeyondViewport:
          false,

        omitBackground:
          false,
      });

    return Buffer.from(
      screenshot
    );
  } catch (error) {
    console.error(
      "Real Contriba EventCard screenshot failed:",
      error
    );

    throw new Error(
      `Failed to generate the real EventCard image: ${error.message}`
    );
  } finally {
    await page.close();
  }
}

/*
|--------------------------------------------------------------------------
| Close Puppeteer safely
|--------------------------------------------------------------------------
*/

async function closeShareImageBrowser() {
  if (!browserPromise) {
    return;
  }

  try {
    const browser =
      await browserPromise;

    await browser.close();
  } catch (error) {
    console.warn(
      "Could not close the share-image browser:",
      error.message
    );
  } finally {
    browserPromise = null;
  }
}

/*
|--------------------------------------------------------------------------
| Graceful application shutdown
|--------------------------------------------------------------------------
*/

process.once(
  "SIGINT",
  async () => {
    await closeShareImageBrowser();

    process.exit(0);
  }
);

process.once(
  "SIGTERM",
  async () => {
    await closeShareImageBrowser();

    process.exit(0);
  }
);

/*
|--------------------------------------------------------------------------
| Exports
|--------------------------------------------------------------------------
*/

module.exports = {
  CARD_WIDTH,
  CARD_HEIGHT,
  generateEventShareImage,
  closeShareImageBrowser,
};