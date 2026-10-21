// 智慧树每日学习计时器 - Service Worker
// 职责：持久化每日累计时长、判断达标、广播暂停指令、
//       触发 macOS 快捷指令语音播报、发送浏览器启动提醒

const DEFAULT_LIMIT_MIN = 26; // 用户要求 25 分钟，保守取 26（popup 中可改）
const DEFAULT_SHORTCUT_NAME = '智慧树语音提醒'; // macOS 快捷指令名称（popup 中可改，留空停用语音）
const VOICE_TEXT = '主人，智慧树视频已刷好';
const MAX_SECONDS_PER_DAY = 24 * 3600;

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmt(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m === 0 ? `${s} 秒` : `${m} 分 ${s} 秒`;
}

// SW 可随时被杀死，内存缓存 + storage 持久化双写
let mem = null; // { st: {date, seconds, doneNotified}, limitMin }

async function loadMem() {
  if (mem && mem.st && mem.st.date === todayKey()) return mem;
  const { zsState, zsLimit } = await chrome.storage.local.get(['zsState', 'zsLimit']);
  const limitMin = zsLimit > 0 ? zsLimit : DEFAULT_LIMIT_MIN;
  const today = todayKey();
  const st =
    zsState && zsState.date === today
      ? zsState
      : { date: today, seconds: 0, doneNotified: false };
  mem = { st, limitMin };
  await chrome.storage.local.set({ zsState: st });
  return mem;
}

function persist() {
  if (mem) return chrome.storage.local.set({ zsState: mem.st });
  return Promise.resolve();
}

function isDone(m) {
  return m.st.seconds >= m.limitMin * 60;
}

// 向当前打开的所有智慧树页面（含 iframe 内容脚本）广播最新状态
async function broadcastState() {
  if (!mem) return;
  const tabs = await chrome.tabs.query({ url: '*://*.zhihuishu.com/*' });
  for (const t of tabs) {
    chrome.tabs
      .sendMessage(t.id, {
        type: 'STATE',
        seconds: mem.st.seconds,
        limitMin: mem.limitMin,
        done: isDone(mem)
      })
      .catch(() => {});
  }
}

function notify(message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: '智慧树学习计时器',
    message
  });
}

// 弹题出现 → 系统通知（15 秒节流，点击通知跳回做题页面）
let lastQuizNotifyAt = 0;
let quizTabId = null;
let quizNotifyId = null; // 当前弹题通知的 ID（每次动态生成，确保横幅弹出）

function notifyQuiz(tabId) {
  quizTabId = tabId;
  const now = Date.now();
  console.log('[zs-timer] notifyQuiz 被调用, tabId=', tabId, '距上次通知(ms)=', now - lastQuizNotifyAt);
  if (now - lastQuizNotifyAt < 15000) {
    console.log('[zs-timer] 15秒节流，跳过');
    return;
  }
  lastQuizNotifyAt = now;
  chrome.storage.local.get('zsQuizNotify').then(({ zsQuizNotify }) => {
    console.log('[zs-timer] zsQuizNotify 开关值:', zsQuizNotify);
    if (zsQuizNotify === false) {
      console.log('[zs-timer] 开关已关闭，不通知');
      return;
    }
    // 先清除上一条通知，再创建新的（不指定 ID，让浏览器自动生成，确保横幅弹出）
    if (quizNotifyId) {
      chrome.notifications.clear(quizNotifyId).catch(() => {});
    }
    console.log('[zs-timer] 创建系统通知');
    chrome.notifications.create(
      {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: '智慧树：出现题目',
        message: '视频里弹出了题目，快去做题！'
      },
      (id) => {
        quizNotifyId = id;
        console.log('[zs-timer] 通知已创建, id=', id);
      }
    );
  });
}

let lastVideoEndedNotifyAt = 0;
function notifyVideoEnded() {
  const now = Date.now();
  if (now - lastVideoEndedNotifyAt < 10000) return; // 10秒节流
  lastVideoEndedNotifyAt = now;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: '智慧树：视频播放结束',
    message: '当前视频已播完，未达今日目标，请手动跳转下一节继续学习'
  });
}

// 弹题关闭后 10 秒未恢复播放 → 提醒点播放
const focusableNotify = new Map(); // 通知 id → tabId，点击通知时聚焦学习页面
let lastPlayRemindAt = 0;
function notifyPlayReminder(tabId) {
  const now = Date.now();
  if (now - lastPlayRemindAt < 20000) return; // 20秒节流
  lastPlayRemindAt = now;
  chrome.notifications.create(
    {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: '智慧树：记得点播放',
      message: '题目已关闭 10 秒了，视频还没继续播放，点我回去点播放'
    },
    (id) => {
      if (id && tabId != null) focusableNotify.set(id, tabId);
    }
  );
}

chrome.notifications.onClicked.addListener((id) => {
  if (focusableNotify.has(id)) {
    const tabId = focusableNotify.get(id);
    focusableNotify.delete(id);
    chrome.tabs.update(tabId, { active: true }).catch(() => {});
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t && t.windowId != null) {
          chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
        }
      })
      .catch(() => {});
    return;
  }
  if (id !== quizNotifyId || quizTabId == null) return;
  chrome.tabs.update(quizTabId, { active: true }).catch(() => {});
  chrome.tabs
    .get(quizTabId)
    .then((t) => {
      if (t && t.windowId != null) {
        chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
      }
    })
    .catch(() => {});
});

