
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

const initializeBrowser = async () => { }

/**
 * 创建错误监控器
 * @param {Page} page - Playwright 页面对象
 * @param {number} interval - 监控间隔（毫秒），默认500ms
 * @returns {Object} 包含 check, startMonitoring, stopMonitoring 方法的对象
 */
const createErrorMonitor = (page, interval = 500) => {
  const errorSelector = '.error-container';
  let errorMonitorInterval = null;
  let errorDetected = false;

  // 检查是否出现错误
  const check = async () => {
    if (errorDetected) return; // 避免重复检测

    try {
      const errorContainer = page.locator(errorSelector).first();
      if (await errorContainer.isVisible()) {
        errorDetected = true;
        // 尝试获取错误文本
        const errorTitle = page.locator('.error-title').first();
        let errorText = 'An internal error occurred.';

        if (await errorTitle.isVisible()) {
          const text = (await errorTitle.innerText()).trim();
          if (text) errorText = text;
        }

        // 停止监控
        stopMonitoring();

        throw new Error(`AI Studio Error: ${errorText}`);
      }
    } catch (err) {
      // 如果是我们抛出的错误，继续抛出
      if (err instanceof Error && err.message.startsWith('AI Studio Error:')) {
        throw err;
      }
      // 其他错误（如元素不存在）忽略
    }
  };

  // 启动持续错误监控
  const startMonitoring = () => {
    if (errorMonitorInterval) return;
    console.log(`[ErrorMonitor] 启动错误监控，间隔 ${interval}ms`);
    errorMonitorInterval = setInterval(async () => {
      try {
        await check();
      } catch (err) {
        // 错误会在主流程中被捕获
        stopMonitoring();
      }
    }, interval);
  };

  // 停止错误监控
  const stopMonitoring = () => {
    if (errorMonitorInterval) {
      clearInterval(errorMonitorInterval);
      errorMonitorInterval = null;
      console.log('[ErrorMonitor] 已停止错误监控');
    }
  };

  return {
    check,
    startMonitoring,
    stopMonitoring
  };
};

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

