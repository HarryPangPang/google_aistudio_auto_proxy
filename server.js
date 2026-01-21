const Koa = require('koa');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');
const axios = require('axios');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const PREVIEW_URL = 'http://localhost:1234';
const { 
    initBrowserPage, 
    goAistudio, 
    downloadCode,
    runInstallBuild,
    extraPath,
    getChatDomContent,
    sendChatMsg
 } = require('./operateChrome/index');

const app = new Koa();
const router = new Router();
const PORT = 8080;

app.use(cors());
app.use(bodyParser());

// Configuration
const AI_STUDIO_URL = 'https://aistudio.google.com/apps/drive/1DjJtbbdHp76qwU0ynCalJxlnfuq5-1ul?showAssistant=true&showCode=true'; // Replace with your specific project URL if needed
const USER_DATA_DIR = path.resolve('./chrome-profile');
// const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; // Adjust for your OS
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const initBrowser = async ()=>{

}

router.post('/api/task', async (ctx) => {
    const { prompt } = ctx.request.body;
    console.log(`[GoogleStudio] Received task: "${prompt}"`);

    try {
        const { page } = await initBrowser();
        
        console.log('[GoogleStudio] Waiting for input...');
        const input = page.locator('textarea').first(); // Or specific selector
        await input.waitFor({ state: 'visible', timeout: 10000 });
        
        // 2. Input Prompt
        await input.fill(prompt);
        await page.waitForTimeout(500);

        // 3. Click Send/Run
        // Look for a button near the input, often has an icon or "Run" text
        const sendButton = page.locator('button[aria-label="Run"], button:has-text("Run"), button.send-button').first();
        if (await sendButton.isVisible()) {
            await sendButton.click();
        } else {
            await input.press('Enter');
        }
        
        console.log('[GoogleStudio] Prompt sent. Waiting for generation...');
        
        // Wait for "Run" button to show the running icon
        try {
            await page.locator('button .running-icon').waitFor({ state: 'visible', timeout: 5000 });
            console.log('[GoogleStudio] Generation running...');
        } catch(e) {
            console.log('[GoogleStudio] Generation might have finished quickly or running state missed.');
        }

        // Wait for the running icon to disappear (Completion)
        // Set a long timeout for generation
        await page.locator('button .running-icon').waitFor({ state: 'detached', timeout: 300000 });
        
        // Optional: Wait for "Restore" button to ensure checkpoint is saved
        // await page.locator('button[aria-label="Restore code from this checkpoint"]').waitFor({ state: 'visible', timeout: 10000 });

        console.log('[GoogleStudio] Generation complete. Attempting download...');
        await page.waitForTimeout(1000); // Stabilization

        // 5. Download
        let downloadBtn = null;
        const downloadSelectors = [
            'button[aria-label="下载应用"]',
            'button[iconname="download"]',
            'button.mat-mdc-tooltip-trigger:has-text("下载")',
            'button:has-text("Download")'
        ];

        for (const selector of downloadSelectors) {
            const btn = page.locator(selector).first();
            if (await btn.isVisible()) {
                downloadBtn = btn;
                console.log(`[GoogleStudio] Found download button: ${selector}`);
                break;
            }
        }

        if (!downloadBtn) {
            console.log('[GoogleStudio] Download button not visible, trying scroll...');
            // Scroll logic
             await page.evaluate(() => {
                const buttons = document.querySelectorAll('button');
                buttons.forEach(btn => {
                  if (btn.getAttribute('aria-label')?.includes('下载') || 
                      btn.getAttribute('iconname') === 'download' ||
                      btn.textContent?.includes('下载')) {
                    btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }
                });
              });
              await page.waitForTimeout(1000);
              // Try again
              for (const selector of downloadSelectors) {
                const btn = page.locator(selector).first();
                if (await btn.isVisible()) {
                    downloadBtn = btn;
                    break;
                }
            }
        }

        if (!downloadBtn) {
            throw new Error('Download button not found after generation.');
        }
        
        // Setup download listener BEFORE clicking
        const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
        
        await downloadBtn.click();
        
        const download = await downloadPromise;
        const downloadPath = await download.path();
        console.log(`[GoogleStudio] Downloaded to ${downloadPath}`);

        // 6. Extract and Process Zip
        const zip = new AdmZip(downloadPath);
        const zipEntries = zip.getEntries();
        const files = {};

        // Find the root folder inside zip if any
        // Usually zips have "ProjectName/src/..." structure or just flat.
        // We need to flatten it or respect structure.
        
        zipEntries.forEach(entry => {
            if (entry.isDirectory) return;
            
            // Normalize path: remove leading folder if it exists and is a common root
            // For simplicity, we keep full path but strip the top-level dir if it looks like a project container
            let entryPath = entry.entryName;
            const parts = entryPath.split('/');
            if (parts.length > 1 && !entryPath.startsWith('src') && !entryPath.startsWith('public')) {
                 // Heuristic: if top folder is not src/public, maybe strip it? 
                 // Actually, Preview service handles paths well. Let's just pass it.
                 // But wait, if it's "MyProject/src/App.tsx", we want "src/App.tsx"?
                 // Let's strip the first segment if it seems like a container.
                 if (!['src', 'public', 'package.json', 'vite.config.ts', 'index.html'].includes(parts[0])) {
                     entryPath = parts.slice(1).join('/');
                 }
            }
            
            files[entryPath] = entry.getData().toString('utf8');
        });

        // 7. Send to Preview
        console.log('[GoogleStudio] Uploading to Preview Service...');
        const PREVIEW_URL = 'http://localhost:1234'; 
        const deployRes = await axios.post(`${PREVIEW_URL}/api/deploy`, { files });

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
// 获取聊天内容
router.get('/api/chatcontent', async(ctx)=>{
    const page = await initBrowserPage()
    await goAistudio(page)
    const chatDomContent = await getChatDomContent(page, true)
    ctx.body = {
        success: true,
        message: 'Chat content fetched',
        chatDomContent: chatDomContent
    }
})
// 发送聊天消息
router.post('/api/chatmsg', async(ctx)=>{
    const { prompt } = ctx.request.body;
    const page = await initBrowserPage()
    await goAistudio(page)
    
    await sendChatMsg(page, prompt)
    const chatDomContent = await getChatDomContent(page, true)
    ctx.body = {
        success: true,
        message: 'Chat content fetched',
        chatDomContent: chatDomContent
    }
})
// 下载代码
router.get('/api/download', async (ctx) => {
    const { url } = ctx.request.body;
    console.log(`[GoogleStudio] Received download request for: ${url}`);

    try {
        const page = await initBrowserPage()
        await goAistudio(page)
        const res = await downloadCode(page)
        const chatDomContent = await getChatDomContent(page)
        return res
    }catch(err) {
        console.error('[GoogleStudio] Error:', err);
        ctx.status = 500;
        ctx.body = { error: err.message };
    }
});

router.post('/api/deploywithcode', async (ctx) => {
    const { data } = ctx.request.body;
    try {
        const page = await initBrowserPage()
        await goAistudio(page)
        const uuid = uuidv4()
        const res = await downloadCode(page, uuid)
        await axios.post(`${PREVIEW_URL}/api/buildcode`, { data: {
            fileName: res?.fileName,
            targetPath: res?.targetPath,
            id: uuid
        } })
        ctx.body = {
            success: true,
            message: 'Deploy with code request received',
            data: res,
            url: `preview?id=${uuid}`
        }
    } catch (error) {
        console.error('[GoogleStudio] Error:', error);
        ctx.status = 500;
        ctx.body = { error: error.message };
    }
})
app.use(router.routes()).use(router.allowedMethods());

app.listen(PORT, () => {
    console.log(`GoogleStudio Automation Server running at http://localhost:${PORT}`);
});