// 通过 macOS 快捷指令 URL Scheme 触发语音播报（朗读文本动作，可选 Siri 音色）
// 仅 macOS 支持；其他平台直接返回 false，不创建任何标签页
async function triggerShortcut(text) {
  const { os } = await chrome.runtime.getPlatformInfo();
  if (os !== 'mac') return false;
  const { zsShortcutName } = await chrome.storage.local.get('zsShortcutName');
  const name =
    typeof zsShortcutName === 'string' ? zsShortcutName.trim() : DEFAULT_SHORTCUT_NAME;
  if (!name) return false; // 名称留空 = 停用语音提醒
  const url =
    'shortcuts://run-shortcut?name=' +
    encodeURIComponent(name) +
    '&input=text&text=' +
    encodeURIComponent(text);

  // 优先借道已打开的智慧树页面发起跳转：网页来源的确认框带"始终允许"复选框，
  // 勾选一次后永久免确认；而扩展自身来源（chrome-extension://）每次必弹且无法记住。
  const tabs = await chrome.tabs.query({ url: '*://*.zhihuishu.com/*' });
  if (tabs && tabs.length > 0) {
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, { type: 'RUN_SHORTCUT', url }).catch(() => {});
    }
    return true;
  }

  // 没有打开的智慧树页面时兜底：新建临时标签页唤起，15 秒后自动关闭
  chrome.tabs.create({ url, active: false }, (tab) => {
    // 该标签页只用于唤起快捷指令，15 秒后自动关闭
    if (tab && tab.id != null) {
      const tabId = tab.id;
      setTimeout(() => {
        chrome.tabs.remove(tabId).catch(() => {});
      }, 15000);
    }
  });
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const m = await loadMem();

    if (msg.type === 'TICK') {
      // 内容脚本每累计 5 秒上报一次（仅在视频播放中才上报）
      m.st.seconds = Math.min(MAX_SECONDS_PER_DAY, m.st.seconds + msg.seconds);
      const done = isDone(m);
      if (done && !m.st.doneNotified) {
        m.st.doneNotified = true;
        notify(
          `今日学习已满 ${m.limitMin} 分钟（共 ${fmt(m.st.seconds)}），视频已自动暂停，去休息吧！`
        );
        // 每天首次达标时触发快捷指令语音播报
        triggerShortcut(VOICE_TEXT);
      }
      await persist();
      // 立即命令该页面所有 frame 暂停视频并锁定
      if (done && sender.tab) {
        chrome.tabs
          .sendMessage(sender.tab.id, {
            type: 'STOP',
            seconds: m.st.seconds,
            limitMin: m.limitMin
          })
          .catch(() => {});
      }
      sendResponse({ seconds: m.st.seconds, limitMin: m.limitMin, done });
    } else if (msg.type === 'GET_STATE') {
      sendResponse({ seconds: m.st.seconds, limitMin: m.limitMin, done: isDone(m) });
    } else if (msg.type === 'SET_LIMIT') {
      const v = Math.max(1, Math.min(600, Math.round(Number(msg.limitMin) || DEFAULT_LIMIT_MIN)));
      m.limitMin = v;
      await chrome.storage.local.set({ zsLimit: v });
      await broadcastState();
      sendResponse({ ok: true, limitMin: v });
    } else if (msg.type === 'RESET') {
      m.st = { date: todayKey(), seconds: 0, doneNotified: false };
      await persist();
      await broadcastState();
      sendResponse({ ok: true });
    } else if (msg.type === 'GET_SETTINGS') {
      const { zsShortcutName, zsQuizNotify } = await chrome.storage.local.get([
        'zsShortcutName',
        'zsQuizNotify'
      ]);
      sendResponse({
        limitMin: m.limitMin,
        shortcutName:
          typeof zsShortcutName === 'string' ? zsShortcutName : DEFAULT_SHORTCUT_NAME,
        quizNotify: zsQuizNotify !== false
      });
    } else if (msg.type === 'SET_QUIZ_NOTIFY') {
      await chrome.storage.local.set({ zsQuizNotify: !!msg.enabled });
      sendResponse({ ok: true });
    } else if (msg.type === 'SET_SHORTCUT') {
      const name = String(msg.name || '').trim();
      await chrome.storage.local.set({ zsShortcutName: name });
      sendResponse({ ok: true, shortcutName: name });
    } else if (msg.type === 'TEST_VOICE') {
      const ok = await triggerShortcut(VOICE_TEXT);
      sendResponse({ ok });
    } else if (msg.type === 'QUIZ_DETECTED') {
      notifyQuiz(sender.tab ? sender.tab.id : null);
      sendResponse({ ok: true });
    } else if (msg.type === 'VIDEO_ENDED') {
      notifyVideoEnded();
      sendResponse({ ok: true });
    } else if (msg.type === 'PLAY_REMINDER') {
      notifyPlayReminder(sender.tab ? sender.tab.id : null);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false });
    }
  })();
  return true; // 异步响应
});

// 每天首次启动浏览器：未达标则提醒学习
chrome.runtime.onStartup.addListener(async () => {
  const m = await loadMem();
  const remain = m.limitMin * 60 - m.st.seconds;
  if (remain > 0) {
    notify(
      `今日已学 ${fmt(m.st.seconds)}，距离 ${m.limitMin} 分钟目标还差 ${fmt(remain)}，记得打开智慧树学习哦～`
    );
  } else {
    notify(`今日学习目标（${m.limitMin} 分钟）已达成，继续保持！`);
  }
});

// 安装/更新时也提示一次，方便确认扩展生效
chrome.runtime.onInstalled.addListener(async () => {
  const m = await loadMem();
  const remain = m.limitMin * 60 - m.st.seconds;
  if (remain > 0) {
    notify(
      `扩展安装成功。今日已学 ${fmt(m.st.seconds)}，还差 ${fmt(remain)} 到 ${m.limitMin} 分钟目标。`
    );
  }
});
