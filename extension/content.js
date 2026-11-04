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
  function currentVideo() {
    var vids = Array.prototype.slice.call(document.querySelectorAll('video'))
      .filter(function (v) { return v.getBoundingClientRect().height > 100; });
    var mid = innerHeight / 2, best = null, bestD = 1e9;
    vids.forEach(function (v) {
      var r = v.getBoundingClientRect();
      var d = Math.abs((r.top + r.bottom) / 2 - mid);
      if (d < bestD) { bestD = d; best = v; }
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

  function cycleSpeed() {
    var v = currentVideo() || pickVideo(true) || pickVideo(false);
    if (!v) return '没有视频';
    var cur = v.playbackRate;
    var next = cur < 1.5 ? 2 : (cur < 3 ? 4 : 1);
    v.playbackRate = next;
    return next + ' 倍速';
  }

  function togglePause() {
    var v = currentVideo() || pickVideo(true) || pickVideo(false);
    if (!v) return '没有视频';
    if (v.paused) { v.play().catch(function () {}); return '继续播放'; }
    v.pause();
    return '已暂停';
  }

  async function run(act) {
    if (act === 'next' || act === 'prev') {
      var how = await step(act === 'next' ? 1 : -1);
      var ok = how !== 'failed';
      flash(ok ? (act === 'next' ? '下一个' : '上一个') : '切换失败', !ok);
      return;
    }
    if (act === 'speed') { flash(cycleSpeed()); return; }
    if (act === 'pause') { flash(togglePause()); return; }
  }

  // ---------- 开关 ----------
  var enabled = false;
  var swap12 = false;   // true 时：比 1 = 上一个，比 2 = 下一个

  // 手势 → 动作。方向抽成配置，万一判反了不用改代码，弹窗里拨一下就行
  function actOf(pose) {
    if (pose === 1) return swap12 ? 'prev' : 'next';
    if (pose === 2) return swap12 ? 'next' : 'prev';
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
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== 'dy-gesture') return;

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

  // 页内快捷键：Alt + Shift + G
  document.addEventListener('keydown', function (e) {
    if (e.altKey && e.shiftKey && (e.key === 'G' || e.key === 'g')) {
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

  buildPill();
})();