const initChatContent = async (page, prompt, modelLabel, auto) => {
  tasks++;
  try {
    await page.goto(AI_STUDIO_HOME_URL);
    await page.waitForLoadState('networkidle', { timeout: 1000 * 60 * 5 });

    // 在输入 prompt 之前先选择模型
    if (modelLabel) {
      console.log('Selecting model before creating chat...');
      await selectModel(page, modelLabel);
    }

    // 先找到输入框，然后输入promot，然后点击Build按钮
    console.log('开始初始化聊天内容...');

    // 创建错误监控器
    const errorMonitor = createErrorMonitor(page);

    const input = page.locator('textarea[aria-label="Enter a prompt to generate an app"], textarea.prompt-textarea, textarea').first();
    await input.waitFor({ state: 'visible', timeout: 30000 });
    await input.fill(prompt);
    await page.waitForTimeout(300);
    console.log('输入框输入完成...');

    // 启动持续错误监控
    console.log('启动错误监控...');
    errorMonitor.startMonitoring();

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
    await errorMonitor.check();
    // 点击后会先跳到 /apps/temp/xxx，然后再跳到 /apps/drive/xxx
    // 优先等待 drive，如果已经跳转就直接继续，避免长时间阻塞
    const currentUrl = page.url();
    if (!/\/apps\/drive\/[^?]+/.test(currentUrl)) {
      // 先等到 temp 或 drive 任意一个出现
      await page.waitForURL(/\/apps\/(temp|drive)\//, { timeout: 1000 * 60 * 60 });
      // 如果还没到 drive，再单独等 drive（短一些）
      if (!/\/apps\/drive\/[^?]+/.test(page.url())) {
        await page.waitForURL(/\/apps\/drive\/[^?]+/, { timeout: 1000 * 60 * 60 });
      }
    }
    console.log('导航到 drive 页面完成...');
    // 停止错误监控
    errorMonitor.stopMonitoring();
    console.log('点击 Build 按钮完成...');

    // 等待运行状态结束（同 sendChatMsg 逻辑）
    const runningIcon = page.locator('button .running-icon');
    console.log('[GoogleStudio] Waiting generation state...');
    try {
      // 最多等 5 秒，看它会不会出现
      await runningIcon.waitFor({ state: 'visible', timeout: 5000 });
      console.log('[GoogleStudio] Generation started');
      // 出现过才等结束
      await runningIcon.waitFor({ state: 'hidden', timeout: 300000 });
      console.log('[GoogleStudio] Generation finished');
    } catch {
      console.log('[GoogleStudio] No running state detected, probably finished instantly');
    }
    console.log('[GoogleStudio] Generation complete. Fetching chat content...');
    await page.waitForTimeout(500); // Stabilization
    const chatDomContent = await getChatDomContent(page, false);
    console.log('chatDomContent', chatDomContent);
    const finalUrl = page.url();
    const driveIdMatch = finalUrl.match(/\/apps\/drive\/([^?]+)/);
    const driveid = driveIdMatch ? driveIdMatch[1] : '';

    return {
      chatDomContent,
      driveid
    };
  } catch (e) {
    // 确保停止错误监控
    console.error('初始化聊天内容失败:', e.message);
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
      const close = () => {
      if (needClose) {
        page.close()
        page = null
      }

    }
  tasks++;
  try {

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

const sendChatMsg = async (page, prompt, needClose, modelLabel) => {
  tasks++;
  const close = () => {
    if (needClose) {
      page.close()
      page = null
    }
  }
  try {
    // sendChatMsg 保持原有逻辑，不切换模型（根据需求）
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

// 选择模型
const selectModel = async (page, modelLabel) => {
  if (!modelLabel) {
    console.log('No model label provided, skipping model selection');
    return;
  }

  console.log(`Checking if current model is: ${modelLabel}`);

  try {
    // 1. 检查当前模型是否已经是目标模型
    const currentModelName = await page.locator('span.model-button-name').first().innerText();
    console.log(`Current model: ${currentModelName}`);

    if (currentModelName.trim() === modelLabel.trim()) {
      console.log('Model already selected, no need to change');
      return;
    }

    console.log(`Need to change model from "${currentModelName}" to "${modelLabel}"`);

    // 2. 点击 model button 打开设置抽屉
    const modelButton = page.locator('button.model-button, button[iconname="settings"].model-button').first();
    await modelButton.waitFor({ state: 'visible', timeout: 10000 });
    await modelButton.click();
    console.log('Clicked model settings button');

    // 3. 等待抽屉打开，找到 model selector
    await page.waitForTimeout(500);
    const modelSelectorField = page.locator('#mat-mdc-dialog-2 mat-dialog-content ms-settings-model-selector mat-form-field, mat-dialog-content ms-settings-model-selector mat-form-field').first();
    await modelSelectorField.waitFor({ state: 'visible', timeout: 10000 });
    console.log('Found model selector field');

    // 4. 点击 mat-form-field 打开下拉菜单
    await modelSelectorField.click();
    await page.waitForTimeout(500);
    console.log('Clicked model selector to open dropdown');

    // 5. 等待 popover 出现并选择目标模型
    const panel = page.locator('#mat-select-0-panel, [role="listbox"]').first();
    await panel.waitFor({ state: 'visible', timeout: 10000 });
    console.log('Dropdown panel opened');

    // 6. 在下拉菜单中找到对应 label 的选项
    const option = page.locator(`mat-option:has-text("${modelLabel}"), [role="option"]:has-text("${modelLabel}")`).first();
    await option.waitFor({ state: 'visible', timeout: 10000 });
    await option.click();
    console.log(`Selected model: ${modelLabel}`);

    // 7. 等待下拉菜单关闭
    await page.waitForTimeout(300);
    await panel.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {
      console.log('Dropdown panel still visible, continuing...');
    });

    // 8. 关闭设置抽屉 - 使用更简单的选择器，因为关闭按钮在抽屉打开时就已存在
    const closeButton = page.locator('mat-dialog-container button, button[mat-dialog-close]').first();
    // 直接点击，不需要长时间等待，因为按钮已经存在
    if (await closeButton.isVisible()) {
      await closeButton.click();
      console.log('Closed settings drawer');
    } else {
      console.log('Close button not visible, trying alternative selector');
      const altCloseButton = page.locator('mat-dialog-container [aria-label="Close"]').first();
      await altCloseButton.click();
      console.log('Closed settings drawer with alternative selector');
    }

    // 9. 等待抽屉关闭
    await page.waitForTimeout(500);
    console.log('Model selection completed');

  } catch (error) {
    console.error('Error selecting model:', error.message);
    // 尝试关闭可能打开的对话框
    try {
      const closeButton = page.locator('button[aria-label="Close"], button.close-button, mat-dialog-container button').first();
      if (await closeButton.isVisible()) {
        await closeButton.click();
      }
    } catch (e) {
      // Ignore error when trying to close
    }
    throw error;
  }
}

/**
 * 流式监控聊天内容变化
 * @param {Page} page - Playwright 页面对象
 * @param {Function} onContentChange - 内容变化回调函数
 * @param {number} interval - 监控间隔（毫秒），默认500ms
 * @returns {Function} 停止监控的函数
 */
const streamChatContent = async (page, onContentChange, interval = 500) => {
  let lastContent = '';
  let isMonitoring = true;
  let monitorInterval;

  const monitor = async () => {
    if (!isMonitoring) return;

    try {
      // 等待 output-container 元素出现
      const container = await page.locator('.output-container').first();
      const isVisible = await container.isVisible().catch(() => false);

      if (!isVisible) {
        return;
      }

      // 获取当前内容
      const content = await page.evaluate(() => {
        const container = document.querySelector('.output-container');
        if (!container) return '';

        const clone = container.cloneNode(true);

        // 移除所有注释节点
        const removeComments = (node) => {
          const children = node.childNodes;
          for (let i = children.length - 1; i >= 0; i--) {
            const child = children[i];
            if (child.nodeType === 8) {
              node.removeChild(child);
            } else if (child.nodeType === 1) {
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

        return clone.innerHTML;
      });

      // 如果内容发生变化，调用回调函数
      if (content && content !== lastContent) {
        lastContent = content;
        onContentChange(content);
      }
    } catch (error) {
      console.error('[StreamMonitor] Error:', error.message);
    }
  };

  // 启动定时监控
  monitorInterval = setInterval(monitor, interval);

  // 立即执行一次
  monitor();

  // 返回停止监控的函数
  return () => {
    isMonitoring = false;
    if (monitorInterval) {
      clearInterval(monitorInterval);
    }
  };
};

/**
 * 发送聊天消息（流式版本）
 * @param {Page} page - Playwright 页面对象
 * @param {string} prompt - 用户输入的 prompt
 * @param {Function} onContentChange - 内容变化回调函数
 * @param {string} modelLabel - 模型标签
 * @returns {Promise<Object>} 返回最终的 driveid 和停止监控的函数
 */
const sendChatMsgStream = async (page, prompt, onContentChange, modelLabel) => {
  tasks++;
  try {
    await page.waitForLoadState('networkidle', { timeout: 1000 * 60 * 5 });
    await page.waitForSelector('.output-container', { state: 'visible', timeout: 1000 * 60 * 5 });

    console.log('[GoogleStudio] Starting stream monitoring...');

    // 启动内容监控
    const stopMonitoring = await streamChatContent(page, onContentChange, 500);

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

    console.log('[GoogleStudio] Prompt sent. Monitoring generation...');

    // 等待生成开始
    try {
      await page.locator('button .running-icon').waitFor({ state: 'visible', timeout: 5000 });
      console.log('[GoogleStudio] Generation running...');
    } catch {
      console.log('[GoogleStudio] Generation might have started quickly');
    }

    // 等待生成完成
    try {
      await page.locator('button .running-icon').waitFor({ state: 'detached', timeout: 300000 });
      console.log('[GoogleStudio] Generation complete.');
    } catch (error) {
      console.log('[GoogleStudio] Generation timeout or error:', error.message);
    }

    // 等待一小段时间确保最后的内容更新
    await page.waitForTimeout(1000);

    tasks--;
    return { stopMonitoring };
  } catch (error) {
    tasks--;
    console.error('[GoogleStudio] Error in sendChatMsgStream:', error.message);
    throw error;
  }
};

/**
 * 初始化聊天内容（流式版本）
 * @param {Page} page - Playwright 页面对象
 * @param {string} prompt - 用户输入的 prompt
 * @param {string} modelLabel - 模型标签
 * @param {Function} onContentChange - 内容变化回调函数
 * @returns {Promise<Object>} 返回 driveid 和停止监控的函数
 */
const initChatContentStream = async (page, prompt, modelLabel, onContentChange) => {
  tasks++;
  try {
    await page.goto(AI_STUDIO_HOME_URL);
    await page.waitForLoadState('networkidle', { timeout: 1000 * 60 * 5 });

    if (modelLabel) {
      console.log('Selecting model before creating chat...');
      await selectModel(page, modelLabel);
    }

    console.log('开始初始化聊天内容（流式）...');

    const errorMonitor = createErrorMonitor(page);

    const input = page.locator('textarea[aria-label="Enter a prompt to generate an app"], textarea.prompt-textarea, textarea').first();
    await input.waitFor({ state: 'visible', timeout: 30000 });
    await input.fill(prompt);
    await page.waitForTimeout(300);
    console.log('输入框输入完成...');

    errorMonitor.startMonitoring();

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
    await errorMonitor.check();

    const currentUrl = page.url();
    if (!/\/apps\/drive\/[^?]+/.test(currentUrl)) {
      await page.waitForURL(/\/apps\/(temp|drive)\//, { timeout: 1000 * 60 * 60 });
      if (!/\/apps\/drive\/[^?]+/.test(page.url())) {
        await page.waitForURL(/\/apps\/drive\/[^?]+/, { timeout: 1000 * 60 * 60 });
      }
    }
    console.log('导航到 drive 页面完成...');
    errorMonitor.stopMonitoring();

    // 启动流式监控
    console.log('[GoogleStudio] Starting stream monitoring...');
    const stopMonitoring = await streamChatContent(page, onContentChange, 500);

    // 等待运行状态结束
    const runningIcon = page.locator('button .running-icon');
    console.log('[GoogleStudio] Waiting generation state...');
    try {
      await runningIcon.waitFor({ state: 'visible', timeout: 5000 });
      console.log('[GoogleStudio] Generation started');
      await runningIcon.waitFor({ state: 'hidden', timeout: 300000 });
      console.log('[GoogleStudio] Generation finished');
    } catch {
      console.log('[GoogleStudio] No running state detected, probably finished instantly');
    }

    console.log('[GoogleStudio] Generation complete.');
    await page.waitForTimeout(500);

    const finalUrl = page.url();
    const driveIdMatch = finalUrl.match(/\/apps\/drive\/([^?]+)/);
    const driveid = driveIdMatch ? driveIdMatch[1] : '';

    tasks--;
    return {
      driveid,
      stopMonitoring
    };
  } catch (error) {
    tasks--;
    console.error('初始化聊天内容失败:', error.message);
    throw error;
  }
};

module.exports = {
  goAistudio: goAistudio,
  initBrowserPage: initBrowserPage,
  downloadCode: downloadCode,
  extraPath: extraPath,
  runInstallBuild: runInstallBuild,
  getChatDomContent: getChatDomContent,
  sendChatMsg: sendChatMsg,
  initChatContent: initChatContent,
  initializeBrowser: initializeBrowser,
  streamChatContent: streamChatContent,
  sendChatMsgStream: sendChatMsgStream,
  initChatContentStream: initChatContentStream
}