const { chromium } = require('playwright');
const path = require('path');
const { CHROME_PATH, USER_DATA_DIR, AI_STUDIO_URL } = require('./constant');
(async () => {

  const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    executablePath: CHROME_PATH,

    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars'
    ],

    viewport: null
  });

  const page = await browser.newPage();

  await page.goto(AI_STUDIO_URL);

  console.log('👉 请手动登录 Google');

})();
