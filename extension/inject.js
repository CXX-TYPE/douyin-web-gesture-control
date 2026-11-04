/**
 * 运行在页面主世界（MAIN world）：
 * 摄像头取流 + MediaPipe 手部识别 + 手势状态机。
 * 识别到动作后通过 postMessage 通知 content.js 执行，不直接操作页面 DOM。
 *
 * v0.6.0 稳定性改造（解决「用着用着突然没反应，要重新开关一次」）：
 *   ① 送帧超时保护 —— send() 的 Promise 永不 resolve 时，busy 不会永久锁死
 *   ② 看门狗每 2 秒体检 —— 摄像头轨道 / 识别心跳 / 送帧卡顿
 *   ③ 异常自动重建链路 —— 不需要用户手动关开开关
 */
(function () {
  if (window.__DY_GESTURE__) return;
  window.__DY_GESTURE__ = true;

  // 模型来源：主源 + 两个备用源。
  // 只用单一 CDN 时，一旦它不可达（国内 jsDelivr 偶尔抽风），
  // 识别会静默失败，用户只看到「模型加载超时」却不知道换源。
  var CDN_LIST = [
    'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240',
    'https://fastly.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240',
    'https://unpkg.com/@mediapipe/hands@0.4.1675469240'
  ];
  var CDN = CDN_LIST[0];       // 实际生效的源，加载成功后被锁定
  var CDN_TIMEOUT = 6000;      // 单个源的超时

  // 与 PRD v0.4.1 §5 参数表一致
  var P = { hold: 300, cool: 1000, curl: 1.15, spread: 0.28, thumb: 0.30, edge: 0.015, minPw: 22 };

  // 看门狗阈值（毫秒）
  var WD = {
    period: 2000,        // 体检周期
    noResult: 8000,      // 超过这个时间没有识别结果 → 判定卡死
    sendTimeout: 4000,   // 单次送帧超时
    restartGap: 8000,    // 两次自动重启的最小间隔
    maxRestart: 3,       // 连续自动重启上限
    forgetAfter: 60000   // 连续稳定运行这么久之后，重启计数清零
  };

  var S = {
    running: false, starting: false, stream: null, hands: null,
    poseNow: 0, poseSince: 0, locked: false, lastPose: 0, lastFire: 0,
    busy: false, sendStuck: 0,
    frameSeq: 0, lastSentSeq: -1, lastSeqT: 0,
    results: 0, lastResultT: 0,
    restartCount: 0, lastRestartT: 0
  };

  var video = null;
  var lastStatus = '';
  var wdTimer = null;

  function tnow() { return performance.now(); }

  function post(obj) {
    obj.source = 'dy-gesture';
    window.postMessage(obj, '*');
  }
  function status(text) {
    if (text === lastStatus) return;
    lastStatus = text;
    post({ type: 'status', text: text });
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)); }

  // ---------- 判定：与演示页 pose.html 完全一致的算法 ----------
  function evaluate(lm, W, H) {
    var p = lm.map(function (q) { return { x: q.x * W, y: q.y * H, z: (q.z || 0) * W }; });
    var pw = dist(p[5], p[17]) || 0.0001;

    var FING = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]];
    var ratio = FING.map(function (f) {
      return dist(p[0], p[f[2]]) / (dist(p[0], p[f[1]]) || 0.0001);
    });

    // 真正区分"竖拇指"和"握拳"的，是拇指尖离食指尖有多远：
    // 握拳时拇指压在四指上，两者几乎贴在一起；竖拇指时明显分开
    var thumbAway = dist(p[4], p[8]) / pw;
    var thumbExt = (dist(p[4], p[5]) / pw > P.thumb) || thumbAway > 0.55;
    var gaps = [dist(p[8], p[12]), dist(p[12], p[16]), dist(p[16], p[20])].map(function (d) { return d / pw; });
    var spread = (gaps[0] + gaps[1] + gaps[2]) / 3;

    // 显式余量：伸直要 > curl+0.06，弯曲要 < curl-0.06。
    // 落在中间的「半伸」不参与任何手势——宁可这一次不响应，
    // 也不要把「比 1」认成「比 2」。方向误判比没反应严重得多。
    var HI = P.curl + 0.06, LO = P.curl - 0.06;
    var up = ratio.map(function (r) { return r > HI; });
    var down = ratio.map(function (r) { return r < LO; });

    var pose = 0;
    if (up[0] && down[1] && down[2] && down[3]) { pose = 1; }
    else if (up[0] && up[1] && down[2] && down[3]) { pose = 2; }
    else if (thumbAway > 0.55 && !up[0] && !up[1] && !(up[2] && up[3])) { pose = 3; }
    else if (up[0] && up[1] && up[2] && up[3] && spread > P.spread) { pose = 4; }

    var minX = 1, maxX = 0, minY = 1, maxY = 0;
    lm.forEach(function (q) {
      minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
    });
    var edge = minX < P.edge || maxX > 1 - P.edge || minY < P.edge || maxY > 1 - P.edge;

    return { pose: pose, edge: edge, pw: pw, thumbExt: thumbExt };
  }

  // ---------- 状态机：armed → holding → firing → locked ----------
  function onResults(res) {
    // 心跳：只要这里被调用，就说明「摄像头 → 模型 → 回调」这条链路是活的
    S.results++;
    S.lastResultT = tnow();

    var lm = res.multiHandLandmarks && res.multiHandLandmarks[0];
    var now = tnow();

    if (!lm) {
      S.poseNow = 0; S.poseSince = 0; S.locked = false; S.lastPose = 0;
      status('未检测到手');
      return;
    }

    var W = (video && video.videoWidth) || 640;
    var H = (video && video.videoHeight) || 480;
    var e = evaluate(lm, W, H);

    if (e.edge) { status('手太靠边 · 往中间挪'); return; }
    if (e.pw < P.minPw) { status('离镜头近一点'); return; }

    if (e.pose !== S.poseNow) { S.poseNow = e.pose; S.poseSince = now; }
    var held = S.poseNow ? (now - S.poseSince) : 0;

    if (S.locked) {
      if (S.poseNow === 0) S.locked = false;
      else if (S.poseNow !== S.lastPose && now - S.lastFire > 350) S.locked = false;
    }

    if (!S.poseNow) { status('已检测到手 · 手势不明确'); return; }

    var POSE_NAME = { 1: '比1', 2: '比2', 3: '竖拇指', 4: '五指张开' };
    status(S.locked ? '已触发 · 收手或换手势'
      : ('识别到 ' + (POSE_NAME[S.poseNow] || S.poseNow) + ' · ' + Math.round(held) + 'ms'));

    if (!S.locked && held >= P.hold && now - S.lastFire >= P.cool) {
      S.lastFire = now;
      S.lastPose = S.poseNow;
      S.locked = true;
      S.poseSince = now;
      post({ type: 'gesture', pose: e.pose });
    }
  }

  // ---------- 送帧 ----------
  function sendFrame() {
    var done = false;
    var guard = setTimeout(function () {
      if (done) return;
      S.busy = false;                     // 解开锁，否则整条链路永久冻结
      S.sendStuck = (S.sendStuck || 0) + 1;
    }, WD.sendTimeout);

    var p;
    try {
      p = S.hands.send({ image: video });
    } catch (err) {
      clearTimeout(guard);
      S.busy = false;
      S.sendStuck = (S.sendStuck || 0) + 1;
      return;
    }

    p.catch(function () {}).then(function () {
      done = true;
      clearTimeout(guard);
      S.busy = false;
      S.sendStuck = 0;
    });
  }

  function pump() {
    if (!S.running) return;
    try {
      var now = tnow();
      if (video && video.readyState >= 2 && !S.busy) {
        var fresh = S.frameSeq !== S.lastSentSeq;
        // requestVideoFrameCallback 万一下降级/停止，1.2 秒没有新帧也要兜底送一次，
        // 避免「帧序号不涨 → 永远不送帧」这种整条链路冻结
        if (!fresh && now - S.lastSeqT > 1200) fresh = true;

        if (fresh) {
          S.lastSentSeq = S.frameSeq;
          S.busy = true;
          sendFrame();
        }
      }
    } catch (err) {
      S.busy = false;
    }
    requestAnimationFrame(pump);   // 放在 try 外面，保证循环永不中断
  }

  // ---------- 模型 ----------
  function loadScript(url, timeout) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      var done = false;
      function finish(ok, err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (ok) resolve(); else {
          try { s.remove(); } catch (e) {}
          reject(err || new Error('load error'));
        }
      }
      var timer = setTimeout(function () { finish(false, new Error('timeout')); }, timeout);
      s.src = url;
      s.crossOrigin = 'anonymous';
      s.onload = function () { finish(true); };
      s.onerror = function () { finish(false, new Error('load error')); };
      document.head.appendChild(s);
    });
  }

  // 依次尝试 CDN_LIST，第一个成功的会被锁定（模型文件必须与 hands.js 同源）
  async function loadHands() {
    if (window.Hands) return;
    var lastErr = null;
    for (var i = 0; i < CDN_LIST.length; i++) {
      try {
        status(i === 0 ? '模型加载中…' : ('切换到备用源 ' + (i + 1) + '…'));
        await loadScript(CDN_LIST[i] + '/hands.js', CDN_TIMEOUT);
        if (window.Hands) {
          CDN = CDN_LIST[i];
          post({ type: 'status', text: '模型源 ' + (i + 1) });
          return;
        }
      } catch (e) {
        lastErr = e;
      }
    }
    throw (lastErr || new Error('识别模型加载失败，检查网络'));
  }

  function buildHands() {
    if (!window.Hands) return false;
    try {
      if (S.hands) { try { S.hands.close(); } catch (e) {} }
      S.hands = new window.Hands({ locateFile: function (f) { return CDN + '/' + f; } });
      S.hands.setOptions({
        maxNumHands: 1, modelComplexity: 0,
        minDetectionConfidence: 0.6, minTrackingConfidence: 0.6
      });
      S.hands.onResults(onResults);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------- 生命周期 ----------
  function realStop() {
    S.running = false;
    S.starting = false;
    S.busy = false;
    S.sendStuck = 0;

    if (S.stream) {
      try { S.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      S.stream = null;
    }
    if (video) { try { video.srcObject = null; } catch (e) {} }
    if (S.hands) { try { S.hands.close(); } catch (e) {} S.hands = null; }

    lastStatus = '';
  }

  function stop() {
    realStop();
    S.restartCount = 0;
    S.lastRestartT = 0;
    post({ type: 'state', on: false });
  }

  async function start() {
    if (S.running || S.starting) return;
    S.starting = true;

    try {
      status('正在请求摄像头…');
      var stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });
      S.stream = stream;

      // 摄像头被其他程序抢占 / 设备被拔掉时，轨道会 ended，立即触发恢复
      var track = stream.getVideoTracks()[0];
      if (track) {
        track.addEventListener('ended', function () {
          if (S.running) autoRestart('摄像头已断开');
        });
      }

      if (!video) {
        video = document.createElement('video');
        video.playsInline = true;
        video.muted = true;
        video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;';
        document.documentElement.appendChild(video);
      }
      video.srcObject = stream;
      await video.play();

      await loadHands();
      status('模型加载中…');
      if (!buildHands()) throw new Error('识别模型初始化失败');

      // 每次启动都彻底重置状态，避免上一轮的 busy / 计数残留
      S.running = true;
      S.starting = false;
      S.busy = false;
      S.sendStuck = 0;
      S.poseNow = 0; S.poseSince = 0; S.locked = false; S.lastPose = 0; S.lastFire = 0;
      S.results = 0; S.lastResultT = tnow();
      S.frameSeq = 0; S.lastSentSeq = -1; S.lastSeqT = tnow();

      if (video.requestVideoFrameCallback) {
        (function tick() {
          if (!S.running) return;
          S.frameSeq++;
          S.lastSeqT = tnow();
          video.requestVideoFrameCallback(tick);
        })();
      }

      pump();
      startWatchdog();
      status('待命 · 比 1 或 2');
      post({ type: 'state', on: true });
    } catch (err) {
      S.starting = false;
      realStop();
      var msg = err && err.name === 'NotAllowedError' ? '摄像头被拒绝'
        : (err && err.name === 'NotReadableError' ? '摄像头被其他程序占用'
          : (err && err.message) || '未知错误');
      status('启动失败：' + msg);
      post({ type: 'state', on: false });
    }
  }

  async function restart() {
    if (S.starting) return;
    realStop();
    await new Promise(function (r) { setTimeout(r, 500); });
    await start();
  }

  // ---------- 看门狗 ----------
  function autoRestart(reason) {
    var now = tnow();
    if (now - S.lastRestartT < WD.restartGap) return;

    // 稳定运行足够久，说明之前几次重启是偶发，计数清零
    if (now - S.lastRestartT > WD.forgetAfter) S.restartCount = 0;

    if (S.restartCount >= WD.maxRestart) {
      status('识别异常 · 按 Alt+Shift+G 重开');
      return;
    }

    S.lastRestartT = now;
    S.restartCount++;
    status('自动恢复 ' + S.restartCount + '/' + WD.maxRestart + ' · ' + reason);
    restart();
  }

  function watchdog() {
    if (!S.running || S.starting) return;
    // 后台标签页会被浏览器节流，此时不判异常，避免误重启
    if (document.hidden) return;

    var now = tnow();

    // ① 摄像头轨道
    var tracks = S.stream ? S.stream.getVideoTracks() : [];
    if (!tracks.length) return autoRestart('摄像头已断开');
    if (tracks[0].readyState === 'ended') return autoRestart('摄像头已释放');

    // ② 识别心跳：送帧一直在跑，但 onResults 不回调，说明模型内部卡住
    if (S.lastResultT && now - S.lastResultT > WD.noResult) {
      return autoRestart('识别无响应');
    }

    // ③ 连续送帧超时 → 只重建模型，比重启整条链路轻
    if (S.sendStuck >= 2) {
      S.sendStuck = 0;
      S.busy = false;
      if (buildHands()) status('模型已重建');
      else autoRestart('模型重建失败');
    }
  }

  function startWatchdog() {
    if (wdTimer) return;
    wdTimer = setInterval(watchdog, WD.period);
  }

  // 从后台切回前台：如果已经很久没有识别结果，立刻自愈一次
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !S.running) return;
    if (S.lastResultT && tnow() - S.lastResultT > WD.noResult) {
      S.restartCount = 0;
      S.lastRestartT = 0;
      autoRestart('页面恢复');
    }
  });

  // ---------- 消息 ----------
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== 'dy-ctrl') return;

    if (d.cmd === 'start') start();
    if (d.cmd === 'stop') stop();
    if (d.cmd === 'ping') post({ type: 'pong' });

    // 内容脚本发来的健康检查：正常时什么都不做，异常时顺手修一下
    if (d.cmd === 'ensure') {
      if (!S.running) start();
      else if (S.lastResultT && tnow() - S.lastResultT > WD.noResult) autoRestart('心跳超时');
    }
  });

  // 调试钩子：只给自动化测试用，不参与业务逻辑
  try {
    window.__DY_GESTURE_DEBUG__ = {
      state: function () {
        return {
          running: S.running, starting: S.starting, busy: S.busy,
          results: S.results, frameSeq: S.frameSeq,
          pose: S.poseNow, locked: S.locked,
          restartCount: S.restartCount,
          sinceResult: S.lastResultT ? Math.round(tnow() - S.lastResultT) : -1
        };
      },
      killResults: function () { S.lastResultT = tnow() - 999999; },
      cdn: function () { return CDN; },
      // 跳过摄像头，单独触发模型加载，用于验证 CDN 降级
      loadModel: function () {
        return loadHands().then(
          function () { return CDN; },
          function (e) { return 'FAIL: ' + (e && e.message); }
        );
      },
      forceBusy: function () { S.busy = true; }
    };
  } catch (e) {}

  // 页面加载后主动报到，content.js 会据此决定是否自动开启
  post({ type: 'ready' });
})();
