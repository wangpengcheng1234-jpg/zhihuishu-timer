const bigEl = document.getElementById('big');
const fillEl = document.getElementById('fill');
const subEl = document.getElementById('sub');
const limitInput = document.getElementById('limit');
const shortcutInput = document.getElementById('shortcut');
const quizNotifyInput = document.getElementById('quizNotify');
const resetBtn = document.getElementById('reset');
const testVoiceBtn = document.getElementById('testVoice');

function fmt(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m === 0 ? `${s} 秒` : `${m} 分 ${s} 秒`;
}

async function refresh() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    bigEl.textContent = fmt(res.seconds);
    const target = res.limitMin * 60;
    fillEl.style.width = Math.min(100, (res.seconds / target) * 100) + '%';
    const remain = Math.max(0, target - res.seconds);
    subEl.textContent = res.done
      ? `已完成今日 ${res.limitMin} 分钟目标，明天见`
      : `距离 ${res.limitMin} 分钟目标还差 ${fmt(remain)}`;
    if (document.activeElement !== limitInput) limitInput.value = res.limitMin;
  } catch (e) {
    bigEl.textContent = '--';
    subEl.textContent = '后台休眠中，请稍候…';
  }
}

async function loadSettings() {
  try {
    const s = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (document.activeElement !== shortcutInput) shortcutInput.value = s.shortcutName;
    quizNotifyInput.checked = s.quizNotify !== false;
  } catch (e) {
    /* 后台暂不可用 */
  }
}

// 语音播报依赖 macOS 快捷指令，其他平台禁用相关入口
async function applyPlatformHints() {
  try {
    const { os } = await chrome.runtime.getPlatformInfo();
    if (os !== 'mac') {
      shortcutInput.disabled = true;
      shortcutInput.placeholder = '仅 macOS 支持';
      testVoiceBtn.disabled = true;
      testVoiceBtn.textContent = '语音提醒仅 macOS 支持';
    }
  } catch (e) {}
}

limitInput.addEventListener('change', async () => {
  const v = parseInt(limitInput.value, 10);
  if (!isNaN(v)) {
    await chrome.runtime.sendMessage({ type: 'SET_LIMIT', limitMin: v });
  }
  refresh();
});

shortcutInput.addEventListener('change', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'SET_SHORTCUT', name: shortcutInput.value });
  } catch (e) {}
});

quizNotifyInput.addEventListener('change', async () => {
  try {
    await chrome.runtime.sendMessage({
      type: 'SET_QUIZ_NOTIFY',
      enabled: quizNotifyInput.checked
    });
  } catch (e) {}
});

resetBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'RESET' });
  refresh();
});

testVoiceBtn.addEventListener('click', async () => {
  testVoiceBtn.textContent = '已触发，注意听…';
  try {
    await chrome.runtime.sendMessage({ type: 'TEST_VOICE' });
  } catch (e) {}
  setTimeout(() => (testVoiceBtn.textContent = '测试语音提醒'), 2500);
});

refresh();
loadSettings();
applyPlatformHints();
setInterval(refresh, 1000);
