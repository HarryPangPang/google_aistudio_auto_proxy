const { chromium } = require('playwright');
const path = require('path');
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {

  const userDataDir = path.resolve('./chrome-profile');

  const browser = await chromium.launchPersistentContext(userDataDir, {
    headless: false,

    executablePath: chromePath,

    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars'
    ],

    viewport: null
  });

  const page = await browser.newPage();

  await page.goto('https://aistudio.google.com/apps/drive/1DjJtbbdHp76qwU0ynCalJxlnfuq5-1ul?showAssistant=true&showCode=true');

  console.log('👉 请手动登录 Google');

})();
