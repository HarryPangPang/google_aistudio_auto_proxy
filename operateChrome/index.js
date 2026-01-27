
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');
const { USER_DATA_DIR, CHROME_PATH, AI_STUDIO_URL, AI_STUDIO_HOME_URL } = require('../constant');

let browser;
let browserContext; // 存储持久化上下文实例
let tasks = 0; // 存储任务数量

// setInterval(() => {
//   if(tasks === 0 && browserContext){
//     browserContext.close()
//     browserContext = null
//   }
// }, 1000 * 60 * 5)

const initializeBrowser = async () => {}

const initBrowserPage = async () => {
  // 如果浏览器上下文已经存在，直接返回一个新的页面
  if (browserContext) {
    console.log('Context already exists, creating a new page...');
    const page = await browserContext.newPage();
    return page;
  }
  // 第一次运行时，启动持久化上下文
  console.log('Launching NEW persistent browser context...');
  browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, // Google 登录必须 false
    executablePath: CHROME_PATH,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--start-maximized' // 可选：最大化窗口
    ],
    viewport: null // 禁用默认 viewport，使用最大化窗口
  });
  console.log('Persistent Browser ready');

  const page = await browserContext.newPage();
  console.log('page open');
  return page;
}

const initChatContent = async (page, prompt) => {
  tasks++;
  try {
    await page.goto(AI_STUDIO_HOME_URL);
    await page.waitForLoadState('networkidle', { timeout: 1000 * 60 * 5 });
    // 先找到输入框，然后输入promot，然后点击Build按钮
    console.log('开始初始化聊天内容...');
    const errorSelector = '.error-title';
    const checkFatalError = async () => {
      try {
        const errorTitle = page.locator(errorSelector).first();
        if (await errorTitle.isVisible()) {
          const text = (await errorTitle.innerText()).trim();
          throw new Error(text || 'An internal error occurred.');
        }
      } catch (err) {
        if (err instanceof Error && err.message) {
          throw err;
        }
      }
    };

    const input = page.locator('textarea[aria-label="Enter a prompt to generate an app"], textarea.prompt-textarea, textarea').first();
    await input.waitFor({ state: 'visible', timeout: 30000 });
    await input.fill(prompt);
    await page.waitForTimeout(300);
    console.log('输入框输入完成...');
    // Build 按钮（新建场景）
    const buildButton = page.locator('button.ms-button-primary:has-text("Build"), button:has-text("Build")').first();
    await buildButton.waitFor({ state: 'visible', timeout: 300000 });
    await page.waitForFunction(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const btn = buttons.find((b) => {
        const text = (b.textContent || '').trim();
        return b.classList.contains('ms-button-primary') || text === 'Build';
      });
      return btn && btn.getAttribute('aria-disabled') !== 'true';
    }, { timeout: 30000 });
    await buildButton.click();
    await page.waitForTimeout(500);
    await checkFatalError();

    // 点击后会先跳到 /apps/temp/xxx，然后再跳到 /apps/drive/xxx
    // 优先等待 drive，如果已经跳转就直接继续，避免长时间阻塞
    const currentUrl = page.url();
    if (!/\/apps\/drive\/[^?]+/.test(currentUrl)) {
      // 先等到 temp 或 drive 任意一个出现
      await page.waitForURL(/\/apps\/(temp|drive)\//, { timeout: 1000 * 60 * 2 });
      // 如果还没到 drive，再单独等 drive（短一些）
      if (!/\/apps\/drive\/[^?]+/.test(page.url())) {
        await page.waitForURL(/\/apps\/drive\/[^?]+/, { timeout: 1000 * 60 * 2 });
      }
    }
    await checkFatalError();

    // 等待运行状态结束（同 sendChatMsg 逻辑）

  // 等待运行状态结束（同 sendChatMsg 逻辑）
  try {
    await page.locator('button .running-icon').waitFor({ state: 'visible', timeout: 5000 });
    console.log('[GoogleStudio] Generation running...');
  } catch (e) {
    console.log('[GoogleStudio] Generation might have finished quickly or running state missed.');
  }    
    await checkFatalError();
    await page.locator('button .running-icon').waitFor({ state: 'detached', timeout: 300000 });
    console.log('[GoogleStudio] Generation complete. Fetching chat content...');
    await page.waitForTimeout(1000); // Stabilization

    await checkFatalError();
    console.log('page.url()', page.url());
    const chatDomContent = await getChatDomContent(page, true);
    console.log('chatDomContent', chatDomContent);
    const finalUrl = page.url();
    const driveIdMatch = finalUrl.match(/\/apps\/drive\/([^?]+)/);
    const driveid = driveIdMatch ? driveIdMatch[1] : '';
    return {
      chatDomContent,
      driveid
    };
  } catch (e) {
    return {
      chatDomContent: '',
      driveid: ''
    }
  } finally {
    tasks--
  }
}
const goAistudio = async (page, driveid) => {
  const url = AI_STUDIO_URL.replace('{driveid}', driveid);
  await page.goto(url);
  // 等待页面核心元素加载完成
  console.log('等待 Send 按钮出现，确认页面已就绪...');
  const sendButton = page.locator('button[aria-label="Send"]');
  // 使用 attached 而不是 visible，因为有时候按钮可能在视口外或者被遮挡，但 DOM 已经存在
  await sendButton.waitFor({ state: 'attached', timeout: 300000 });
  console.log('Send 按钮已出现(attached)');
  return true
}

