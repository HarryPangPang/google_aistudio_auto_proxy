const Koa = require('koa');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');
const axios = require('axios');
const path = require('path');
const { chromium } = require('playwright');

const app = new Koa();
const router = new Router();
const PORT = 1111;

app.use(cors());
app.use(bodyParser());

// Configuration
const AI_STUDIO_URL = 'https://aistudio.google.com/apps/drive/1DjJtbbdHp76qwU0ynCalJxlnfuq5-1ul?showAssistant=true&showCode=true'; 
const USER_DATA_DIR = path.resolve('./chrome-profile');
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; 

let browserContext = null;
let page = null;

// Helper to extract files from nested array
function extractFilesFromPayload(data) {
    const files = {};
    
    function traverse(item) {
        if (Array.isArray(item)) {
            // Check if this array looks like a file entry [filename, content]
            if (item.length === 2 && typeof item[0] === 'string' && typeof item[1] === 'string') {
                const name = item[0];
                const content = item[1];
                // Check if content is base64 (simple check) or looks like code
                if (name.includes('.') && (content.length > 20 || content.startsWith('Cg') || content.startsWith('ew'))) {
                    try {
                        // Try decoding base64
                        const decoded = Buffer.from(content, 'base64').toString('utf8');
                        files[name] = decoded;
                        return;
                    } catch (e) {
                        // Not base64, maybe raw text?
                        // files[name] = content;
                    }
                }
            }
            item.forEach(traverse);
        }
    }
    
    traverse(data);
    return files;
}

async function initBrowser() {
    if (browserContext && page) return { context: browserContext, page };

    console.log('[GoogleStudio] Launching browser...');
    browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false, 
        executablePath: CHROME_PATH,
        args: ['--disable-blink-features=AutomationControlled', '--disable-infobars'],
        viewport: null
    });

    const pages = browserContext.pages();
    page = pages.length > 0 ? pages[0] : await browserContext.newPage();
    
    if (!page.url().includes('aistudio.google.com')) {
        await page.goto(AI_STUDIO_URL);
        await page.waitForTimeout(5000); 
    }
    
    return { context: browserContext, page };
}

router.post('/api/task', async (ctx) => {
    const { prompt } = ctx.request.body;
    console.log(`[GoogleStudio] Received task: "${prompt}"`);

    try {
        const { page } = await initBrowser();
        let capturedFiles = null;

        // 1. Setup Request Interception for SaveDriveApplet
        const requestHandler = async (request) => {
            if (request.url().includes('SaveDriveApplet') && request.method() === 'POST') {
                console.log('[GoogleStudio] Intercepted SaveDriveApplet request');
                try {
                    const postData = request.postData();
                    // Post Data is likely a JSON string representing the array
                    // OR it might be encoded. The user sample shows --data-raw '[[...]]' which is JSON.
                    if (postData) {
                        const data = JSON.parse(postData);
                        const files = extractFilesFromPayload(data);
                        if (Object.keys(files).length > 0) {
                            console.log(`[GoogleStudio] Captured ${Object.keys(files).length} files`);
                            capturedFiles = files;
                        }
                    }
                } catch (e) {
                    console.error('[GoogleStudio] Failed to parse request:', e);
                }
            }
        };
        page.on('request', requestHandler);

        // 2. Input and Run
        console.log('[GoogleStudio] Waiting for input...');
        const input = page.locator('textarea').first(); 
        await input.waitFor({ state: 'visible', timeout: 10000 });
        await input.fill(prompt);
        await page.waitForTimeout(500);

        const sendButton = page.locator('button[aria-label="Run"], button:has-text("Run"), button.send-button').first();
        if (await sendButton.isVisible()) {
            await sendButton.click();
        } else {
            await input.press('Enter');
        }
        
        console.log('[GoogleStudio] Prompt sent. Waiting for generation and save...');

        // 3. Wait for Capture
        // Wait up to 3 minutes for the SaveDriveApplet request
        const startTime = Date.now();
        while (!capturedFiles && Date.now() - startTime < 180000) {
            await page.waitForTimeout(1000);
        }

        // Remove listener
        page.off('request', requestHandler);

        if (!capturedFiles) {
            throw new Error('Timeout: Did not capture SaveDriveApplet request');
        }

        // 4. Send to Preview
        console.log('[GoogleStudio] Uploading to Preview Service...');
        const PREVIEW_URL = ''; 
        const deployRes = await axios.post(`${PREVIEW_URL}/api/deploy`, { files: capturedFiles });

        ctx.body = { 
            success: true, 
            message: 'Task completed',
            deploy: deployRes.data 
        };

    } catch (err) {
        console.error('[GoogleStudio] Error:', err);
        ctx.status = 500;
        ctx.body = { error: err.message };
    }
});

app.use(router.routes()).use(router.allowedMethods());

app.listen(PORT, () => {
    console.log(`GoogleStudio Automation Server running at http://localhost:${PORT}`);
});
