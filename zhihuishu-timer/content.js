// 智慧树每日学习计时器 - Content Script
// 注入所有 zhihuishu.com frame（视频在 iframe 内），负责：
//  1. 检测 <video> 是否正在播放，真实时间每秒累计 1s，每 5s 上报后台
//  2. 达标后：暂停所有视频 + 拦截再次播放 + 页面遮罩提示
//  3. 页面加载时若已完成目标，直接锁定
//  4. 视频播放结束且未达标时自动跳转下一节
//
// 反检测策略：完全在 content script 隔离世界运行，不向页面注入任何 <script>，
// 不修改页面原生函数（setInterval/setTimeout/toString 等），页面脚本无法探测到我们的存在。

(() => {
  // Chrome 扩展保证同一 frame 不会重复注入同一 content script

  const OVERLAY_ID = 'zs-timer-overlay';
  const TOAST_ID = 'zs-timer-toast';
  const REPORT_EVERY = 5; // 每 5 秒上报一次

  let total = 0; // 今日已学秒数（后台返回值）
  let limitMin = 26;
  let done = false;
  let buf = 0; // 本地待上报秒数
  const videos = new Set();

  function fmt(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m === 0 ? `${s} 秒` : `${m} 分 ${s} 秒`;
  }

  function anyPlaying() {
    for (const v of videos) {
      if (v && !v.paused && !v.ended) return true;
    }
    return false;
  }

  function pauseAll() {
    for (const v of videos) {
      try {
        v.pause();
      } catch (e) {}
    }
  }

  function lock() {
    done = true;
    pauseAll();
    showOverlay();
  }

  function unlock() {
    done = false;
    hideOverlay();
  }

  // 持续扫描页面中的 video（播放器可能动态创建）
  function watchVideos() {
    const scan = () => {
      document.querySelectorAll('video').forEach((v) => {
        if (!videos.has(v)) {
          videos.add(v);
          // 达标后禁止再次播放
          v.addEventListener('play', () => {
            if (done) v.pause();
          });
          // 视频播放结束 → 未达标则通知用户手动跳转
          v.addEventListener('ended', () => {
            if (!done) {
              chrome.runtime.sendMessage({ type: 'VIDEO_ENDED' }).catch(() => {});
            }
          });
        }
      });
    };
    scan();
    new MutationObserver(scan).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  // 每秒计时：只要视频在播放（含后台标签页）就计入今日时长
  async function tick() {
    if (done) return;
    if (!anyPlaying()) return;
    buf += 1;
    if (buf < REPORT_EVERY) {
      checkLocal();
      return;
    }
    const chunk = buf;
    buf = 0;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'TICK', seconds: chunk });
      if (res) {
        total = res.seconds;
        limitMin = res.limitMin;
        if (res.done) lock();
      }
    } catch (e) {
      // 扩展后台暂不可用（如正在重载），保留待上报数据稍后重试
      buf += chunk;
    }
  }

  function checkLocal() {
    if (total >= limitMin * 60) lock();
  }

  // ---------- 弹题检测 ----------
  // 智慧树视频弹题出现时通知后台发系统通知；弹题关闭后重新待命

  let quizVisible = false;

  function isVisible(el) {
    return !!(el && el.offsetWidth > 0 && el.offsetHeight > 0);
  }

  function findQuizEl() {
    // 智慧树弹题容器的常见类名（含历史版本）
    // 新版"AI助教小智"弹题使用 Element UI 的 .el-dialog，aria-label="弹题测验"
    const known = document.querySelector(
      '.exam-popper-wrapper, [class*="exam-popper"], .examBox, .exam-box, .dialog21, .el-dialog[aria-label*="弹题"], [role="dialog"][aria-label*="弹题"]'
    );
    if (isVisible(known)) return known;
    return findGenericQuiz();
  }

  // 兜底：可见的浮层（fixed/absolute）内含 ≥2 个单选/多选框
  function findGenericQuiz() {
    const first = document.querySelector('input[type="radio"], input[type="checkbox"]');
    if (!first) return null;
    let anc = first.parentElement;
    while (anc && anc !== document.body) {
      const inputs = anc.querySelectorAll('input[type="radio"], input[type="checkbox"]').length;
      if (inputs >= 2) {
        const pos = getComputedStyle(anc).position;
        if ((pos === 'fixed' || pos === 'absolute') && isVisible(anc)) return anc;
      }
      anc = anc.parentElement;
    }
    return null;
  }

  let resumeReminderTimer = null;

  function checkQuiz() {
    const present = !!findQuizEl();
    if (present && !quizVisible) {
      quizVisible = true;
      // 弹题再次出现，取消"记得点播放"提醒
      if (resumeReminderTimer) {
        clearTimeout(resumeReminderTimer);
        resumeReminderTimer = null;
      }
      console.log('[zs-timer] 弹题已检测到，发送 QUIZ_DETECTED');
      try {
        chrome.runtime.sendMessage({ type: 'QUIZ_DETECTED' });
      } catch (e) {
        console.log('[zs-timer] 发送失败:', e);
      }
    } else if (!present && quizVisible) {
      quizVisible = false; // 弹题已关闭，下次出现再次提醒
      // 弹题关闭后 10 秒仍未恢复播放 → 通知提醒点播放
      if (resumeReminderTimer) clearTimeout(resumeReminderTimer);
      resumeReminderTimer = setTimeout(() => {
        resumeReminderTimer = null;
        if (!done && !anyPlaying() && !findQuizEl()) {
          console.log('[zs-timer] 弹题关闭 10 秒未播放，发送提醒');
          try {
            chrome.runtime.sendMessage({ type: 'PLAY_REMINDER' });
          } catch (e) {}
        }
      }, 10000);
    }
  }

  // ---------- UI ----------

  function showOverlay() {
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = OVERLAY_ID;
      el.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'background:rgba(15,23,42,0.82)',
        'color:#fff',
        'display:flex',
        'flex-direction:column',
        'align-items:center',
        'justify-content:center',
        'font-size:22px',
        'line-height:1.8',
        'text-align:center',
        'padding:24px',
        'font-family:system-ui,sans-serif'
      ].join(';');
      document.documentElement.appendChild(el);
    }
    el.textContent = `今日学习已满 ${limitMin} 分钟，视频已自动暂停，去休息吧！`;
  }

  function hideOverlay() {
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.remove();
  }

  // 页面加载时的轻量提醒（仅顶层页面，5 秒后消失）
  function showToast(text) {
    if (window.top !== window) return;
    if (document.getElementById(TOAST_ID)) return;
    const el = document.createElement('div');
    el.id = TOAST_ID;
    el.textContent = text;
    el.style.cssText = [
      'position:fixed',
      'top:16px',
      'left:16px',
      'z-index:2147483647',
      'background:rgba(15,23,42,0.92)',
      'color:#fff',
      'padding:12px 18px',
      'border-radius:10px',
      'font-size:14px',
      'box-shadow:0 6px 24px rgba(0,0,0,.25)',
      'transition:opacity .5s',
      'font-family:system-ui,sans-serif'
    ].join(';');
    document.documentElement.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 600);
    }, 5000);
  }

  // ---------- 消息 ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'STOP') {
      total = msg.seconds;
      limitMin = msg.limitMin;
      lock();
    } else if (msg.type === 'STATE') {
      total = msg.seconds;
      limitMin = msg.limitMin;
      if (msg.done && !done) lock();
      else if (!msg.done && done) unlock();
    } else if (msg.type === 'RUN_SHORTCUT') {
      // 由页面（而非扩展）发起 shortcuts:// 跳转，确认框才会带"始终允许"复选框
      if (window.top === window) {
        try {
          window.location.href = msg.url;
        } catch (e) {}
      }
    }
    sendResponse && sendResponse({ ok: true });
  });

  // ---------- 启动 ----------

  async function init() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      if (res) {
        total = res.seconds;
        limitMin = res.limitMin;
        done = res.done;
      }
    } catch (e) {
      // 扩展上下文失效（正在重载），忽略
    }
    if (done) {
      pauseAll();
      showOverlay();
    } else if (window.top === window) {
      const remain = limitMin * 60 - total;
      showToast(
        remain > 0
          ? `今日已学 ${fmt(total)}，距离 ${limitMin} 分钟目标还差 ${fmt(remain)}`
          : `今日 ${limitMin} 分钟目标已达成`
      );
    }
    watchVideos();
    setInterval(tick, 1000);
    setInterval(checkQuiz, 1000);
  }

  init();
})();
