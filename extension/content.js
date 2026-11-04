/**
 * 内容脚本：与注入的识别模块通信，把「手势」翻译成页面动作。
 * 关键点是「自适应驱动 + 成功后自校验」——抖音的滚动容器类名是混淆的，
 * 不能写死选择器，只能按结构找，并且每次执行后验证是否真的动了。
 */
(function () {
  if (window.__DY_GESTURE_CTRL__) return;
  window.__DY_GESTURE_CTRL__ = true;

  var LS_KEY = 'dyGestureEnabled';
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // ---------- 状态胶囊 ----------
  var pill, dot, label;
  function buildPill() {
    if (pill) return;
    pill = document.createElement('div');
    pill.id = 'dy-gesture-pill';
    pill.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:88px', 'z-index:2147483000',
      'display:flex', 'align-items:center', 'gap:8px',
      'padding:7px 12px', 'border-radius:99px',
      'background:rgba(12,14,18,.82)', 'color:#c8cfda',
      'border:1px solid rgba(255,255,255,.14)',
      'font:12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'backdrop-filter:blur(10px)', 'pointer-events:none',
      'box-shadow:0 6px 20px rgba(0,0,0,.35)', 'transition:opacity .2s'
    ].join(';');
    dot = document.createElement('span');
    dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#5b6373;flex:none;';
    label = document.createElement('span');
    label.textContent = '手势 关';
    pill.appendChild(dot);
    pill.appendChild(label);
    document.documentElement.appendChild(pill);
  }

  function setPill(on, text, warn) {
    buildPill();
    dot.style.background = warn ? '#ffb84d' : (on ? '#25f4ee' : '#5b6373');
    dot.style.boxShadow = (on && !warn) ? '0 0 8px rgba(37,244,238,.8)' : 'none';
    label.textContent = text;
    label.style.color = warn ? '#ffb84d' : (on ? '#25f4ee' : '#c8cfda');
  }

  var flashTimer = null;
  function flash(text, warn) {
    setPill(true, text, warn);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { setPill(enabled, enabled ? '手势 开' : '手势 关'); }, 2400);
  }

  // ---------- 找目标元素 ----------
  function pickVideo(preferPlaying) {
    var vids = Array.prototype.slice.call(document.querySelectorAll('video'));
    var best = null, bestScore = -1;
    vids.forEach(function (v) {
      var r = v.getBoundingClientRect();
      var vis = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) *
                Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      var score = vis + (preferPlaying && !v.paused ? 1e7 : 0);
      if (score > bestScore) { bestScore = score; best = v; }
    });
    return best;
  }

  // 找真正在滚的容器。抖音的类名是混淆的，不能写死选择器，分三级降级：
  // ① 视频的滚动祖先 ② 全局包含 video 且溢出最多的容器 ③ 文档滚动容器
  function scrollParent(el) {
    var node = el ? el.parentElement : null;
    while (node && node !== document.body && node !== document.documentElement) {
      var cs = getComputedStyle(node);
      if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight - node.clientHeight > 60) return node;
      node = node.parentElement;
    }

    var best = null, bestScore = 0;
    var all = document.querySelectorAll('div,main,section');
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      var over = n.scrollHeight - n.clientHeight;
      if (over < 60 || n.clientHeight < 200) continue;
      if (!/(auto|scroll)/.test(getComputedStyle(n).overflowY)) continue;
      var score = over + (n.querySelector('video') ? 10000 : 0);
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best || document.scrollingElement || document.documentElement;
  }

  // ---------- 动作 ----------
  // 抖音播放页有两层 video：主视频和背景虚化视频，位置几乎重合。
  // 只按"视口中心"挑会挑到虚化那层——表现就是"倍速/暂停按了没反应"。
  // 改成打分：优先在播、优先有声、再看可见面积。
  // 按「在播 > 有声 > 可见面积」排序，倍速时可以逐个试
  function rankVideos() {
    var arr = [];
    Array.prototype.slice.call(document.querySelectorAll('video')).forEach(function (v) {
      var r = v.getBoundingClientRect();
      if (r.height < 100 || r.width < 100) return;
      var vis = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) *
                Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      var score = vis;
      if (!v.paused) score += 1e7;
      if (!v.muted) score += 5e6;
      arr.push({ v: v, score: score });
    });
    arr.sort(function (a, b) { return b.score - a.score; });
    return arr.map(function (o) { return o.v; });
  }

  function currentVideo() {
    var best = null, bestScore = -1;
    Array.prototype.slice.call(document.querySelectorAll('video')).forEach(function (v) {
      var r = v.getBoundingClientRect();
      if (r.height < 100 || r.width < 100) return;
      var vis = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) *
                Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      var score = vis;
      if (!v.paused) score += 1e7;
      if (!v.muted) score += 5e6;
      if (score > bestScore) { bestScore = score; best = v; }
    });
    return best;
  }
  function srcOf(v) { return v ? (v.currentSrc || v.src || '') : ''; }

  // 抖音推荐流不用原生滚动（scrollTop 恒为 0，scrollBy 无效），
  // 实际靠 wheel 事件驱动。实测：合成的 WheelEvent 就能生效，不需要可信事件。
  async function step(dir) {
    var before = srcOf(currentVideo());
    var cx = Math.round(innerWidth / 2), cy = Math.round(innerHeight / 2);
    var target = document.elementFromPoint(cx, cy) || document.body;
    var dy = dir * Math.round(innerHeight * 0.9);

    function wheel(amount) {
      var e = new WheelEvent('wheel', {
        deltaY: amount, deltaX: 0, deltaMode: 0,
        bubbles: true, cancelable: true, clientX: cx, clientY: cy
      });
      target.dispatchEvent(e);
    }

    wheel(dy);
    await sleep(900);
    if (srcOf(currentVideo()) !== before) return 'wheel';

    // 一次不够就分三次小步推，避免抖音的自定义滚动把手势当成"抖动"忽略
    for (var i = 0; i < 3; i++) { wheel(dy / 3); await sleep(160); }
    await sleep(700);
    if (srcOf(currentVideo()) !== before) return 'wheel';

    // 回退：原生滚动（老版本页面可能走这条）
    var v = currentVideo();
    var sc = scrollParent(v);
    var top0 = sc.scrollTop;
    sc.scrollBy({ top: dir * (sc.clientHeight || innerHeight), behavior: 'smooth' });
    await sleep(600);
    if (Math.abs(sc.scrollTop - top0) > 8) return 'scroll';

    return 'failed';
  }

  async function cycleSpeed() {
    var cands = rankVideos();
    if (!cands.length) { var one = pickVideo(true) || pickVideo(false); if (one) cands = [one]; }
    if (!cands.length) return '没有视频';

    // 逐条尝试：播放页会同时存在主视频和背景虚化视频，
    // 只有真的把速率改成功的那一条才算数
    for (var i = 0; i < Math.min(cands.length, 3); i++) {
      var v = cands[i];
      var next = v.playbackRate < 1.5 ? 2 : (v.playbackRate < 3 ? 4 : 1);
      try {
        v.defaultPlaybackRate = next;
        v.playbackRate = next;
      } catch (e) { continue; }
      await sleep(180);
      if (Math.abs(v.playbackRate - next) < 0.01) {
        // 再守 600ms，防止播放器稍后改回
        await sleep(600);
        if (Math.abs(v.playbackRate - next) < 0.01) return next + ' 倍速';
        v.playbackRate = next;
        await sleep(250);
        if (Math.abs(v.playbackRate - next) < 0.01) return next + ' 倍速';
      }
    }
    return '倍速被页面改回';
  }

  // ---------- 暂停 / 继续 ----------
  // 抖音有两类作品：普通视频（有可见 <video>）、图文作品（图片轮播，
  // 只有 1x1 的隐藏 video 在放 BGM）。原来只找可见 video，
  // 遇到图文作品直接返回「没有视频」——这就是「图片视频暂停不了」的原因。
  //
  // 现在三级降级：控 video 元素 → 发空格 → 点播放器上的按钮。
  function anyMedia() {
    var best = null, bestScore = -1;
    Array.prototype.slice.call(document.querySelectorAll('video,audio')).forEach(function (v) {
      var r = v.getBoundingClientRect();
      var score = Math.max(0, r.width) * Math.max(0, r.height);
      if (!v.paused) score += 1e7;
      if (!v.muted) score += 5e6;
      if (score > bestScore) { bestScore = score; best = v; }
    });
    return best;
  }

  function keyEvent(type, key, code, keyCode) {
    var e = new KeyboardEvent(type, {
      key: key, code: code, bubbles: true, cancelable: true, view: window
    });
    // 部分播放器只看 keyCode，用 defineProperty 补上（构造函数不接受这两个字段）
    try {
      Object.defineProperty(e, 'keyCode', { get: function () { return keyCode; } });
      Object.defineProperty(e, 'which', { get: function () { return keyCode; } });
    } catch (err) {}
    return e;
  }

  function pressSpace() {
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return false;
    var target = document.body || document.documentElement || document;
    target.dispatchEvent(keyEvent('keydown', ' ', 'Space', 32));
    setTimeout(function () {
      target.dispatchEvent(keyEvent('keyup', ' ', 'Space', 32));
    }, 60);
    return true;
  }

  // 找播放器上的播放/暂停控件，按语义匹配，不依赖混淆类名
  function tapToggleButton() {
    var nodes = document.querySelectorAll('[aria-label],[title],[data-e2e]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var tag = (el.getAttribute('aria-label') || '') + ' ' +
                (el.getAttribute('title') || '') + ' ' +
                (el.getAttribute('data-e2e') || '');
      if (!/暂停|播放|pause|play/i.test(tag)) continue;
      if (/player|playlist|playback/i.test(tag)) continue;
      var r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight) {
        try { el.click(); return true; } catch (e) {}
      }
    }
    return false;
  }

  async function togglePause() {
    var v = currentVideo() || anyMedia();
    var wantPause = v ? !v.paused : true;

    // ① 直接控制媒体元素：最可靠
    if (v) {
      try {
        if (wantPause) v.pause();
        else await v.play();
      } catch (e) {}
      await sleep(220);
      if (v.paused === wantPause) return wantPause ? '已暂停' : '继续播放';
    }

    // ② 空格键：图文作品、或播放器把 pause 顶回来时走这条
    pressSpace();
    await sleep(380);
    if (v && v.paused === wantPause) return wantPause ? '已暂停' : '继续播放';

    // ③ 点播放器控件
    if (tapToggleButton()) {
      await sleep(320);
      return wantPause ? '已暂停' : '继续播放';
    }

    // 没有可读的 paused 状态时无法验证，如实告知而不是假装成功
    return v ? '播放器未响应' : '已发送暂停指令';
  }

  async function run(act) {
    if (act === 'next' || act === 'prev') {
      var how = await step(act === 'next' ? 1 : -1);
      var ok = how !== 'failed';
      var inFeed = location.href.indexOf('recommend') >= 0;
      flash(ok ? (act === 'next' ? '下一个' : '上一个')
             : (inFeed ? '切换失败' : '切换失败 · 请进推荐流'), !ok);
      return;
    }
    if (act === 'speed') { flash(await cycleSpeed()); return; }
    if (act === 'pause') { flash(await togglePause()); return; }
  }

  // ---------- 开关 ----------
  var enabled = false;
  var swap12 = false;   // true 时：比 1 = 上一个，比 2 = 下一个

  // 手势 → 动作。方向抽成配置，万一判反了不用改代码，弹窗里拨一下就行
  function actOf(pose) {
    if (pose === 1) return swap12 ? 'next' : 'prev';   // 默认：比 1 = 上一个
    if (pose === 2) return swap12 ? 'prev' : 'next';   // 默认：比 2 = 下一个
    if (pose === 3) return 'speed';
    if (pose === 4) return 'pause';
    return '';
  }

  function send(cmd) { window.postMessage({ source: 'dy-ctrl', cmd: cmd }, '*'); }

  function setEnabled(v) {
    enabled = v;
    try { chrome.storage.local.set({ dyGestureEnabled: v }); } catch (e) {}
    setPill(v, v ? '手势 开' : '手势 关');
    send(v ? 'start' : 'stop');
  }

  // ---------- 消息 ----------
  var lastMsgT = Date.now();

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== 'dy-gesture') return;
    lastMsgT = Date.now();

    if (d.type === 'ready') {
      try {
        chrome.storage.local.get([LS_KEY, 'dyGestureSwap12'], function (r) {
          enabled = !!r[LS_KEY];
          swap12 = !!r.dyGestureSwap12;
          setPill(enabled, enabled ? '手势 开' : '手势 关');
          if (enabled) send('start');
        });
      } catch (e) {
        setPill(false, '手势 关');
      }
      return;
    }
    if (d.type === 'status') { flash(d.text, !/待命|已检测|识别到/.test(d.text)); return; }
    if (d.type === 'state') {
      enabled = !!d.on;
      if (!enabled) setPill(false, '手势 关');
      return;
    }
    if (d.type === 'gesture') {
      var act = actOf(d.pose);
      if (act) run(act);
      return;
    }
  });

  // 页内快捷键：Alt + G（Alt+Shift+G 同样可用）
  // 为什么不只留 Alt+Shift：Windows 默认把 Alt+Shift 当输入法切换热键，
  // 系统先吃掉之后页面根本收不到 keydown，实测按了没反应。
  document.addEventListener('keydown', function (e) {
    if (e.altKey && (e.key === 'G' || e.key === 'g')) {
      e.preventDefault();
      setEnabled(!enabled);
    }
  });

  // 供扩展弹窗控制
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg) return;
      if (msg.cmd === 'set') { setEnabled(!!msg.value); sendResponse({ enabled: enabled }); }
      if (msg.cmd === 'get') { sendResponse({ enabled: enabled, swap12: swap12 }); }
      if (msg.cmd === 'setSwap') { swap12 = !!msg.value; sendResponse({ swap12: swap12 }); }
      return true;
    });
  } catch (e) {}

  // 心跳兜底：注入模块万一完全静默（模型崩溃、循环中断），
  // 这里主动让它自检一次，用户不用手动关开开关
  setInterval(function () {
    if (!enabled || document.hidden) return;
    if (Date.now() - lastMsgT > 12000) {
      lastMsgT = Date.now();
      send('ensure');
    }
  }, 4000);

  buildPill();
})();