const downloadCode = async (page, uuid) => {

  // 尝试多个选择器找到下载按钮
  let downloadButton = null;
  // 尝试 1: 使用 aria-label
  console.log('尝试找到下载按钮...');
  let buttonLocator = page.locator('button[aria-label="下载应用"]').first();;
  if (await buttonLocator.count() > 0) {
    downloadButton = buttonLocator;
    console.log('使用 aria-label 找到按钮');
  }

  // 尝试 2: 使用 iconname="download"
  if (!downloadButton) {
    buttonLocator = page.locator('button[iconname="download"]');
    if (await buttonLocator.count() > 0) {
      downloadButton = buttonLocator;
      console.log('使用 iconname="download" 找到按钮');
    }
  }

  // 尝试 3: 查找包含 "download" 和 "mat-mdc-tooltip-trigger" 的按钮
  if (!downloadButton) {
    buttonLocator = page.locator('button.mat-mdc-tooltip-trigger:has-text("下载")');
    if (await buttonLocator.count() > 0) {
      downloadButton = buttonLocator;
      console.log('使用 has-text 找到按钮');
    }
  }

  // 尝试 4: 使用通用选择器和滚动
  if (!downloadButton) {
    console.log('未找到明确的下载按钮，尝试滚动页面寻找...');
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
    buttonLocator = page.locator('button[aria-label="下载应用"]').first();;
    if (await buttonLocator.count() > 0) {
      downloadButton = buttonLocator;
      console.log('滚动后找到按钮');
    }
  }

  if (!downloadButton) {
    throw new Error('无法找到下载按钮，已尝试多个选择器');
  }

  // 等待按钮可见
  await downloadButton.waitFor({ state: 'visible', timeout: 10000 });
  console.log('下载按钮已找到并可见');

  // 是否有提醒来自其他开发者 - 检查并处理弹窗
  const dismissDeveloperAlert = async () => {
    try {
      // 查找 "Continue to the app" 按钮
      const continueButton = page.locator('button.ms-button-primary:has-text("Continue to the app"), button:has-text("Continue to the app")').first();

      if (await continueButton.count() > 0 && await continueButton.isVisible()) {
        console.log('发现开发者提醒弹窗，正在点击 "Continue to the app"...');
        await continueButton.click();
        await page.waitForTimeout(500); // 等待弹窗关闭
        console.log('弹窗已关闭');
        return true;
      }
      return false;
    } catch (e) {
      console.log('未检测到开发者提醒弹窗');
      return false;
    }
  };

  // 尝试关闭可能存在的弹窗
  await dismissDeveloperAlert();

  // 监听下载事件并重试逻辑（最多3次）
  let downloadSuccess = false;
  let retries = 0;
  const maxRetries = 3;
  let download = null;

  while (!downloadSuccess && retries < maxRetries) {
    try {
      retries++;
      console.log(`尝试下载，第 ${retries} 次...`);

      // 再次检查弹窗（可能在点击下载后出现）
      await dismissDeveloperAlert();

      // 监听下载事件
      const downloadPromise = page.waitForEvent('download', { timeout: 10000 });

      // 点击按钮
      await downloadButton.click();
      console.log('已点击下载按钮');

      // 等待下载开始
      download = await downloadPromise;
      downloadSuccess = true;
      console.log('下载已开始');

    } catch (e) {
      console.log(`第 ${retries} 次下载尝试失败: ${e.message}`);

      if (retries < maxRetries) {
        // 尝试再次关闭弹窗
        const hadPopup = await dismissDeveloperAlert();
        if (hadPopup) {
          console.log('发现并关闭了阻止下载的弹窗，准备重试...');
        }
        await page.waitForTimeout(1000); // 等待一秒后重试
      } else {
        throw new Error(`下载失败，已尝试 ${maxRetries} 次`);
      }
    }
  }

  if (!download) {
    throw new Error('无法获取下载对象');
  }

  // 等待下载完成
  const fileName = download.suggestedFilename();

  // Define target directory and path
  const targetDir = path.resolve(__dirname, '../codedist', uuid);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const targetPath = path.join(targetDir, fileName);

  // Save to target path
  await download.saveAs(targetPath);

  console.log(`文件已下载并保存到: ${targetPath}`);
  console.log(`文件名: ${fileName}`);

  // Close the page after download is complete
  await page.close();
  page = null
  console.log('Page closed');

  return {
    targetPath,
    fileName
  }
}

