const path = require('path');
const isWindows = process.platform === 'win32';
console.log(process.platform);
  const AI_STUDIO_HOME_URL = 'https://aistudio.google.com/apps';
 const AI_STUDIO_URL = 'https://aistudio.google.com/apps/drive/{driveid}?showAssistant=true&showCode=true';
 const USER_DATA_DIR = path.resolve('./chrome-profile');
// export const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
 const  CHROME_PATH = isWindows ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const PREVIEW_URL = 'http://localhost:1234';
module.exports = {
    AI_STUDIO_URL,
    USER_DATA_DIR,
    CHROME_PATH,
    PREVIEW_URL,
    AI_STUDIO_HOME_URL,
}