const extraPath = async ({
  targetPath,
  fileName
}) => {

  try {
    const folderName = fileName.split('.')[0];
    const downloadPath = targetPath
    // 解压缩文件
    const extractDir = path.join(process.cwd(), 'extracted', folderName);

    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
    fs.mkdirSync(extractDir, { recursive: true });

    const zip = new AdmZip(downloadPath);
    zip.extractAllTo(extractDir, true);

    console.log(`文件已解压缩到: ${extractDir}`);

    // 获取解压缩目录中的内容
    const extractedItems = fs.readdirSync(extractDir);

    // 找到项目文件夹（通常是唯一的一个文件夹，或者直接就是项目文件）
    let sourceDir = extractDir;

    if (extractedItems.length === 1 && fs.statSync(path.join(extractDir, extractedItems[0])).isDirectory()) {
      sourceDir = path.join(extractDir, extractedItems[0]);
    }

    console.log(`源目录: ${sourceDir}`);
    return sourceDir

  } catch (error) {
    console.error('处理错误:', error);

  }
}

const runInstallBuild = async (sourceDir) => {
  return new Promise((resolve, reject) => {

    console.log('在后台开始安装依赖...');
    const installProcess = spawn('npm', ['install'], {
      cwd: sourceDir,
      stdio: 'pipe'
    });

    installProcess.stdout.on('data', (data) => {
      console.log(`[npm install] ${data}`);
    });

    installProcess.stderr.on('data', (data) => {
      console.error(`[npm install error] ${data}`);
    });

    installProcess.on('close', (code) => {
      if (code === 0) {
        console.log('npm install 成功，开始执行 npm run build...');
        console.log('在后台开始执行 npm run build...');
        const buildProcess = spawn('npm', ['run', 'build'], {
          cwd: sourceDir,
          stdio: 'pipe'
        });

        buildProcess.stdout.on('data', (data) => {
          console.log(`[npm run build] ${data}`);
        });

        buildProcess.stderr.on('data', (data) => {
          console.error(`[npm run build error] ${data}`);
        });

        buildProcess.on('close', (code) => {
          if (code === 0) {
            console.log('✓ npm run build 完成成功');
            resolve();
          } else {
            console.error(`✗ npm run build 失败，退出码: ${code}`);
            reject(new Error(`npm run build failed with code ${code}`));
          }
        });
      } else {
        console.error(`npm install 失败，退出码: ${code}`);
        reject(new Error(`npm install failed with code ${code}`));
      }
    });


  });
}

const getChatDomContent = async (page, needClose, needWait) => {
  tasks++;
  try {
    const close = () => {
      if (needClose) {
        page.close()
        page = null
      }

    }
    if (needWait) {
      await page.waitForLoadState('networkidle', { timeout: 1000 * 60 * 5 });
    }
    console.log('开始获取聊天内容...');
    // 等待.output-container元素出现
    await page.waitForSelector('.output-container', { state: 'visible', timeout: 1000 * 60 * 5 });
    console.log('output-container元素已出现');
    // 获取 output-container 内容
    const content = await page.evaluate(() => {
      const container = document.querySelector('.output-container');
      if (!container) {
        close()
        return ''
      };

      // 克隆节点以避免修改页面上的实际内容
      const clone = container.cloneNode(true);

      // 移除所有注释节点
      const removeComments = (node) => {
        const children = node.childNodes;
        for (let i = children.length - 1; i >= 0; i--) {
          const child = children[i];
          if (child.nodeType === 8) { // Node.COMMENT_NODE
            node.removeChild(child);
          } else if (child.nodeType === 1) { // Node.ELEMENT_NODE
            removeComments(child);
          }
        }
      };
      removeComments(clone);

      // 移除所有元素的 _ngcontent-* 属性
      const allElements = clone.querySelectorAll('*');
      allElements.forEach(el => {
        Array.from(el.attributes).forEach(attr => {
          if (attr.name.startsWith('_ngcontent-') || attr.name.startsWith('_nghost-ng-')) {
            el.removeAttribute(attr.name);
          }
        });
      });
      setTimeout(() => {
        close()
      }, 1000)
      return clone.innerHTML;

    });
    close()
    return content;
  } catch (e) {
    close()
    return ''
  } finally {
    tasks--
  }
}

const sendChatMsg = async (page, prompt, needClose) => {
  tasks++;
  const close = () => {
    if (needClose) {
      page.close()
      page = null
    }
  }
  try {
    await page.waitForLoadState('networkidle', { timeout: 1000 * 60 * 5 });
    await page.waitForSelector('.output-container', { state: 'visible', timeout: 1000 * 60 * 5 });
    console.log('output-container元素已出现');
    console.log('[GoogleStudio] Waiting for input...');
    const input = page.locator('textarea').first(); // Or specific selector
    await input.waitFor({ state: 'visible', timeout: 10000 });
    await input.fill(prompt);
    await page.waitForTimeout(500);
    const sendButton = page.locator('button[aria-label="Run"], button:has-text("Run"), button.send-button').first();
    if (await sendButton.isVisible()) {
      await sendButton.click();
    } else {
      await input.press('Enter');
    }
    console.log('[GoogleStudio] Prompt sent. Waiting for generation...');
    await page.locator('button .running-icon').waitFor({ state: 'visible', timeout: 5000 });
    console.log('[GoogleStudio] Generation running...');

    await page.locator('button .running-icon').waitFor({ state: 'detached', timeout: 300000 });
    console.log('[GoogleStudio] Generation complete. Attempting download...');
    await page.waitForTimeout(1000); // Stabilization
    tasks--
    if (needClose) {
      close()
    }
  } catch (e) {
    tasks--
    close()
    console.log('[GoogleStudio] Generation might have finished quickly or running state missed.');
  }
}

module.exports = {
  goAistudio: goAistudio,
  initBrowserPage: initBrowserPage,
  downloadCode: downloadCode,
  extraPath: extraPath,
  runInstallBuild: runInstallBuild,
  getChatDomContent: getChatDomContent,
  sendChatMsg: sendChatMsg,
  initChatContent: initChatContent,
  initializeBrowser: initializeBrowser
}