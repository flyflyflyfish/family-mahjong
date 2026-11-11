'use strict';
/* 果果麻将 客户端 v5.0 — 3D牌桌 / 拟真牌面 / 自动理牌 / 双击出牌 */

const NUM_CHARS = ['一','二','三','四','五','六','七','八','九'];
const SUITS = ['万','饼','条'];
const HONORS = ['东','南','西','北','中','发','白'];
const WINDS = ['东','南','西','北'];

function tileName(id) {
  return id < 27 ? NUM_CHARS[id % 9] + SUITS[(id / 9) | 0] : HONORS[id - 27];
}

let ws = null;
let me = { code: null, seat: -1, sid: null, user: null, name: null };
let roomState = null;
let gameState = null;
let selected = -1;      // 选中的手牌(显示序)
let claimChoice = null;
let friendsData = { friends: [], requests: [] };

const $ = (id) => document.getElementById(id);
const show = (id) => {
  const prev = document.querySelector('.screen.active');
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  // 节庆曲库: 进出对局时在大厅曲 / 对局曲之间切换 (show 只在脚本求值后被调用, 无 TDZ 问题)
  if (bgmStyle === 'fest' && bgmOn && musicOn &&
      festAudio && !festAudio.paused && (id === 'game') !== (prev && prev.id === 'game')) {
    festStart();
  }
  classicSyncScene(); // 大厅循环播放, 进入对局切对局曲
  if (typeof updateChatFab === 'function') updateChatFab(); // v6.6.37: 切屏同步绩/聊钮显隐(只牌桌显示)
};
function toast(msg, ms = 2200) {
  const el = $('toast'); el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ================= SVG 麻将牌面 (v5 拟真画风) ================= */
const INK = '#1c3f8f', RED = '#c23a2b', GRN = '#1d7a43', DGRN = '#0e5c33';
const SVG_OPEN = '<svg viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg">';
const SVG_CLOSE = '</svg>';
function svgTxt(ch, y, size, color) {
  return `<text x="15" y="${y}" text-anchor="middle" dominant-baseline="central" font-size="${size}" font-weight="900" fill="${color}" font-family="Kaiti SC,STKaiti,KaiTi,SimSun,serif">${ch}</text>`;
}
// 饼：传统同心圆与八瓣纹饰，缩小后仍有清晰轮廓
function mjDot(x, y, r, c) {
  let petals = '';
  for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 4;
    const px = x + Math.cos(a) * r * .69;
    const py = y + Math.sin(a) * r * .69;
    petals += `<circle cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" r="${(r * .1).toFixed(2)}" fill="${k % 2 ? RED : c}"/>`;
  }
  return `<g><circle cx="${x}" cy="${y}" r="${r}" fill="#fffdf4" stroke="${c}" stroke-width="1.45"/>` +
    `<circle cx="${x}" cy="${y}" r="${r * .82}" fill="none" stroke="${c}" stroke-width=".65" opacity=".72"/>${petals}` +
    `<circle cx="${x}" cy="${y}" r="${r * .42}" fill="none" stroke="${RED}" stroke-width="1.1"/>` +
    `<circle cx="${x}" cy="${y}" r="${r * .17}" fill="${c}"/></g>`;
}
function svgDots(n) {
  const pos = DOT_POS[n];
  const circles = pos.map(([x, y, r], i) => {
    const red = (n === 3 && i === 1) || (n === 5 && i === 2) || (n === 7 && i === 1) || (n === 9 && i === 4);
    return mjDot(x, y, r, red ? RED : (i % 2 ? GRN : INK));
  }).join('');
  return SVG_OPEN + circles + SVG_CLOSE;
}
// 条：圆润竹节、深色轮廓与高光，不再使用难辨认的折线
function stickSvg(x, y, w, h, c) {
  const top = y - h / 2;
  const left = x - w / 2;
  return `<g><rect x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${w}" height="${h}" rx="${(w * .48).toFixed(1)}" fill="${c}" stroke="#125335" stroke-width=".45"/>` +
    `<path d="M${(left + .5).toFixed(1)} ${(y - h * .18).toFixed(1)}H${(left + w - .5).toFixed(1)} M${(left + .5).toFixed(1)} ${(y + h * .18).toFixed(1)}H${(left + w - .5).toFixed(1)}" stroke="#f5e7b0" stroke-width=".65" opacity=".8"/>` +
    `<path d="M${(x - w * .18).toFixed(1)} ${(top + 1).toFixed(1)}V${(top + h - 1).toFixed(1)}" stroke="#fff" stroke-width=".55" opacity=".42"/></g>`;
}
function svgSticks(n) {
  if (n === 1) return SVG_OPEN + svgBird() + SVG_CLOSE;
  const sticks = STICK_POS[n].map(([x, y, w, h], i) => {
    const red = (n === 5 && i === 2) || (n === 7 && i === 0) || (n === 9 && i === 4);
    return stickSvg(x, y, w, h, red ? RED : GRN);
  }).join('');
  return SVG_OPEN + sticks + SVG_CLOSE;
}
// 幺鸡：传统绿鸟与竹枝
function svgBird() {
  return `<path d="M8 35 Q13 29 22 33" fill="none" stroke="${DGRN}" stroke-width="1.4" stroke-linecap="round"/>` +
    `<path d="M10 29 Q4 23 7 14 Q10 18 13 22 Q9 14 14 8 Q16 16 16 23" fill="${GRN}" stroke="${DGRN}" stroke-width=".7"/>` +
    `<ellipse cx="16" cy="23" rx="6.2" ry="8.3" fill="${GRN}" transform="rotate(24 16 23)"/>` +
    `<path d="M12 22 Q17 18 20 25 Q15 29 12 22" fill="#68a45f"/>` +
    `<circle cx="18.4" cy="12.4" r="3.8" fill="${GRN}"/>` +
    `<path d="M21.5 11.4 L26 13.1 L21.5 14.7 Z" fill="${RED}"/>` +
    `<path d="M16 9.2 Q17 5.8 19 8.5" fill="none" stroke="${RED}" stroke-width="1.2" stroke-linecap="round"/>` +
    `<circle cx="19.2" cy="11.5" r=".9" fill="#152d25"/><circle cx="19.45" cy="11.2" r=".25" fill="#fff"/>` +
    `<path d="M14 30 L12 35 M18 30 L18 35" stroke="${RED}" stroke-width="1.4" stroke-linecap="round"/>`;
}
// 万：墨蓝数字配朱红萬字，采用经典配色
function svgWan(n) {
  return SVG_OPEN + svgTxt(NUM_CHARS[n - 1], 11.5, 13.5, INK) + svgTxt('萬', 29, 16, RED) + SVG_CLOSE;
}
function svgHonor(id) {
  const map = {
    27: ['東', INK], 28: ['南', INK], 29: ['西', INK], 30: ['北', INK],
    31: ['中', RED], 32: ['發', GRN],
  };
  if (id === 33) {  // 白板: 双层蓝框
    return SVG_OPEN +
      `<rect x="6.5" y="8.5" width="17" height="23" rx="2" fill="none" stroke="${INK}" stroke-width="2"/>` +
      `<rect x="10" y="12" width="10" height="16" rx="1" fill="none" stroke="${INK}" stroke-width="1.1"/>` + SVG_CLOSE;
  }
  const [ch, color] = map[id];
  return SVG_OPEN + svgTxt(ch, 20, 22, color) + SVG_CLOSE;
}

// 饼: 圆圈布局 (viewBox 30x40)
const DOT_POS = {
  1: [[15, 20, 5.2]],
  2: [[15, 12, 3.8], [15, 28, 3.8]],
  3: [[9, 10, 3.2], [15, 20, 3.2], [21, 30, 3.2]],
  4: [[9, 11, 3.4], [21, 11, 3.4], [9, 29, 3.4], [21, 29, 3.4]],
  5: [[9, 11, 3], [21, 11, 3], [15, 20, 3.2], [9, 29, 3], [21, 29, 3]],
  6: [[9, 9, 3], [21, 9, 3], [9, 20, 3], [21, 20, 3], [9, 31, 3], [21, 31, 3]],
  7: [[8, 7, 2.7], [15, 11, 2.7], [22, 15, 2.7], [9, 26, 2.7], [21, 26, 2.7], [9, 33, 2.7], [21, 33, 2.7]],
  8: [[9, 6.5, 3], [21, 6.5, 3], [9, 15.5, 3], [21, 15.5, 3], [9, 24.5, 3], [21, 24.5, 3], [9, 33.5, 3], [21, 33.5, 3]],
  9: [[8, 8, 2.9], [15, 8, 2.9], [22, 8, 2.9], [8, 20, 2.9], [15, 20, 2.9], [22, 20, 2.9], [8, 32, 2.9], [15, 32, 2.9], [22, 32, 2.9]],
};

// 条: 绿竹竿布局
const STICK_POS = {
  1: [[15,20,4.2,13]],
  2: [[15,11,3.5,10],[15,29,3.5,10]],
  3: [[15,9,3.2,8],[10,27,3.2,11],[20,27,3.2,11]],
  4: [[9,12,3,9],[21,12,3,9],[9,28,3,9],[21,28,3,9]],
  5: [[9,11,3,8],[21,11,3,8],[15,20,3,8],[9,29,3,8],[21,29,3,8]],
  6: [[8,13,2.9,10],[15,13,2.9,10],[22,13,2.9,10],[8,28,2.9,10],[15,28,2.9,10],[22,28,2.9,10]],
  7: [[15,7,2.7,6],[8,17,2.7,7],[15,17,2.7,7],[22,17,2.7,7],[8,28,2.7,8],[15,28,2.7,8],[22,28,2.7,8]],
  8: [[8,7,2.7,6],[22,7,2.7,6],[8,16,2.7,6],[22,16,2.7,6],[8,25,2.7,6],[22,25,2.7,6],[8,34,2.7,6],[22,34,2.7,6]],
  9: [[8,8,2.6,7],[15,8,2.6,7],[22,8,2.6,7],[8,20,2.6,7],[15,20,2.6,7],[22,20,2.6,7],[8,32,2.6,7],[15,32,2.6,7],[22,32,2.6,7]],
};

function tileEl(id, wild, extraCls = '') {
  const d = document.createElement('div');
  d.className = `tile ${extraCls}`;
  if (wild) d.classList.add('wild');
  if (id != null && id >= 0) {
    d.dataset.id = id;
    d.setAttribute('aria-label', tileName(id) + (wild ? '，混儿' : ''));
    d.title = tileName(id) + (wild ? ' · 混儿' : '');
  }
  let svg;
  if (id == null || id < 0) svg = '';
  else if (id < 9) svg = svgWan(id % 9 + 1);
  else if (id < 18) svg = svgDots(id % 9 + 1);
  else if (id < 27) svg = svgSticks(id % 9 + 1);
  else svg = svgHonor(id);
  d.innerHTML = svg;
  return d;
}

/* ================= 连接 ================= */
// 手机切后台时系统会杀掉 WebSocket, 属正常现象; 这里做自动重连:
// 断开后指数退避重试(1s→2s→4s→5s封顶), 切回前台时立即探测并秒连
let reconnectTimer = null;
let reconnectDelay = 1000;
let lastPongTs = Date.now(); // 最近一次收到服务器 pong 的时间 (前台保活探测用)
let hadConnected = false; // v6.6.43: 是否已完成过首次连接 (区分首次连上 vs 掉线重连)

// 微信邀请链接带的一次性登录钥匙(?wxlogin=): 页面加载时读一次并立刻从地址栏清掉,
// 首次连上时优先用它登录 (v6.6.13 微信里点开邀请即自动登录)
let wxKeyOnce = null;
try {
  const sp = new URLSearchParams(location.search);
  const k = sp.get('wxlogin');
  if (k) {
    wxKeyOnce = k;
    sp.delete('wxlogin');
    const q = sp.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
  }
} catch (e) {}
function takeWxKey() { const k = wxKeyOnce; wxKeyOnce = null; return k; }

function wsAlive() { return ws && ws.readyState === 1; }

function connect(onOpen) {
  if (ws) { ws.onclose = null; ws.onopen = null; try { ws.close(); } catch (e) {} }
  clearTimeout(reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const wsPath = location.pathname.startsWith('/mj') ? '/mj-ws' : '/';
  ws = new WebSocket(proto + location.host + wsPath);
  ws.onopen = () => {
    reconnectDelay = 1000;
    lastPongTs = Date.now();
    // v6.6.43: 掉线重连后整体重建音频 —— 报牌声/牌声共用的 AudioContext 在掉线期间
    // 可能被系统回收音频会话 (僵尸 running / interrupted 态), resume 救不回, 表现为重连后
    // 语音+牌声全哑只能开关声音碰运气。重连时直接关旧建新 (AudioBuffer 与上下文无关, 直接复用)
    if (hadConnected) { try { audioRebuild(); } catch (e) {} }
    hadConnected = true;
    // 每次连上都要重新登录: 切后台后连接会被系统杀掉, 服务器已把人踢下线,
    // 但内存里的登录状态还在 — 必须每次重连都重新注册到服务器
    const wxKey = takeWxKey(); // 邀请链接带来的一次性钥匙只在首次连接时用一次
    if (wxKey) ws.send(JSON.stringify({ t: 'wx_login', key: wxKey }));
    else {
      const auth = loadAuth();
      if (auth) ws.send(JSON.stringify({ t: 'auto_login', token: auth.token }));
    }
    if (onOpen) onOpen();
    else if (me.sid && me.code) ws.send(JSON.stringify({ t: 'rejoin', code: me.code, sid: me.sid }));
  };
  ws.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.t === 'pong') lastPongTs = Date.now();
      handleMsg(m);
    } catch (err) {}
  };
  ws.onclose = () => {
    toast(me.sid ? '网络中断, 正在自动重连…' : '连接断开, 正在重连…', 6000);
    reconnectTimer = setTimeout(() => connect(null), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

// 连接假死探测: 发 ping, 3秒内没等到 pong 判定假死 → 立即重连
function probeNow() {
  if (!wsAlive()) { connect(null); return; }
  let ponged = false;
  const probe = (e) => { try { if (JSON.parse(e.data).t === 'pong') ponged = true; } catch (err) {} };
  ws.addEventListener('message', probe);
  try { ws.send(JSON.stringify({ t: 'ping' })); } catch (e) { return connect(null); }
  setTimeout(() => {
    ws.removeEventListener('message', probe);
    if (!ponged) connect(null);
  }, 3000);
}
// 切回前台: 立即检查连接, 死了就秒重连
function onForeground() {
  if (document.visibilityState !== 'visible') return;
  probeNow();
}
document.addEventListener('visibilitychange', onForeground);
window.addEventListener('pageshow', (e) => { if (e.persisted) onForeground(); });
// 网络恢复(Wi-Fi/流量切换): 立即探测, 假死直接重连
window.addEventListener('online', () => { if (!document.hidden) probeNow(); });
// 前台保活: 页面可见时每8秒 ping 一次, 20秒无响应强制重连 (v6.6.13)。
// 修复"假在线": 不切后台时连接悄悄断掉(路由抖动/隧道断流), 画面卡死、别人看到我离线, 之前只能手动刷新
setInterval(() => {
  if (document.hidden || !wsAlive()) return;
  if (Date.now() - lastPongTs > 20000) { try { ws.close(); } catch (e) {} connect(null); return; }
  try { ws.send(JSON.stringify({ t: 'ping' })); } catch (e) {}
}, 8000);

function handleMsg(m) {
  switch (m.t) {
    case 'welcome':
      me.code = m.code; me.seat = m.seat; me.sid = m.sid;
      me.spectator = !!m.spectator; // 开局中加入: 先观战, 下一局正式加入 (转正时服务器重发 welcome 清掉)
      localStorage.setItem('mj_session', JSON.stringify({ code: m.code, sid: m.sid }));
      // 进房即上报自己的声音, 保证其他人播报一致
      try { ws.send(JSON.stringify({ t: 'set_voice', voice: voiceGender })); } catch (e) {}
      break;
    case 'voice_peers': voiceOnPeers(m); break;
    case 'voice_offer': voiceOnOffer(m); break;
    case 'voice_answer': {
      const pc = voicePcs.get(m.from);
      if (pc) pc.setRemoteDescription(m.sdp).catch(() => {});
      break;
    }
    case 'voice_ice': {
      const pc = voicePcs.get(m.from);
      if (pc && m.c) pc.addIceCandidate(m.c).catch(() => {});
      break;
    }
    case 'error':
      // 微信一次性登录钥匙失效(链接超过10分钟/被用过) → 回退本机已有凭证自动登录
      if (m.msg === '微信登录链接已失效, 请手动登录') {
        const auth = loadAuth();
        if (auth && wsAlive()) ws.send(JSON.stringify({ t: 'auto_login', token: auth.token }));
      }
      // 房间没了 → 清干净本地会话, 回首页
      if (m.msg === '房间已解散' || m.msg === '座位已失效') {
        if (voiceActive) voiceLeave();
        localStorage.removeItem('mj_session');
        me.code = null; me.sid = null; me.seat = -1;
        roomState = null; gameState = null; classicIntense = false;
        show('home'); renderHome();
      }
      toast(m.msg); break;
    case 'info': toast(m.msg); break;
    case 'auth_ok': {
      const firstLogin = !me.user;
      me.user = m.user; me.name = m.name;
      saveAuth(m.user, m.token);
      friendsData = { friends: m.friends || [], requests: m.requests || [] };
      renderHome();
      if (firstLogin && document.getElementById('home').classList.contains('active')) toast('欢迎, ' + m.name);
      vapidPub = m.vapidPub;
      renderPushBtn();
      syncPushSilent(); // 开关已开且授权过 → 静默补报订阅; 从不自动弹授权
      // 微信提醒绑定引导 (登录后显示; 二维码图不存在则只显示文字)
      $('wxBind').classList.remove('hidden');
      // 多设备协调 (v6.6.27): 本机没有牌局会话时按账号找回座位
      // (浏览器掉线后从微信打开页面, 登录成功直接回到房间/牌桌)
      if (!me.code && !me.sid && wsAlive()) ws.send(JSON.stringify({ t: 'reclaim' }));
      break;
    }
    case 'logged_out':
      me.user = null; me.name = null; renderHome(); renderPushBtn();
      $('wxBind').classList.add('hidden');
      if (m.msg) toast(m.msg, 4000); // 被其他设备顶号时的提示
      break;
    case 'friends':
      onFriendsData(m);
      break;
    case 'invite':
      $('inviteText').textContent = `${m.fromName} 邀请你${m.code ? '加入房间 ' + m.code : '开局打麻将'}`;
      $('inviteModal')._code = m.code || null;
      $('inviteModal')._from = m.from;
      $('inviteModal').classList.remove('hidden');
      break;
    case 'left_room':
      if (voiceActive) voiceLeave(); // 退出房间必须挂断语音通话
      localStorage.removeItem('mj_session');
      me.code = null; me.sid = null; me.seat = -1; roomState = null; gameState = null; classicIntense = false;
      $('resultModal').classList.add('hidden');
      $('manageModal').classList.add('hidden');
      $('adminReqModal').classList.add('hidden');
      $('chatList').innerHTML = ''; $('chatPanel').classList.add('hidden'); chatOpen = false; chatUnread = 0;
      show('home'); renderHome();
      toast('已退出房间');
      break;
    case 'kicked':
      // 被房主踢出: 挂断语音, 清会话, 回首页
      if (voiceActive) voiceLeave();
      localStorage.removeItem('mj_session');
      me.code = null; me.sid = null; me.seat = -1; roomState = null; gameState = null; classicIntense = false;
      $('resultModal').classList.add('hidden');
      $('manageModal').classList.add('hidden');
      $('adminReqModal').classList.add('hidden');
      $('chatList').innerHTML = ''; $('chatPanel').classList.add('hidden'); chatOpen = false; chatUnread = 0;
      show('home'); renderHome();
      toast(m.msg || '你被房主请出了房间');
      break;
    case 'room_dissolved':
      if (voiceActive) voiceLeave(); // 房间解散必须挂断语音通话
      localStorage.removeItem('mj_session');
      $('manageModal').classList.add('hidden');
      $('adminReqModal').classList.add('hidden');
      me.code = null; me.sid = null; me.seat = -1; roomState = null; gameState = null; classicIntense = false;
      $('resultModal').classList.add('hidden');
      $('chatList').innerHTML = ''; $('chatPanel').classList.add('hidden'); chatOpen = false; chatUnread = 0;
      show('home'); renderHome();
      toast(m.msg || '房主已解散房间');
      break;
    case 'room': roomState = m; renderLobby(); if (!$('manageModal').classList.contains('hidden')) renderManage(); break;
    case 'admin_request':
      // 房主收到管理员申请 → 弹审批窗 (其他人只当个通知)
      if (roomState && roomState.seat === roomState.hostSeat) {
        $('adminReqName').textContent = m.name || '有人';
        $('adminReqModal').classList.remove('hidden');
      }
      break;
    case 'admin_request_done':
      $('adminReqModal').classList.add('hidden');
      break;
    case 'game': gameState = m; window.gameState = gameState; selected = -1; claimChoice = null;
      if (m.round !== seenRound) { seenRound = m.round; autoPlay = false; lastAutoKey = ''; classicIntense = false; } // 新一局: 自动打牌复位 + BGM 回普通曲池
      syncClassicIntense(m); // 自己上听 → 立即切换激昂版
      try { renderGame(); renderTingPanel(); hookGameSounds(m); } catch (e) { console.error('渲染异常', e); toast('界面刷新出错: ' + e.message); }
      maybeAutoDiscard(); // 自动打牌开启时, 轮到自己自动出最优张
      break;
    case 'result': showResult(m); hookResultSounds(m); autoPlay = false; lastAutoKey = ''; break; // v6.6.52: 一局结束自动打牌强制清零
    case 'chat':
      appendChat(m);
      updateChatFab();
      break;
    case 'chat_history':
      $('chatList').innerHTML = '';
      (m.list || []).forEach(c => appendChat(c, true));
      scrollChat();
      break;
    case 'history':
      statsCache = m.list || []; // v6.6.32: 供下次点击秒开
      if (!$('statModal').classList.contains('hidden')) showStats(m.list || []); // 弹窗开着才原地刷新(加载中/缓存), 已被用户关掉则不打扰
      break;
    case 'interact': {
      const iAmFrom = m.from === me.seat;
      if (!iAmFrom) { playInteract(m.kind); animInteract(m.from, m.target, m.kind); } // 自己发的在点击瞬间已播过, 不重复
      break; // v6.6.29: 不再有文字 toast, 改为飞行动画
    }
  }
  updateChatFab();
}

/* ================= 房间聊天 ================= */
let chatOpen = false, chatUnread = 0;

function updateChatFab() {
  const inRoom = !!(roomState || me.code);
  const inGame = ((document.querySelector('.screen.active') || {}).id === 'game'); // v6.6.37: 只在牌桌显示, 大厅里会压到面板边框
  $('chatFab').style.display = (inRoom && inGame) ? '' : 'none';
  $('statFab').style.display = (inRoom && inGame) ? '' : 'none';
  // 听牌分析按钮: 轮到自己出牌有分析数据, 或已上听 (随时能看胡哪些牌) 时显示
  const tingData = gameState && gameState.me && gameState.me.ting;
  const ready = gameState && gameState.me && gameState.me.tingReady;
  const showTing = inRoom && ((tingData && tingData.length) || (ready && ready.length));
  $('tingFab').style.display = showTing ? '' : 'none';
  if (!showTing) $('tingPanel').classList.add('hidden');
  const badge = $('chatBadge');
  if (chatUnread > 0 && !chatOpen) {
    badge.textContent = chatUnread > 9 ? '9+' : chatUnread;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

/* ================= 听牌分析面板 ================= */
let tingOpen = false;
let autoPlay = false;      // 自动打牌: 上听后在面板里手动开启, 新一局自动复位
let lastAutoKey = '';      // 防重复出牌: 记录最近一次自动动作 (局数+牌墙数+选择)
let seenRound = 0;         // 检测新局, 复位自动打牌
function renderTingPanel() {
  const mine = gameState && gameState.me;
  const tingData = mine && mine.ting;
  const ready = mine && mine.tingReady;
  const hasDrop = tingData && tingData.length;
  const hasReady = ready && ready.length;
  // v6.6.54: 自动打牌可用 = 已开门 且 处于听牌牌型 (轮到自己时看"打哪张能听"分析, 别人回合看"已上听")
  const myP2 = gameState && gameState.players && gameState.me ? gameState.players[gameState.me.seat] : null;
  const doorOpen = !!(myP2 && myP2.melds && myP2.melds.length);
  const list = $('tingList');
  if (!hasDrop && !hasReady) { $('tingPanel').classList.add('hidden'); return; }
  let html = '';
  if (hasDrop) {
    // 轮到自己: 打哪张 → 能胡哪些牌各剩几张
    html += tingData.map(r => {
      const ds = r.waits.map(w =>
        `<b class="ting-tile${w.n === 0 ? ' ting-dead' : ''}">${escapeHtml(w.name)}</b>×${w.n}${w.n === 0 ? '(绝)' : ''}`
      ).join('、');
      return `<div class="ting-row"><span class="ting-drop">打 ${escapeHtml(r.name)}</span>` +
        `<span class="ting-n">共 ${r.total} 张 / ${r.waits.length} 种</span>` +
        `<span class="ting-waits">${ds}</span></div>`;
    }).join('');
  } else if (hasReady) {
    // 已上听 (没轮到自己也常驻显示): 现在就能胡的牌 + 剩几张
    const total = ready.reduce((s, w) => s + w.n, 0);
    const ds = ready.map(w =>
      `<b class="ting-tile${w.n === 0 ? ' ting-dead' : ''}">${escapeHtml(w.name)}</b>×${w.n}${w.n === 0 ? '(绝)' : ''}`
    ).join('、');
    html += `<div class="ting-row"><span class="ting-drop">已上听</span>` +
      `<span class="ting-n">共 ${total} 张 / ${ready.length} 种</span>` +
      `<span class="ting-waits">${ds}</span></div>`;
  }
  // v6.6.54: 自动打牌 = 已开门 + 听牌牌型才可用 (未开门连误开的机会都没有); 两个回合阶段都显示
  if (doorOpen && (hasDrop || hasReady)) html += `<div class="ting-auto"><button id="autoBtn" class="btn${autoPlay ? ' primary' : ''}">🤖 自动打牌：${autoPlay ? '开' : '关'}</button></div>`;
  list.innerHTML = html;
  const ab = $('autoBtn');
  if (ab) ab.onclick = () => { autoPlay = !autoPlay; lastAutoKey = ''; renderTingPanel(); if (autoPlay) maybeAutoDiscard(); }; // 开启瞬间立即处理已弹出的吃碰决策
  $('tingPanel').classList.toggle('hidden', !tingOpen);
}
// 自动打牌 (与 AI 听牌逻辑一致): 能胡必胡; 有人出牌时可吃碰时自动处理 (能胡必胡, 否则过); 否则打"可胡总张数"最多的那张
function maybeAutoDiscard() {
  const g = gameState;
  if (!g || !autoPlay || !g.me) return;
  // 吃/碰决策 (actionBar 的碰/吃/过): 自动打牌时不能卡在这里等手动点
  if (g.phase === 'claim' && g.myClaim) {
    const key = 'claim:' + g.round + ':' + ((g.lastDiscard && g.lastDiscard.seq) || 0);
    if (key === lastAutoKey) return;
    lastAutoKey = key;
    if (g.myClaim.hu) { setTimeout(() => { try { ws.send(JSON.stringify({ t: 'action', act: 'hu' })); toast('🤖 自动打牌：自动胡'); } catch (e) {} }, 500); }
    else { setTimeout(() => { try { ws.send(JSON.stringify({ t: 'action', act: 'pass' })); toast('🤖 自动打牌：已自动过'); } catch (e) {} }, 600); }
    return;
  }
  if (g.phase !== 'discard' || g.turn !== g.me.seat) return;
  const wall = g.wallCount;
  if (g.me.canHu) { // 能胡必胡 (AI 同款第一步)
    const key = 'hu:' + g.round + ':' + wall;
    if (key !== lastAutoKey) { lastAutoKey = key; setTimeout(() => { try { ws.send(JSON.stringify({ t: 'action', act: 'hu' })); } catch (e) {} }, 400); }
    return;
  }
  const ting = g.me.ting;
  if (!ting || !ting.length) return;
  const key = g.round + ':' + wall + ':' + ting[0].idx;
  if (key === lastAutoKey) return; // 同一决策点只发一次
  lastAutoKey = key;
  setTimeout(() => { try { ws.send(JSON.stringify({ t: 'discard', idx: ting[0].idx })); } catch (e) {} }, 400);
}
$('tingFab').onclick = () => { tingOpen = !tingOpen; renderTingPanel(); };
$('tingClose').onclick = () => { tingOpen = false; $('tingPanel').classList.add('hidden'); };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ================= 快捷语录 (预设快捷用语, 男女声共用一份文案;
   播 Man/Woman 取决于发送者的声音设置) ================= */
const QUICK_CHATS = [
  '大家好，开局顺利',
  '这手牌不错',
  '稍等一下，我想想',
  '打得漂亮',
  '专心打牌啦',
  '网络有点卡，稍等',
  '我离开一会儿',
  '再来一局吧',
  '轮到谁了',
  '这局很精彩',
  '下次再约',
];
let chatQuickOn = true; // 语录音效: 默认开, 受声音总开关(bgmOn)管控
try { chatQuickOn = localStorage.getItem('mj_chat_quick') !== '0'; } catch (e) {}
function setChatQuick(on) {
  chatQuickOn = on;
  try { localStorage.setItem('mj_chat_quick', on ? '1' : '0'); } catch (e) {}
  if (on) playQuickChat(0, voiceGender); // 开启瞬间试听一句
  syncSoundModal();
}
const quickCache = {};
function playQuickChat(q, voice) {
  if (typeof q !== 'number' || q < 0 || q >= QUICK_CHATS.length) return;
  if (!bgmOn || !chatQuickOn) return;
  const v = voiceGain(); // 随语音播报音量 (v6.6.50: 维持原归属)
  if (v <= 0) return;
  try {
    const key = (voice === 'm' ? 'Man' : 'Woman') + '_Chat_' + q; // 文件名是 Man_Chat_0.mp3 (v6.6.25 修正: 之前拼成 Man_0.mp3 一直 404 没声)
    let a = quickCache[key];
    if (!a) { a = new Audio('music/chat/' + key + '.mp3'); a.preload = 'auto'; quickCache[key] = a; }
    a.volume = Math.min(1, 0.9 * v); // 随语音播报音量
    try { a.currentTime = 0; } catch (e) {}
    a.play().catch(() => {});
  } catch (e) {}
}
function appendChat(c, noUnread) {
  const list = $('chatList');
  const mine = c.seat === me.seat;
  const div = document.createElement('div');
  div.className = 'chat-msg' + (mine ? ' mine' : '');
  const time = c.ts ? new Date(c.ts).toTimeString().slice(0, 5) : '';
  const isQuick = typeof c.q === 'number' && c.q >= 0 && c.q < QUICK_CHATS.length;
  const bubble = isQuick ? '💬 ' + escapeHtml(QUICK_CHATS[c.q]) : escapeHtml(c.text);
  div.innerHTML = `<div class="cm-name">${escapeHtml(c.name || '?')}<span>${time}</span></div><div class="cm-bubble">${bubble}</div>`;
  list.appendChild(div);
  while (list.children.length > 60) list.removeChild(list.firstChild);
  if (isQuick && !noUnread && !mine) playQuickChat(c.q, c.voice); // 别人发的实时播; 自己的在发送瞬间已本地播过, 不重复; 历史回放不播
  if (!noUnread && !mine && !chatOpen) chatUnread++;
  scrollChat();
}

function scrollChat() {
  const list = $('chatList');
  if (chatOpen || !list.parentElement.classList.contains('hidden')) list.scrollTop = list.scrollHeight;
}

function sendChat() {
  const inp = $('chatInput');
  const text = inp.value.trim();
  if (!text) return;
  if (!me.code) { toast('先进房间才能聊天'); return; }
  if (wsAlive()) ws.send(JSON.stringify({ t: 'chat', text }));
  else toast('连接断开, 稍后再试');
  inp.value = '';
}
function sendQuickChat(q) {
  if (!me.code) { toast('先进房间才能聊天'); return; }
  if (!wsAlive()) { toast('连接断开, 稍后再试'); return; }
  playQuickChat(q, voiceGender); // 点击手势内本地立即播 (等服务器回包再播会脱离手势, 手机浏览器会拒绝自动播放导致没声, v6.6.24)
  ws.send(JSON.stringify({ t: 'chat', q }));
  toggleQuickPop(false);
}
function toggleQuickPop(show) {
  const pop = $('chatQuickPop');
  if (!pop) return;
  const open = show == null ? !pop.classList.contains('open') : !!show;
  pop.classList.toggle('open', open);
  $('chatQuickBtn').classList.toggle('on', open);
}

/* ================= 战绩 ================= */
let statsCache = null; // v6.6.32: 上次战绩缓存, 点击瞬间先展示, 后台静默刷新
function requestHistory() {
  if (!me.user) return toast('登录后才能查看战绩');
  if (!wsAlive()) return toast('连接中, 请稍候…');
  if (statsCache) {
    showStats(statsCache); // 秒开缓存
  } else {
    $('statList').innerHTML = '<p class="stat-empty">加载中…</p>';
    $('statModal').classList.remove('hidden');
  }
  ws.send(JSON.stringify({ t: 'history' })); // 数据回来后 showStats 会原地刷新
}

function showStats(list) {
  const box = $('statList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<p class="stat-empty">还没有战绩, 开一局吧</p>';
  } else {
    const days = new Map();
    list.forEach(r => {
      const d = new Date(r.ts);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(r);
    });
    for (const [day, rs] of days) {
      const total = rs.reduce((s, r) => s + (r.delta || 0), 0);
      const h = document.createElement('div');
      h.className = 'stat-day';
      h.innerHTML = `<span>${day}</span><b class="${total > 0 ? 'pos' : total < 0 ? 'neg' : ''}">${total > 0 ? '+' : ''}${total} 元</b>`;
      box.appendChild(h);
      rs.forEach(r => {
        const d = new Date(r.ts);
        const line = document.createElement('div');
        line.className = 'stat-row clickable';
        const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const cls = r.delta > 0 ? 'pos' : r.delta < 0 ? 'neg' : '';
        const winTxt = r.draw ? '<i class="st-win draw">流局</i>' : (r.winnerName ? `<i class="st-win">${escapeHtml(r.winnerName)}胡</i>` : '');
        line.innerHTML = `<span class="st-time">${time}</span>` +
          `<span class="st-desc">${r.isDealer ? '<i class="tag">庄</i>' : ''}${escapeHtml(r.desc || '')}${r.code ? ` <i class="st-room">#${escapeHtml(r.code)}</i>` : ''}</span>` +
          winTxt +
          `<b class="${cls}">${r.delta > 0 ? '+' : ''}${r.delta || 0}</b>`;
        line.onclick = () => showStatsDetail(r, list);
        box.appendChild(line);
      });
    }
  }
  $('statModal').classList.remove('hidden');
}

// 战绩详情: 和谁玩的 / 谁胡了 / 各家输赢 / 我的牌
function showStatsDetail(r, list) {
  const box = $('statList');
  box.innerHTML = '';
  const back = document.createElement('button');
  back.className = 'mini stat-back';
  back.textContent = '← 返回列表';
  back.onclick = () => showStats(list);
  box.appendChild(back);
  const d = new Date(r.ts);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const time = `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const head = document.createElement('div');
  head.className = 'stat-detail-head';
  head.innerHTML = `<b>${escapeHtml(time)}</b>${r.code ? ` <i class="st-room">#${escapeHtml(r.code)}</i>` : ''}` +
    (r.calc && r.calc.text ? `<div class="stat-calc">💰 ${escapeHtml(r.calc.text)}</div>` : '');
  box.appendChild(head);
  // 各家输赢
  const tbl = document.createElement('div');
  tbl.className = 'stat-deltas';
  (r.players || []).forEach((p, i) => {
    const cls = p.delta > 0 ? 'pos' : p.delta < 0 ? 'neg' : '';
    const row = document.createElement('div');
    row.className = 'stat-delta-row';
    row.innerHTML = `<span class="sd-name">${escapeHtml(p.name || '?')}${p.bot ? '<i class="tag">机器人</i>' : ''}${(!p.bot && r.players[i].desc && r.players[i].desc.includes('庄')) ? '<i class="tag">庄</i>' : ''}</span>` +
      `<span class="sd-desc">${escapeHtml(p.desc || '')}</span>` +
      `<b class="${cls}">${p.delta > 0 ? '+' : ''}${p.delta || 0}</b>`;
    tbl.appendChild(row);
  });
  box.appendChild(tbl);
  // 我的牌
  if (r.myHand && r.myHand.length) {
    const sec = document.createElement('div');
    sec.className = 'stat-mine';
    sec.innerHTML = `<div class="stat-mine-title">我的牌</div>`;
    const meldsBox = document.createElement('div');
    meldsBox.className = 'stat-melds';
    (r.myMelds || []).forEach(m => {
      const mg = document.createElement('div');
      mg.className = 'meld-mini';
      (m.tiles || []).forEach(id => mg.appendChild(tileEl(id, false, 'small')));
      meldsBox.appendChild(mg);
    });
    if ((r.myMelds || []).length) sec.appendChild(meldsBox);
    const handBox = document.createElement('div');
    handBox.className = 'stat-hand';
    // 与游戏内一致的排序: 混儿排最前, 其余按牌值升序
    [...r.myHand].sort((a, b) => (b.wild ? 1 : 0) - (a.wild ? 1 : 0) || a.id - b.id)
      .forEach(t => handBox.appendChild(tileEl(t.id, !!t.wild, 'small')));
    sec.appendChild(handBox);
    box.appendChild(sec);
  }
}

$('statFab').onclick = requestHistory;
$('btnStats').onclick = requestHistory;
$('btnStatClose').onclick = () => $('statModal').classList.add('hidden');

function toggleChat(open) {
  chatOpen = open === undefined ? $('chatPanel').classList.contains('hidden') : open;
  $('chatPanel').classList.toggle('hidden', !chatOpen);
  if (chatOpen) {
    chatUnread = 0;
    updateChatFab();
    scrollChat();
    // 不自动聚焦输入框, 避免一点开就弹键盘; 点输入框时再唤起
    $('chatInput').blur();
  }
}

$('chatFab').onclick = () => toggleChat();
$('chatClose').onclick = () => toggleChat(false);
$('chatSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });
// 快捷语录弹层: 构建 + 开关 + 点外面收起
(function initQuickPop() {
  const pop = $('chatQuickPop');
  if (!pop) return;
  QUICK_CHATS.forEach((t, i) => {
    const b = document.createElement('button');
    b.textContent = t;
    b.dataset.noop = '1'; // 自己会播语录语音, 跳过全局 SpecOk 按钮音
    b.onclick = () => sendQuickChat(i);
    pop.appendChild(b);
  });
})();
$('chatQuickBtn').onclick = (e) => { e.stopPropagation(); toggleQuickPop(); };
document.addEventListener('click', (e) => {
  const pop = $('chatQuickPop'), btn = $('chatQuickBtn');
  if (pop && btn && pop.classList.contains('open') && !pop.contains(e.target) && !btn.contains(e.target)) toggleQuickPop(false);
});

/* ================= 玩家互动 (点头像弹框: 发消息召回 + 送花/扔鸡蛋等道具) ================= */
const INTERACT_FX = { flower: 'emoj_meigui', egg: 'emoj_xihongshi', water: 'emoj_shuitong', tea: 'emoj_chabei', paw: 'emoj_zhuaji' };
let pactTarget = -1;
function playInteract(kind) {
  if (!bgmOn || !chatQuickOn) return; // 受声音总开关 + 聊天语录语音开关管控 (v6.6.28, 与语录声合并)
  const f = INTERACT_FX[kind];
  if (!f) return;
  if (fxPlayLowLatency(f, 0.65 * musicGain())) return;
  try { // 回退: HTMLAudio
    let a = opCache[f];
    if (!a) { a = new Audio('music/fx/' + f + '.mp3'); a.preload = 'auto'; opCache[f] = a; }
    a.volume = 0.65 * musicGain();
    try { a.currentTime = 0; } catch (e) {}
    a.play().catch(() => {});
  } catch (e) {}
}

/* ---- 互动动画 (v6.6.29): 节奏式 — 道具从发起者头像飞向目标头像, 命中爆开 + 头像抖动, 不再有文字提示 ---- */
const INTERACT_EMO = { flower: ['🌹', '🌸'], egg: ['🥚', '🍳'], water: ['🪣', '💦'], tea: ['🫖', '🍵'], paw: ['🐾', '✨'] };
function avatarElOf(seat) {
  const cands = [];
  if (seat === me.seat) cands.push($('myAvatar'));
  cands.push(document.querySelector('#opponents [data-pact="' + seat + '"]'));
  cands.push(document.querySelector('#lobbyPlayers [data-pact="' + seat + '"]'));
  for (const el of cands) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el; // 只取当前可见的
  }
  return null;
}
function animInteract(fromSeat, targetSeat, kind) {
  const pair = INTERACT_EMO[kind] || ['🌹', '✨'];
  const toEl = avatarElOf(targetSeat);
  if (!toEl || !toEl.animate) return;
  const fromEl = avatarElOf(fromSeat);
  const r2 = toEl.getBoundingClientRect();
  const x2 = r2.left + r2.width / 2, y2 = r2.top + r2.height / 2;
  let x1, y1;
  if (fromEl) {
    const r1 = fromEl.getBoundingClientRect();
    x1 = r1.left + r1.width / 2; y1 = r1.top + r1.height / 2;
  } else { x1 = x2; y1 = window.innerHeight - 60; } // 找不到发起者(跨页面) → 从底部飞来
  const dx = x2 - x1, dy = y2 - y1;
  // 飞行道具: 抛物线 + 旋转, 0.85 秒到目标
  const fly = document.createElement('div');
  fly.className = 'ia-fly'; fly.textContent = pair[0];
  fly.style.left = x1 + 'px'; fly.style.top = y1 + 'px';
  document.body.appendChild(fly);
  const flyAnim = fly.animate([
    { transform: 'translate(-50%,-50%) scale(.5) rotate(0deg)', opacity: .3, offset: 0 },
    { transform: `translate(calc(-50% + ${dx * .5}px), calc(-50% + ${dy * .5 - 80}px)) scale(1.35) rotate(200deg)`, opacity: 1, offset: .5 },
    { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1.05) rotate(340deg)`, opacity: 1, offset: 1 },
  ], { duration: 850, easing: 'cubic-bezier(.25,.6,.35,1)', fill: 'forwards' });
  const cleanup = () => { try { fly.remove(); } catch (e) {} };
  flyAnim.onfinish = () => {
    cleanup();
    // 命中爆开: 扩散 + 淡出
    const burst = document.createElement('div');
    burst.className = 'ia-burst'; burst.textContent = pair[1];
    burst.style.left = x2 + 'px'; burst.style.top = y2 + 'px';
    document.body.appendChild(burst);
    const bAnim = burst.animate([
      { transform: 'translate(-50%,-50%) scale(.4)', opacity: 1, offset: 0 },
      { transform: 'translate(-50%,-50%) scale(2.1)', opacity: 1, offset: .35 },
      { transform: 'translate(-50%,-95%) scale(1.5)', opacity: 0, offset: 1 },
    ], { duration: 950, easing: 'ease-out', fill: 'forwards' });
    bAnim.onfinish = () => { try { burst.remove(); } catch (e) {} };
    setTimeout(() => { try { burst.remove(); } catch (e) {} }, 1600);
    // 被砸的头像抖一下
    try {
      toEl.animate([
        { transform: 'translate(0,0) rotate(0deg)' },
        { transform: 'translate(-5px,2px) rotate(-6deg)' },
        { transform: 'translate(5px,-2px) rotate(6deg)' },
        { transform: 'translate(-3px,-1px) rotate(-3deg)' },
        { transform: 'translate(0,0) rotate(0deg)' },
      ], { duration: 380, easing: 'ease-in-out' });
    } catch (e) {}
  };
  setTimeout(cleanup, 2500); // 兜底防泄漏
}
function openPlayerAct(seat, name, online) {
  if (seat < 0 || seat === me.seat) return;
  pactTarget = seat;
  $('pActName').textContent = name || '?';
  $('pActStatus').textContent = online ? '🟢 在线' : '⚪ 离线';
  const rb = $('pActRemind');
  rb.classList.toggle('hidden', online); // 只有离线的才需要喊回来
  rb.disabled = false;
  rb.textContent = '📩 发消息喊TA回来（推送+微信）';
  $('pActModal').classList.remove('hidden');
}
$('pActClose').onclick = () => $('pActModal').classList.add('hidden');
$('pActRemind').onclick = () => {
  if (!wsAlive() || pactTarget < 0) return;
  ws.send(JSON.stringify({ t: 'remind', target: pactTarget }));
  $('pActRemind').disabled = true; // 一次性: 发过就等TA回来 (服务端也会拦)
  $('pActRemind').textContent = '✅ 已发送, 等TA回来吧';
};
document.querySelectorAll('#pActRow button').forEach((b) => {
  b.dataset.noop = '1'; // 自带互动音效, 跳过全局 SpecOk
  b.onclick = () => {
    if (!wsAlive() || pactTarget < 0) return;
    const kind = b.dataset.k;
    playInteract(kind); // 点击手势内本地立即播
    animInteract(me.seat, pactTarget, kind); // 飞行动画 (v6.6.29)
    ws.send(JSON.stringify({ t: 'interact', target: pactTarget, kind }));
    $('pActModal').classList.add('hidden');
  };
});

// 启动时校准悬浮按钮显隐 (HTML 默认隐藏, 在房间里/恢复会话时再显示)
updateChatFab();

// 微信提醒二维码: 图片存在才显示 (还没放图时不占位)
(() => {
  const img = $('wxQr');
  if (!img) return;
  img.onload = () => { img.style.display = 'block'; };
  img.onerror = () => { img.style.display = 'none'; };
  if (img.complete && img.naturalWidth > 0) img.style.display = 'block'; // 缓存图不会再触发onload, 直接显示
})();

/* ================= 离线推送 (房间邀请提醒) ================= */
// 首页开关: 开启时申请授权并订阅; 关闭时退订并通知服务器。登录后仅静默同步, 不自动弹授权
function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
}
let vapidPub = null;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pushPrefOn = () => localStorage.getItem('mj_push') === 'on';

function renderPushBtn() {
  const b = $('btnPush');
  if (!b) return;
  if (!me.user || !pushSupported()) { b.style.display = 'none'; return; }
  b.style.display = '';
  const on = pushPrefOn();
  b.classList.toggle('on', on);
  b.title = on ? '邀请通知: 已开启 (点按关闭)' : '邀请通知: 已关闭 (点按开启)';
}

async function syncPushSilent() {
  // 已开启且已授权 → 确保订阅存在并上报服务器 (换设备/服务端重启后自动补上)
  try {
    if (!pushPrefOn() || !vapidPub || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.register('sw.js');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(vapidPub) });
    if (wsAlive()) ws.send(JSON.stringify({ t: 'push_sub', sub: sub.toJSON() }));
  } catch (e) { /* 推送异常不影响游戏 */ }
}

$('btnPush').onclick = async () => {
  if (!me.user) return toast('请先登录');
  if (!pushSupported()) return toast('当前浏览器不支持通知 (微信内无效, 请用 Chrome/Edge 等)');
  if (pushPrefOn()) {
    // 关闭: 退订 + 通知服务器清掉
    localStorage.setItem('mj_push', 'off');
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch (e) {}
    if (wsAlive()) ws.send(JSON.stringify({ t: 'push_sub_off' }));
    toast('已关闭邀请通知');
  } else {
    // 开启: 授权请求必须在点击手势内第一时间发起(先于任何 await), 否则部分浏览器会静默拒绝
    try {
      let perm = Notification.permission;
      if (perm === 'default') perm = await Notification.requestPermission();
      if (perm === 'denied') { toast('通知权限已被浏览器拒绝: 请在浏览器设置里找到本站, 把「通知」改为允许后重试'); renderPushBtn(); return; }
      if (perm !== 'granted') { toast('未获得通知权限, 可稍后重试'); renderPushBtn(); return; }
      const reg = await navigator.serviceWorker.register('sw.js');
      if (!vapidPub) { toast('连接还没就绪, 请稍后再试'); renderPushBtn(); return; }
      const sub = await reg.pushManager.getSubscription() ||
                  await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(vapidPub) });
      if (wsAlive()) ws.send(JSON.stringify({ t: 'push_sub', sub: sub.toJSON() }));
      localStorage.setItem('mj_push', 'on');
      toast('已开启: 收到房间邀请时会提醒你');
    } catch (e) {
      // 国内安卓 Chrome 订阅推送要连谷歌服务器, 连不上会超时(AbortError), 给出人话提示
      const name = e && e.name || '';
      if (name === 'AbortError' || name === 'TimeoutError' || /push service|registration failed|gcm|fcm/i.test((e && e.message) || ''))
        toast('手机连不上推送服务器(国内安卓网络限制), 开不了离线提醒, 邀请会在你打开游戏时送达');
      else toast('开启失败: ' + (e && e.message || e));
    }
  }
  renderPushBtn();
};

/* ================= 首页 / 账号 / 好友 ================= */
function ensureConn(cb) {
  if (wsAlive()) cb();
  else connect(cb);
}

function myName() { return me.user ? me.name : $('nick').value.trim(); }

$('btnCreate').onclick = () => {
  const name = myName();
  if (!name) return err('请先输入昵称');
  ensureConn(() => ws.send(JSON.stringify({ t: 'create', name })));
};
$('btnJoin').onclick = () => {
  const name = myName();
  const code = $('joinCode').value.trim();
  if (!name) return err('请先输入昵称');
  if (!/^\d{4}$/.test(code)) return err('请输入4位房间号');
  ensureConn(() => ws.send(JSON.stringify({ t: 'join', code, name })));
};
function err(s) { $('homeErr').textContent = s; setTimeout(() => $('homeErr').textContent = '', 2500); }

/* ---- 登录 / 注册 ---- */
let authMode = 'login';
$('tabLogin').onclick = () => setAuthMode('login');
$('tabReg').onclick = () => setAuthMode('reg');
function setAuthMode(m) {
  authMode = m;
  $('tabLogin').classList.toggle('active', m === 'login');
  $('tabReg').classList.toggle('active', m === 'reg');
  $('authNick').classList.toggle('hidden', m === 'login');
  $('btnAuth').textContent = m === 'login' ? '登录' : '注册并登录';
}
$('btnAuth').onclick = () => {
  const user = $('authUser').value.trim();
  const pass = $('authPass').value;
  if (!user || !pass) return err('请输入账号和密码');
  if (authMode === 'login') {
    ensureConn(() => ws.send(JSON.stringify({ t: 'login', user, pass })));
  } else {
    const name = $('authNick').value.trim();
    if (!name) return err('请输入牌桌昵称');
    ensureConn(() => ws.send(JSON.stringify({ t: 'register', user, pass, name })));
  }
};
$('btnLogout').onclick = () => {
  localStorage.removeItem('mj_auth');
  document.cookie = 'mj_auth=; max-age=0; path=/';
  if (wsAlive()) ws.send(JSON.stringify({ t: 'logout' }));
  me.user = null; me.name = null;
  renderHome();
};

// 微信邀请提醒弹窗
$('btnWx').onclick = () => { renderPushBtn(); $('wxModal').classList.remove('hidden'); };
$('btnWxCloseX').onclick = () => $('wxModal').classList.add('hidden');
$('btnWxClose').onclick = () => $('wxModal').classList.add('hidden');

/* 登录凭证: localStorage + Cookie 双保险 (有的浏览器会清 localStorage) */
function saveAuth(user, token) {
  try { localStorage.setItem('mj_auth', JSON.stringify({ user, token })); } catch (e) {}
  try { document.cookie = 'mj_auth=' + encodeURIComponent(user + ':' + token) + '; max-age=31536000; path=/'; } catch (e) {}
}
function loadAuth() {
  try {
    const a = JSON.parse(localStorage.getItem('mj_auth') || 'null');
    if (a && a.user && a.token) return a;
  } catch (e) {}
  try {
    const m = document.cookie.match(/(?:^|;\s*)mj_auth=([^;]+)/);
    if (m) {
      const [user, token] = decodeURIComponent(m[1]).split(':');
      if (user && token) return { user, token };
    }
  } catch (e) {}
  return null;
}

/* ---- 好友 ---- */
$('btnAddFriend').onclick = () => {
  const u = $('friendInput').value.trim();
  if (!u) return err('请输入对方账号');
  if (!wsAlive()) return err('连接中, 请稍候…');
  ws.send(JSON.stringify({ t: 'add_friend', user: u }));
  $('friendInput').value = '';
};

function inviteFriend(user) {
  if (!wsAlive()) return err('连接中, 请稍候…');
  // 不再预先建房: 对方接受时房间才创建
  ws.send(JSON.stringify({ t: 'invite', user }));
}

// 好友数据到达(登录/推送): 记录渲染 + 新申请提醒 + 管理面板/邀请面板开着时实时刷新
let prevRequestUsers = [];
function onFriendsData(m) {
  const prev = friendsData.requests.map(r => r.user);
  friendsData = { friends: m.friends || [], requests: m.requests || [] };
  // 新收到的好友申请 → 弹提示 (无论在不在房间都能看到)
  friendsData.requests.forEach(r => {
    if (!prev.includes(r.user) && !prevRequestUsers.includes(r.user)) toast(`📨 ${r.name} 请求加你为好友`);
  });
  prevRequestUsers = friendsData.requests.map(r => r.user);
  renderFriends();
  if (!$('manageModal').classList.contains('hidden')) { renderManage(); renderManageFriends(); }
  if (!$('pickModal').classList.contains('hidden')) renderPickList();
}

function sendFriendRequest(u) {
  if (!u) return toast('请输入对方账号');
  if (!me.user) return toast('登录后才能加好友');
  if (!wsAlive()) return toast('连接中, 请稍候…');
  ws.send(JSON.stringify({ t: 'add_friend', user: u }));
}

function copyText(text, tip) {
  const done = () => toast(tip || '已复制');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta); done();
  } catch (e) { toast('复制失败, 请手动记下: ' + text); }
}

function renderFriends() {
  const ul = $('friendList');
  ul.innerHTML = '';
  friendsData.requests.forEach(r => {
    const li = document.createElement('li');
    li.className = 'friend req';
    const sp = document.createElement('span');
    sp.className = 'fname'; sp.textContent = `📨 ${r.name} 请求加你为好友`;
    const ok = document.createElement('button'); ok.className = 'mini primary'; ok.textContent = '同意';
    ok.onclick = () => ws.send(JSON.stringify({ t: 'accept_friend', user: r.user }));
    const no = document.createElement('button'); no.className = 'mini'; no.textContent = '拒绝';
    no.onclick = () => ws.send(JSON.stringify({ t: 'decline_friend', user: r.user }));
    li.appendChild(sp); li.appendChild(ok); li.appendChild(no);
    ul.appendChild(li);
  });
  friendsData.friends.forEach(f => {
    const li = document.createElement('li');
    li.className = 'friend';
    const st = f.online ? (f.room ? '🀄 在房间' : '🟢 在线') : '⚪ 离线';
    const sp = document.createElement('span');
    sp.className = 'fname'; sp.textContent = f.name;
    const ss = document.createElement('span');
    ss.className = 'fstatus' + (f.online ? ' on' : ''); ss.textContent = st;
    li.appendChild(sp); li.appendChild(ss);
    const inv = document.createElement('button');
    inv.className = 'mini primary'; inv.textContent = '邀请';
    inv.onclick = () => { inv.textContent = '已发'; inv.disabled = true; inviteFriend(f.user); };
    li.appendChild(inv);
    ul.appendChild(li);
  });
  if (!friendsData.friends.length && !friendsData.requests.length) {
    ul.innerHTML = '<li class="empty">还没有好友, 输入对方的账号添加吧</li>';
  }
}

function renderHome() {
  const logged = !!me.user;
  $('authView').classList.toggle('hidden', logged);
  $('userView').classList.toggle('hidden', !logged);
  $('friendPanel').classList.toggle('hidden', !logged);
  $('nick').parentElement.classList.toggle('hidden', logged); // 登录后用账号昵称
  if (logged) {
    $('myName').textContent = me.name;
    $('myName').title = '账号: ' + me.user;
    renderFriends();
  }
}

/* ---- 大厅内邀请好友 ---- */
$('btnInviteF').onclick = () => {
  if (!me.user) return toast('登录后才能邀请好友, 首页可注册');
  if (!wsAlive()) return toast('连接中, 请稍候…');
  renderPickList();
  $('pickModal').classList.remove('hidden');
};
function renderPickList() {
  const ul = $('pickList');
  ul.innerHTML = '';
  if (!friendsData.friends.length) ul.innerHTML = '<li class="empty">还没有好友, 可在「房间管理」里添加</li>';
  friendsData.friends.forEach(f => {
    const li = document.createElement('li');
    li.className = 'friend';
    const st = f.online ? (f.room ? '🀄 在房间' : '🟢 在线') : '⚪ 离线';
    li.innerHTML = `<span class="fname">${f.name}</span><span class="fstatus${f.online ? ' on' : ''}">${st}</span>`;
    const b = document.createElement('button');
    b.className = 'mini primary'; b.textContent = '邀请';
    b.onclick = () => {
      b.textContent = '已发'; b.disabled = true;
      ws.send(JSON.stringify({ t: 'invite', user: f.user }));
    };
    li.appendChild(b);
    ul.appendChild(li);
  });
}
$('btnPickClose').onclick = () => $('pickModal').classList.add('hidden');

/* ---- 邀请弹窗 ---- */
$('btnInviteJoin').onclick = () => {
  const modal = $('inviteModal');
  const code = modal._code, from = modal._from;
  modal.classList.add('hidden');
  if (roomState) return toast('你已经在房间里了');
  if (me.user) {
    // 登录用户: 走 accept_invite, 没有房间时此刻才创建
    ensureConn(() => ws.send(JSON.stringify({ t: 'accept_invite', from })));
  } else if (code) {
    const name = myName() || '玩家';
    ensureConn(() => ws.send(JSON.stringify({ t: 'join', code, name })));
  } else {
    toast('请先登录再接受邀请');
  }
};
$('btnInviteIgnore').onclick = () => $('inviteModal').classList.add('hidden');

/* ---- 规则弹窗 ---- */
$('btnRules').onclick = () => $('rulesModal').classList.remove('hidden');
$('btnRulesClose').onclick = () => $('rulesModal').classList.add('hidden');

/* ---- 全屏 ---- */
function toggleFs() {
  const el = document.documentElement;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
    return;
  }
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (fn) { try { const r = fn.call(el); if (r && r.catch) r.catch(() => {}); } catch (e) {} }
  // v6.6.33: 全屏后尝试锁横屏 — Android 部分浏览器支持; 微信/iOS 会拒绝, catch 静默 (竖屏双布局兜底)
  try {
    if (screen.orientation && screen.orientation.lock) {
      const p = screen.orientation.lock('landscape');
      if (p && p.catch) p.catch(() => {});
    }
  } catch (e) {}
}
['btnFs', 'btnFs2', 'btnFs3'].forEach(id => { $(id).onclick = toggleFs; });
if (!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)) {
  ['btnFs', 'btnFs2', 'btnFs3'].forEach(id => $(id).classList.add('hidden')); // iOS Safari 不支持
}

(function tryResume() {
  const s = localStorage.getItem('mj_session');
  if (s) {
    try {
      const { code, sid } = JSON.parse(s);
      me.code = code; me.sid = sid;
      connect(() => ws.send(JSON.stringify({ t: 'rejoin', code, sid })));
      return;
    } catch (e) {}
  }
  // 没有房间会话也要自动恢复登录 (否则每次打开都要重新登录)
  if (loadAuth()) connect(null);
})();

/* ================= 大厅 ================= */
// 是否有管理权(房主或管理员): 可踢人/解散
function hasPower(rs) {
  if (!rs) return false;
  return rs.seat === rs.hostSeat || !!(rs.admins && rs.admins[rs.seat]);
}
function renderLobby() {
  if (!roomState) return;
  const spectating = !!me.spectator;
  if ((roomState.state === 'playing' || roomState.state === 'over') && !spectating) { show('game'); return; }
  // 观战者始终停留在大厅页, 看得到房间成员, 下一局自动转正
  show('lobby');
  $('lobbyCode').textContent = roomState.code;
  $('lobbySpect').classList.toggle('hidden', !spectating);
  const ul = $('lobbyPlayers');
  ul.innerHTML = '';
  const isHost = roomState.seat === roomState.hostSeat;
  const power = hasPower(roomState);
  const admins = roomState.admins || [];
  roomState.players.forEach((p, i) => {
    const li = document.createElement('li');
    li.dataset.pact = i; // 互动动画的头像定位锚点 (v6.6.29)
    li.textContent = `${WINDS[i % 4]}位 · ${p.name}${p.bot ? '(机器人)' : ''}${i === roomState.hostSeat ? '(房主)' : ''}${admins[i] ? '(管理员)' : ''}${i === roomState.seat ? '(你)' : ''}${!p.bot && !p.online ? '(离线)' : ''}`;
    // 点玩家行 → 互动弹框 (发消息/送花/扔鸡蛋, v6.6.26); 自己和机器人不弹
    if (!p.bot && i !== roomState.seat) {
      li.style.cursor = 'pointer';
      li.title = '点击互动';
      li.onclick = (e) => { if (e.target.tagName === 'BUTTON') return; openPlayerAct(i, p.name, p.online); };
    }
    // 房主在大厅可单独移除某个机器人
    if (p.bot && isHost && roomState.state === 'lobby') {
      const rm = document.createElement('button');
      rm.className = 'mini bot-rm';
      rm.textContent = '移除';
      rm.onclick = () => { if (wsAlive()) ws.send(JSON.stringify({ t: 'remove_bot', seatIdx: i })); };
      li.appendChild(rm);
    }
    // 离线召回: 提醒掉线的真人玩家回来 (推送+微信)
    if (!p.bot && !p.online && i !== roomState.seat) {
      const rb = document.createElement('button');
      rb.className = 'mini bot-rm';
      rb.textContent = '召回';
      rb.onclick = () => { if (wsAlive()) ws.send(JSON.stringify({ t: 'recall', seat: i })); };
      li.appendChild(rb);
    }
    // 房主/管理员可踢真人玩家 (机器人用"移除"; 牌局中在管理面板踢, 本局作废)
    if (power && i !== roomState.seat && !p.bot) {
      const kb = document.createElement('button');
      kb.className = 'mini bot-rm';
      kb.textContent = '请出';
      kb.onclick = () => { if (confirm(`把 ${p.name} 请出房间?`)) ws.send(JSON.stringify({ t: 'kick', seat: i })); };
      li.appendChild(kb);
    }
    ul.appendChild(li);
  });
  $('btnStart').classList.toggle('hidden', !isHost);
  $('lobbyWait').classList.toggle('hidden', isHost || spectating);
  $('btnStart').disabled = roomState.players.length < 2;
  // 解散入口统一收进"房间管理"面板; 原退出按钮改为管理入口(全员可用)
  $('btnDissolve').classList.add('hidden');
  $('btnLeaveRoom').classList.remove('hidden');
  $('btnLeaveRoom').textContent = '⚙ 房间管理';
  // 机器人: 房主在大厅可添加(每种可重复加, 1人也能和机器人玩); 观战时全部隐藏
  const hideForSpect = spectating || roomState.players.length >= 4;
  $('btnAddBot0').classList.toggle('hidden', !isHost || hideForSpect);
  $('btnAddBot1').classList.toggle('hidden', !isHost || hideForSpect);
  $('btnAddBot2').classList.toggle('hidden', !isHost || hideForSpect);
  // 邀请好友: 全员可用(登录 + 未满员)
  $('btnInviteF').classList.toggle('hidden', !me.user || roomState.players.length >= 4);
}
$('btnStart').onclick = () => ws.send(JSON.stringify({ t: 'start' }));
$('btnAddBot0').onclick = () => { if (wsAlive()) ws.send(JSON.stringify({ t: 'add_bot', bot: 0 })); };
$('btnAddBot1').onclick = () => { if (wsAlive()) ws.send(JSON.stringify({ t: 'add_bot', bot: 1 })); };
$('btnAddBot2').onclick = () => { if (wsAlive()) ws.send(JSON.stringify({ t: 'add_bot', bot: 2 })); };
$('btnLeaveRoom').onclick = () => { renderManage(); $('manageModal').classList.remove('hidden'); }; // 大厅"房间管理"入口
$('btnDissolve').onclick = () => { if (wsAlive()) ws.send(JSON.stringify({ t: 'dissolve_room' })); };
// 牌桌顶栏: 全员一个"管理"按钮, 打开房间管理面板 (邀请/退出/申请管理员; 房主·管理员另有请出/解散)
$('btnQuitGame').onclick = () => {
  renderManage();
  $('manageModal').classList.remove('hidden');
};
// 房间管理面板: 房号(可复制) + 玩家列表(请出/加好友) + 好友区(申请/邀请) + 申请管理员 + 解散 + 退出
function renderManage() {
  const ul = $('manageList');
  ul.innerHTML = '';
  const players = (roomState && roomState.players) || [];
  const admins = (roomState && roomState.admins) || [];
  const power = hasPower(roomState);
  // 房间号: 任何人都能看到并复制, 别人凭房号在首页加入
  $('manageCode').textContent = (roomState && roomState.code) || '----';
  players.forEach((p, i) => {
    const li = document.createElement('li');
    const isMe = roomState && i === roomState.seat;
    const tag = i === roomState.hostSeat ? ' 👑' : admins[i] ? ' 🛡' : '';
    li.innerHTML = `<span>${escapeHtml(p.name || '?')}${p.bot ? '(机器人)' : ''}${tag}${isMe ? '(我)' : ''}${!p.bot && !p.online ? ' (离线)' : ''}</span>`;
    if (!isMe && power) {
      const kb = document.createElement('button');
      kb.className = 'mini bot-rm';
      kb.textContent = '请出';
      kb.onclick = () => {
        const midHand = roomState && roomState.state === 'playing';
        if (!confirm(`把 ${p.name} 请出房间?${midHand ? ' 本局将作废(不算钱), 剩下的人可以继续' : ''}`)) return;
        if (wsAlive()) ws.send(JSON.stringify({ t: 'kick', seat: i }));
        $('manageModal').classList.add('hidden');
      };
      li.appendChild(kb);
    }
    // 牌局里直接加好友: 登录用户可对同房真人(非自己/非机器人/非已有好友)发起好友申请
    const isFriend = !!(me.user && p.user && friendsData.friends.some(f => f.user === p.user));
    if (!isMe && !p.bot && p.user && me.user && p.user !== me.user && !isFriend) {
      const fb = document.createElement('button');
      fb.className = 'mini primary';
      fb.textContent = '＋好友';
      fb.onclick = () => {
        fb.textContent = '已发'; fb.disabled = true;
        sendFriendRequest(p.user);
      };
      li.appendChild(fb);
    }
    ul.appendChild(li);
  });
  // 邀请好友进房: 未登录或满员时隐藏 (对局中邀请, 对方进来先旁观, 下一局入座)
  $('btnManageInvite').classList.toggle('hidden', !me.user || players.length >= 4);
  // 加好友输入行: 未登录隐藏
  $('manageFriendInput').parentElement.classList.toggle('hidden', !me.user);
  // 申请管理员: 房主/已有权限/观战时隐藏
  $('btnManageApply').classList.toggle('hidden',
    !roomState || roomState.seat === roomState.hostSeat || (admins[roomState.seat] && power) || !!me.spectator);
  // 解散: 房主/管理员
  $('btnManageDissolve').classList.toggle('hidden', !power);
  // 加AI: 仅房主, 未满员 (对局中也可加, 服务器自动补牌)
  $('manageBotsRow').style.display = (roomState && roomState.seat === roomState.hostSeat && players.length < 4) ? '' : 'none';
  renderManageFriends();
}

// 管理面板好友区: 收到的申请(同意/拒绝) + 好友列表(状态 + 邀请进房)
function renderManageFriends() {
  const ul = $('manageFriendList');
  if (!ul) return;
  ul.innerHTML = '';
  if (!me.user) { ul.innerHTML = '<li class="empty">登录后可加好友/邀请好友</li>'; return; }
  const roomFull = roomState && roomState.players.length >= 4;
  friendsData.requests.forEach(r => {
    const li = document.createElement('li');
    li.className = 'friend req';
    const sp = document.createElement('span');
    sp.className = 'fname'; sp.textContent = `📨 ${r.name} 请求加你为好友`;
    const ok = document.createElement('button'); ok.className = 'mini primary'; ok.textContent = '同意';
    ok.onclick = () => ws.send(JSON.stringify({ t: 'accept_friend', user: r.user }));
    const no = document.createElement('button'); no.className = 'mini'; no.textContent = '拒绝';
    no.onclick = () => ws.send(JSON.stringify({ t: 'decline_friend', user: r.user }));
    li.appendChild(sp); li.appendChild(ok); li.appendChild(no);
    ul.appendChild(li);
  });
  friendsData.friends.forEach(f => {
    const li = document.createElement('li');
    li.className = 'friend';
    const st = f.online ? (f.room ? '🀄 在房间' : '🟢 在线') : '⚪ 离线';
    const sp = document.createElement('span');
    sp.className = 'fname'; sp.textContent = f.name;
    const ss = document.createElement('span');
    ss.className = 'fstatus' + (f.online ? ' on' : ''); ss.textContent = st;
    li.appendChild(sp); li.appendChild(ss);
    const inv = document.createElement('button');
    inv.className = 'mini primary'; inv.textContent = '邀请';
    if (roomFull) { inv.disabled = true; inv.textContent = '满员'; }
    else inv.onclick = () => { inv.textContent = '已发'; inv.disabled = true; inviteFriend(f.user); };
    li.appendChild(inv);
    ul.appendChild(li);
  });
  if (!friendsData.friends.length && !friendsData.requests.length) {
    ul.innerHTML = '<li class="empty">还没有好友: 输入账号添加, 或点上面玩家旁的「＋好友」</li>';
  }
}
// 管理面板加AI (对局中也可, 服务端自动补牌)
$('btnMBot0').onclick = () => { if (wsAlive()) ws.send(JSON.stringify({ t: 'add_bot', bot: 0 })); };
$('btnMBot1').onclick = () => { if (wsAlive()) ws.send(JSON.stringify({ t: 'add_bot', bot: 1 })); };
$('btnMBot2').onclick = () => { if (wsAlive()) ws.send(JSON.stringify({ t: 'add_bot', bot: 2 })); };

$('btnManageInvite').onclick = () => {
  if (!me.user) return toast('登录后才能邀请好友, 首页可注册');
  if (roomState && roomState.players.length >= 4) return toast('房间已满(4人), 不能邀请');
  if (!wsAlive()) return toast('连接中, 请稍候…');
  renderPickList();
  $('pickModal').classList.remove('hidden');
};
$('btnManageCloseX').onclick = () => $('manageModal').classList.add('hidden');
$('btnManageClose').onclick = () => $('manageModal').classList.add('hidden');
// 一键复制房间号 (分享给别人, 对方首页输入房号加入)
$('btnCopyCode').onclick = () => {
  if (!roomState || !roomState.code) return toast('还没有房间号');
  copyText(String(roomState.code), `房间号 ${roomState.code} 已复制`);
};
// 管理面板内加好友 (输账号发申请, 对方同意后这里和首页好友列表都会出现)
$('btnManageAddFriend').onclick = () => {
  const u = $('manageFriendInput').value.trim();
  sendFriendRequest(u);
  $('manageFriendInput').value = '';
};
$('manageFriendInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('btnManageAddFriend').click(); }
});
$('btnManageApply').onclick = () => {
  if (!wsAlive()) return toast('连接中, 请稍候…');
  $('manageModal').classList.add('hidden');
  ws.send(JSON.stringify({ t: 'apply_admin' }));
};
$('btnManageLeave').onclick = () => {
  const isHost = roomState && roomState.seat === roomState.hostSeat;
  if (!confirm(isHost ? '确定退出房间? 房主将自动交给其他人, 你也可以稍后再创建房间'
                      : '确定退出房间? 剩下的牌友可以继续')) return;
  $('manageModal').classList.add('hidden');
  if (wsAlive()) ws.send(JSON.stringify({ t: 'leave_room' }));
};
$('btnManageDissolve').onclick = () => {
  if (!confirm('确定解散房间? 所有人将回到首页')) return;
  $('manageModal').classList.add('hidden');
  if (wsAlive()) ws.send(JSON.stringify({ t: 'dissolve_room' }));
};
// 房主审批管理员申请弹窗
$('btnAdminReqOk').onclick = () => {
  $('adminReqModal').classList.add('hidden');
  if (wsAlive()) ws.send(JSON.stringify({ t: 'admin_reply', accept: true }));
};
$('btnAdminReqNo').onclick = () => {
  $('adminReqModal').classList.add('hidden');
  if (wsAlive()) ws.send(JSON.stringify({ t: 'admin_reply', accept: false }));
};

/* ================= 牌桌 ================= */
function relPos(i, mySeat, n) { return (i - mySeat + n) % n; } // 0=自己 1=下家 2=对家 3=上家
// 2人局对坐；3人局使用左右两个座位；4人局使用上左右三侧
function seatRel(i, mySeat, n) {
  const r = relPos(i, mySeat, n);
  if (n === 2 && r === 1) return 2;
  if (n === 3 && r === 2) return 3;
  return r;
}

// 牌墙: 桌边每侧的牌背数 = 该座位玩家的手牌数; 没人坐的一侧显示灰色
function renderWalls(g) {
  const n = g.players.length;
  const sides = [['wallTop', 2], ['wallRight', 1], ['wallLeft', 3]]; // 对家/下家/上家
  sides.forEach(([id, rel]) => {
    const seat = g.players.findIndex((p, i) => seatRel(i, g.me.seat, n) === rel);
    const w = $(id);
    w.innerHTML = '';
    w.classList.toggle('vacant', seat < 0);
    const cnt = seat >= 0 ? (g.players[seat].handCount || 0) : 13;
    for (let i = 0; i < cnt; i++) {
      const t = document.createElement('div'); t.className = 'wtile'; w.appendChild(t);
    }
  });
}

function renderGame() {
  if (!gameState) return;
  show('game');
  // 顶栏退出/管理按钮: 全员显示"管理", 打开房间管理面板 (邀请/退出/申请管理员)
  const qb = $('btnQuitGame');
  if (roomState) {
    qb.classList.remove('hidden');
    qb.textContent = '管理';
  }
  const g = gameState;
  $('game').dataset.players = g.players.length;
  $('tableFelt').dataset.players = g.players.length;
  document.body.style.setProperty('--my-height', getComputedStyle($('game')).getPropertyValue('--my-height'));
  // v6.6.31: 牌桌顶栏不再显示房间号 (被声音按钮遮挡, 房间管理面板里有完整房号)
  $('tbWild').innerHTML = g.flipped != null
    ? `亮 ${tileName(g.flipped)} · 混儿 <b>${tileName(g.wildFace)}</b>`
    : `混儿 <b>${tileName(g.wildFace)}</b>`;
  $('tbWall').textContent = `第 ${g.round || 1} 局`;

  renderWalls(g);

  // 中央罗盘: 余牌数 + 混儿小牌
  $('cbCount').textContent = g.wallCount;
  const cw = $('compassWild'); cw.innerHTML = '';
  if (g.wildFace != null) cw.appendChild(tileEl(g.wildFace, true));
  const turnRel = g.phase === 'over' ? -1 : seatRel(g.turn, g.me.seat, g.players.length);
  const dealerRel = seatRel(g.dealer, g.me.seat, g.players.length);
  document.querySelectorAll('#compass .wind').forEach(w => {
    const rel = Number(w.dataset.rel);
    w.classList.toggle('active', rel === turnRel);
    w.classList.toggle('dealer', rel === dealerRel);
  });

  // 对手座位：玩家卡片、副露、弃牌永远作为一个整体排布
  const riverTiles = (p, i) => p.river.map((t, k) => {
    if (!t || t.id == null) return '';
    const el = tileEl(t.id, t.wild);
    if (g.lastDiscard && g.lastDiscard.from === i && k === p.river.length - 1) el.classList.add('last');
    return el.outerHTML;
  }).join('');
  const meldView = (p) => p.melds.map(m => {
    const kind = m.type === 'peng' ? '碰' : '吃';
    const fromName = m.from !== undefined && g.players[m.from] ? g.players[m.from].name : '';
    return `<span class="meld-mini" title="${kind}${fromName ? ' · 来自' + escapeHtml(fromName) : ''}"><i class="meld-kind">${kind}</i>${m.tiles.map(id => tileEl(id).outerHTML).join('')}</span>`;
  }).join('');
  const opp = $('opponents');
  opp.innerHTML = '';
  g.players.forEach((p, i) => {
    if (i === g.me.seat) return;
    const d = document.createElement('div');
    const rel = seatRel(i, g.me.seat, g.players.length);
    d.className = `opp opp-${rel}` + (g.turn === i && g.phase !== 'over' ? ' turn' : '') + (p.online ? '' : ' off');
    const dealerTag = i === g.dealer ? '<span class="tag">庄</span>' : '';
    const score = (g.scores && g.scores[i] != null) ? g.scores[i] : 0;
    const safeName = escapeHtml(p.name || '?');
    d.innerHTML = `
      <div class="seat-topline">
        <div class="player-card">
          <div class="avatar" data-pact="${i}" style="cursor:pointer" title="点击互动">${escapeHtml((p.name || '?').slice(0, 1))}</div>
          <div class="opp-mid">
            <div class="oname">${safeName}${dealerTag}${p.online ? '' : ' <span class="tag off" data-recall="' + i + '" style="cursor:pointer" title="点此提醒TA回来(推送+微信)">离线·召回</span>'}</div>
            <div class="coin">${score > 0 ? '+' : ''}${score}</div>
          </div>
        </div>
        <div class="om">${meldView(p)}</div>
      </div>
      <div class="river opp-river">${riverTiles(p, i)}</div>`;
    const rb = d.querySelector('[data-recall]');
    if (rb) rb.onclick = () => { if (wsAlive()) ws.send(JSON.stringify({ t: 'recall', seat: i })); };
    const av = d.querySelector('[data-pact]'); // 点头像 → 互动弹框 (v6.6.26)
    if (av) av.onclick = () => openPlayerAct(i, p.name, p.online);
    opp.appendChild(d);
  });

  // 自己的牌河固定在下方独立区域，即使为空也保留位置
  const ra = $('riverArea');
  ra.innerHTML = '';
  const myRiverP = g.players[g.me.seat];
  const row = document.createElement('div');
  row.className = 'river-row rr-0';
  row.innerHTML = `<div class="river">${riverTiles(myRiverP, g.me.seat)}</div>`;
  ra.appendChild(row);

  const hint = $('turnHint');
  if (g.phase === 'over') hint.textContent = '';
  else if (g.turn === g.me.seat) hint.textContent = g.phase === 'draw' ? '轮到你了' : '轮到你了 · 双击牌打出';
  else {
    const tp = g.players[g.turn];
    hint.textContent = `等待 ${tp.name} 出牌…` + (tp.online ? '' : '（TA已离线, 回来后自动继续）');
    if (!tp.online) { // 等的人掉线 → 附一个召回按钮
      const rb = document.createElement('button');
      rb.className = 'mini bot-rm';
      rb.style.marginLeft = '8px';
      rb.textContent = '📢 召回';
      rb.onclick = () => { if (wsAlive()) ws.send(JSON.stringify({ t: 'recall', seat: g.turn })); };
      hint.appendChild(rb);
    }
  }

  // 自己：紧凑玩家卡片与分组副露
  const myP = g.players[g.me.seat];
  $('myAvatar').textContent = (myP.name || '?').slice(0, 1);
  $('myNameTag').textContent = (myP.name || '我') + ' · 你';
  $('myDealer').classList.toggle('hidden', g.me.seat !== g.dealer);
  const myScore = (g.scores && g.scores[g.me.seat] != null) ? g.scores[g.me.seat] : 0;
  $('myCoin').textContent = `${myScore > 0 ? '+' : ''}${myScore}`;

  const mm = $('myMelds');
  mm.innerHTML = '';
  myP.melds.forEach((m) => {
    const kind = m.type === 'peng' ? '碰' : '吃';
    const group = document.createElement('span');
    group.className = 'meld-mini';
    const fromName = m.from !== undefined && g.players[m.from] ? g.players[m.from].name : '';
    group.title = kind + (fromName ? ' · 来自' + fromName : '');
    const label = document.createElement('i');
    label.className = 'meld-kind';
    label.textContent = kind;
    group.appendChild(label);
    m.tiles.forEach(id => group.appendChild(tileEl(id)));
    mm.appendChild(group);
  });
  if (!myP.melds.length) mm.innerHTML = '<span class="mlabel">未开门 · 吃或碰后可以胡</span>';

  // 手牌: 自动理牌 (混儿在前), 保留原始下标用于出牌
  const hand = g.me.hand.map((t, origIdx) => ({ ...t, origIdx }));
  hand.sort((a, b) => (b.wild ? 1 : 0) - (a.wild ? 1 : 0) || a.id - b.id);
  // 轮到我出牌时, 刚摸的牌固定放最后一张 (混儿牌仍保持在最前)
  const drawn = g.me.lastDraw;
  const isMyDraw = g.phase === 'discard' && g.turn === g.me.seat && !!drawn;
  let movedTile = null;
  if (isMyDraw && !drawn.wild) {
    const di = hand.findIndex(t => t.id === drawn.id);
    if (di >= 0) { movedTile = hand[di]; hand.push(...hand.splice(di, 1)); }
  }
  let wildGapDone = false;
  const mh = $('myHand');
  mh.innerHTML = '';
  hand.forEach((t, dispIdx) => {
    const el = tileEl(t.id, t.wild);
    // 刚摸的那张和前面拉开一点距离 (摸到的混儿在最前也适用)
    if ((isMyDraw && t === movedTile) ||
        (isMyDraw && drawn.wild && t.wild && t.id === drawn.id && !wildGapDone)) {
      if (dispIdx > 0) el.classList.add('drawn');
      if (t !== movedTile) wildGapDone = true;
    }
    if (dispIdx === selected) el.classList.add('sel');
    el.onclick = () => onTileTap(dispIdx, t.origIdx);
    mh.appendChild(el);
  });

  renderActionBar();
}

function onTileTap(dispIdx, origIdx) {
  const g = gameState;
  if (g.phase === 'over') return;
  if (selected === dispIdx) {          // 第二次点同一张 = 打出 (仅轮到我出牌时可打)
    if (g.phase !== 'discard' || g.turn !== g.me.seat) return;
    ws.send(JSON.stringify({ t: 'discard', idx: origIdx }));
    selected = -1;
  } else {
    // 任何时刻都能选中/抬起看牌; 轮到自己时第二次点即打出 (v6.6.18)
    selected = dispIdx;
    playOp('SpecSelectCard'); // 选牌音
    renderGame();
  }
}

function renderActionBar() {
  const bar = $('actionBar');
  bar.innerHTML = '';
  const g = gameState;
  if (g.phase === 'over') { bar.classList.add('hidden'); return; }
  let has = false;
  const mk = (text, cls, fn, noop) => { // noop=true: 自带语音/牌声反馈, 跳过全局 SpecOk 按钮音 (v6.6.21)
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = text; b.onclick = fn;
    if (noop) b.dataset.noop = '1';
    return b;
  };
  if (g.myClaim && g.phase === 'claim') {
    has = true;
    if (g.myClaim.hu) bar.appendChild(mk('胡!', 'hu', () => ws.send(JSON.stringify({ t: 'action', act: 'hu' })), true));
    if (g.myClaim.peng) bar.appendChild(mk('碰', 'peng', () => ws.send(JSON.stringify({ t: 'action', act: 'peng' })), true));
    if (g.myClaim.chi && g.myClaim.chi.length) {
      g.myClaim.chi.forEach((o) => {
        bar.appendChild(mk(`吃 ${tileName(o[0])} ${tileName(o[1])}`, 'chi',
          () => ws.send(JSON.stringify({ t: 'action', act: 'chi', tiles: o })), true));
      });
    }
    bar.appendChild(mk('过', 'pass', () => ws.send(JSON.stringify({ t: 'action', act: 'pass' })), true));
  }
  if (g.phase === 'discard' && g.turn === g.me.seat && g.me.canHu) {
    has = true;
    bar.appendChild(mk('自摸胡!', 'hu', () => ws.send(JSON.stringify({ t: 'action', act: 'hu' })), true));
  }
  bar.classList.toggle('hidden', !has);
}

/* ================= 结算 ================= */
function showResult(r) {
  const modal = $('resultModal');
  modal.classList.remove('hidden');
  if (r.draw) {
    $('resTitle').textContent = r.voidMsg ? '⏹ 本局作废' : '🤝 流局 (牌摸完了)';
    $('resDetail').innerHTML = r.voidMsg ? `<div>${r.voidMsg}</div><div>不算钱, 点「下一局」继续</div>` : '本局无人胡牌, 不算钱';
    $('resHand').innerHTML = '';
  } else {
    const conds = [];
    if (r.zhuang) conds.push('庄家');
    if (r.qiong) conds.push('穷胡');
    if (r.selfDraw) conds.push('自摸');
    if (!r.selfDraw && r.dianpaoName) conds.push(r.dianpaoName + ' 点炮');
    $('resTitle').textContent = `🎉 ${r.winnerName} ${r.daHu ? '大胡' : '胡了'}!`;
    $('resDetail').innerHTML = `<div>${r.desc.text}${conds.length ? ' · ' + conds.join(' · ') : ''}</div>`;
    const rh = $('resHand');
    rh.innerHTML = '';
    (r.hand || []).forEach(t => rh.appendChild(tileEl(t.id, t.wild)));
  }
  const tot = $('resTotals');
  tot.innerHTML = '';
  if (!r.draw || !r.voidMsg) (roomState ? roomState.players : []).forEach((p, i) => {
    const d = r.deltas ? r.deltas[i] : 0;
    const line = document.createElement('div');
    const isWinner = !r.draw && r.winner === i;
    const isDp = !r.draw && !r.selfDraw && r.dianpaoIdx === i;
    line.innerHTML = `<span>${p.name}${isWinner ? ' 🀄' : ''}${isDp ? ' (点炮)' : ''}</span>
      <span class="${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}">${d > 0 ? '+' : ''}${d} 元</span>`;
    tot.appendChild(line);
  });
  $('btnNext').onclick = () => {
    modal.classList.add('hidden');
    ws.send(JSON.stringify({ t: 'next_round' }));
  };
  // 局间入口: 统一打开房间管理面板 (里面有邀请/退出/申请管理员/解散)
  $('btnQuitAfter').textContent = '⚙ 房间管理';
  $('btnQuitAfter').onclick = () => {
    modal.classList.add('hidden');
    renderManage();
    $('manageModal').classList.remove('hidden');
  };
}

// ================= 背景音乐 (WebAudio 合成, 无需音频文件, 随时开关) =================
let bgm = null;
let bgmOn = false;
function bgmInit() {
  if (bgm) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  const ctx = new AC();
  const master = ctx.createGain();
  master.gain.value = 0.14;   // 整体音量, 克制一点不吵人
  master.connect(ctx.destination);
  bgm = { ctx, master, timer: null, step: 0 };
  return true;
}
let bgmStyle = 'classic';
try {
  const st = localStorage.getItem('mj_bgm_style');
  if (st === 'gufeng' || st === 'fest') bgmStyle = 'fest'; // 旧值 gufeng 兼容映射为节庆曲库
} catch (e) {}
// 节庆内置曲库: 大厅曲 + 对局曲两套, 一段放完 → 随机换同套另一首 → 循环往复
const FEST_LOBBY = ['lobby', 'track_09', 'track_08'];
const FEST_GAME = ['game', 'track_01', 'track_02', 'track_03', 'track_04', 'track_05', 'track_06', 'track_07'];
let festAudio = null;
let festCur = ''; // 当前正在放的节庆曲 (不含扩展名)
function festPool() {
  const scr = document.querySelector('.screen.active');
  return (scr && scr.id === 'game') ? FEST_GAME : FEST_LOBBY;
}
function festPlay(track) {
  festCur = track;
  festAudio.src = 'music/' + track + '.mp3';
  festAudio.play().catch(() => {});
}
function festStart() {
  if (!festAudio) {
    festAudio = new Audio();
    festAudio.volume = 0.4 * musicGain();
    festAudio.preload = 'auto';
    // 一段放完 → 随机换当前场景曲库里的另一首 (不和当前重复) → 循环往复
    festAudio.addEventListener('ended', () => {
      if (!bgmOn || !musicOn || bgmStyle !== 'fest') return;
      const pool = festPool().filter(t => t !== festCur);
      festPlay(pool[Math.floor(Math.random() * pool.length)]);
    });
  }
  festAudio.loop = false;
  const pool = festPool();
  const cand = festCur && pool.includes(festCur) ? pool.filter(t => t !== festCur) : pool;
  festPlay(cand[Math.floor(Math.random() * cand.length)]);
}
function festStop() {
  if (festAudio) { try { festAudio.pause(); } catch (e) {} }
}
window.__mjAudio = () => ({ // 调试: 远程检查播放状态
  style: bgmStyle, bgmOn, musicOn, fxReal,
  classic: classicAudio ? { src: classicAudio.src.split('/').pop(), paused: classicAudio.paused, t: classicAudio.currentTime, intense: classicIntense } : null,
  fest: festAudio ? { src: festAudio.src.split('/').pop(), paused: festAudio.paused, t: festAudio.currentTime } : null,
  fx: Object.entries(fxCache).map(([k, a]) => k + ':' + (a.paused ? 'idle@' + a.currentTime.toFixed(1) : 'playing@' + a.currentTime.toFixed(1))),
  voice: { unlocked: voiceUnlocked, els: voiceEls.map(a => (a.paused ? 'i' : 'P') + (a.__never ? 'n' : '') + '@' + a.currentTime.toFixed(1)) }
});
// 内置经典曲库: HTMLAudio 播放。大厅循环放大厅曲; 对局开始/对局里刚开声音 → 先播
// 对局曲1, 之后和对局曲2随机切; 自己上听后 → 立即切激昂版, 之后和对局曲2随机切 (激昂/2)
let classicAudio = null;
let classicCur = ''; // 当前正在播放的曲目 (不含扩展名)
const CLASSIC_LOBBY = 'track_10';        // 大厅曲 (循环)
const CLASSIC_NORMAL = ['track_11', 'track_12'];  // 对局普通曲池: 对局曲1/2
const CLASSIC_INTENSE = ['track_13', 'track_12']; // 对局上听曲池: 激昂版/对局曲2
let classicIntense = false;               // 我已上听 → 对局里用上听曲池
function classicPool() { return classicIntense ? CLASSIC_INTENSE : CLASSIC_NORMAL; }
function classicInGame() {
  const scr = document.querySelector('.screen.active');
  return !!(scr && scr.id === 'game');
}
function classicStart() {
  if (!classicAudio) {
    classicAudio = new Audio();
    classicAudio.volume = 0.4 * musicGain();
    classicAudio.preload = 'auto';
    // 对局里一段放完 → 随机换当前曲池里的另一首 (不和当前重复) → 循环往复 (大厅曲靠 loop, 不会走到这)
    classicAudio.addEventListener('ended', () => {
      if (!bgmOn || !musicOn || bgmStyle !== 'classic' || !classicInGame()) return;
      const next = classicPool().filter(t => t !== classicCur);
      classicPlay(next[Math.floor(Math.random() * next.length)]);
    });
  }
  // 大厅: 大厅曲循环播放
  if (!classicInGame()) {
    classicAudio.loop = true;
    classicPlay(CLASSIC_LOBBY);
    return;
  }
  // 对局: 全新起播先对局曲1 (已上听则直接激昂版); 补播续放当前这首
  classicAudio.loop = false;
  if (!classicCur || classicCur === CLASSIC_LOBBY) { classicPlay(classicIntense ? CLASSIC_INTENSE[0] : CLASSIC_NORMAL[0]); return; }
  classicPlay(classicCur);
}
function classicPlay(track) {
  classicCur = track;
  classicAudio.src = 'music/' + track + '.mp3';
  classicAudio.play().catch(() => {});
}
function classicStop() {
  if (classicAudio) { try { classicAudio.pause(); } catch (e) {} }
  classicCur = ''; // 停掉即清当前曲: 下次开启按"全新起播"走 (对局里先对局曲1)
}
// 结算 (v6.6.42): 播胜利/失败曲前停掉对局曲池 (清 classicCur + 回普通曲池); 结算曲 ended 后由 playResultMusic 从普通曲池重新起播
function classicHaltFor() {
  if (bgmStyle !== 'classic') return;
  classicIntense = false;
  if (classicAudio) { try { classicAudio.pause(); } catch (e) {} }
  classicCur = '';
}
// 场景切换联动 (show() 调用): 进对局时大厅曲/空 → 切对局曲1起 (已上听则激昂版);
// 回大厅 → 切大厅曲循环; 对局曲进行中进出不打断
function classicSyncScene() {
  if (bgmStyle !== 'classic' || !bgmOn || !musicOn) return;
  if (!classicAudio || classicAudio.paused) return; // 没在放: 交给手势兜底的 classicStart 按场景起播
  if (classicInGame()) {
    if (classicCur && classicCur !== CLASSIC_LOBBY) return; // 对局曲进行中, 不打断
    classicAudio.loop = false;
    classicPlay(classicIntense ? CLASSIC_INTENSE[0] : CLASSIC_NORMAL[0]);
  } else {
    if (classicCur === CLASSIC_LOBBY) return;
    classicAudio.loop = true;
    classicPlay(CLASSIC_LOBBY);
  }
}
// 上听 BGM 联动 (每次收到牌局状态时调用): 自己上听 → 立即切激昂版;
// 掉听/新局未听 → 回普通曲池 (不打断当前曲, 下一首起生效);
// 轮到自己出牌时服务端不算 tingReady (状态未知) → 保持现状, 防止每回合来回切
function syncClassicIntense(m) {
  const mine = m && m.me;
  if (!mine) return;
  if (mine.tingReady == null) {
    // 非自己回合 (手牌 3k+1 口径) 却拿到 null = 服务端确认没上听 → 掉听回普通曲池 (不打断当前曲, 下一首起生效)
    // 自己回合 (3k+2) 服务端不算 tingReady (状态未知) → 保持现状, 防止每回合来回切
    if (mine.hand && mine.hand.length % 3 === 1 && classicIntense) classicIntense = false;
    return;
  }
  const intense = !!(mine.tingReady && mine.tingReady.length);
  if (intense === classicIntense) return;
  classicIntense = intense;
  if (intense && bgmStyle === 'classic' && bgmOn && musicOn && classicAudio && !classicAudio.paused && classicInGame()) classicPlay(CLASSIC_INTENSE[0]);
}
function setBgm(on) {
  bgmOn = on;
  try { localStorage.setItem('mj_bgm', on ? '1' : '0'); } catch (e) {}
  if (on) musicStart();
  else { musicStop(); if ('speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (e) {} } }
  $('bgmFab').textContent = on ? '🔊' : '🔇';
  syncSoundModal();
}
// 背景音乐 (含赢/输/流局音乐): 音量滑条 0-100, 0 = 关 (兼容旧开关 mj_music)
let musicVol = 40;
try {
  const sv = localStorage.getItem('mj_music_vol');
  if (sv !== null) musicVol = Math.max(0, Math.min(100, parseInt(sv, 10) || 0));
  else if (localStorage.getItem('mj_music') === '0') musicVol = 0;
} catch (e) {}
let musicOn = musicVol > 0;
function musicGain() { return musicVol / 100; }
function setMusicVol(v) {
  musicVol = Math.max(0, Math.min(100, v | 0));
  musicOn = musicVol > 0;
  try { localStorage.setItem('mj_music_vol', String(musicVol)); } catch (e) {}
  if (classicAudio) classicAudio.volume = 0.4 * musicGain(); // 正在放曲子时实时调音量
  if (festAudio) festAudio.volume = 0.4 * musicGain();
  if (musicOn) musicStart(); else musicStop();
  syncSoundModal();
}
function musicStart() {
  if (!bgmOn || !musicOn) return;
  if (bgmStyle === 'classic') { classicStart(); return; }  // 内置曲库走 HTMLAudio
  if (bgmStyle === 'fest') { festStart(); return; } // 节庆内置曲库走 HTMLAudio
  if (!bgmInit()) return;
  if (bgm.ctx.state !== 'running') bgm.ctx.resume(); // v6.6.43: 覆盖 interrupted
}
function musicStop() {
  classicStop();
  festStop();
  if (bgm) { clearTimeout(bgm.timer); bgm.timer = null; }
}
// 语音播报 (念牌名/吃/碰/胡): 音量滑条 0-100, 0 = 关 (兼容旧开关 mj_voice_on)
let voiceVol = 100;
try {
  const sv = localStorage.getItem('mj_voice_vol');
  if (sv !== null) voiceVol = Math.max(0, Math.min(100, parseInt(sv, 10) || 0));
  else if (localStorage.getItem('mj_voice_on') === '0') voiceVol = 0;
} catch (e) {}
let voiceOn = voiceVol > 0;
function voiceGain() { return voiceVol / 100; }
function setVoiceVol(v) {
  voiceVol = Math.max(0, Math.min(100, v | 0));
  voiceOn = voiceVol > 0;
  try { localStorage.setItem('mj_voice_vol', String(voiceVol)); } catch (e) {}
  if (!voiceOn && 'speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (e) {} }
  syncSoundModal();
}
// 浏览器要求有声交互后才能播音。注意不能用 once 监听: 第一次触摸若是滑动/滚动,
// play() 会被静默拒绝且监听器已消耗, 之后永远没有重试 → 表现为"进游戏没音乐"。
// 因此改为每次触摸都兜底: 没开就开; 开了但没真正响起来 (首播被拒/被暂停) 就补启。
// 注意绑全 touchstart/pointerdown/click: 部分移动端浏览器首次交互只派发其中一种
['touchstart', 'pointerdown', 'click'].forEach(ev => document.addEventListener(ev, () => {
  let pref = '1';
  try { pref = localStorage.getItem('mj_bgm') || '1'; } catch (e) {}
  if (pref !== '1') return;
  if (!bgmOn) { setBgm(true); return; }
  if (!musicOn) return;
  if (bgmStyle === 'classic') {
    if (!classicAudio || classicAudio.paused) classicStart(); // 首播被浏览器拒绝过的, 在真实手势里补播
  } else if (bgmStyle === 'fest') {
    if (!festAudio || festAudio.paused) festStart();
  }
  // 音效上下文: 两种 BGM 都走 HTMLAudio 后, 合成音效 (出牌嗒声/胡牌/流局音) 依赖的
  // AudioContext 不再被 BGM 顺带初始化, 必须在真实手势里创建+恢复, 否则手机上永远 suspended 无声
  if (!bgm) bgmInit();
  if (bgm && bgm.ctx.state !== 'running') { try { bgm.ctx.resume(); } catch (e) {} } // v6.6.43: 覆盖 interrupted
}));
$('bgmFab').onclick = (e) => {
  e.stopPropagation();
  $('soundModal').classList.remove('hidden');
};

// ================= 声音设置 (点喇叭弹出; 绑定在文件尾初始化) =================
function setVoiceGender(g) {
  voiceGender = g;
  voicePool = {}; // 清缓存, 立即换音色
  try { localStorage.setItem('mj_voice', g); } catch (e) {}
  document.querySelectorAll('#voiceSel .btn').forEach(b =>
    b.classList.toggle('primary', b.dataset.v === g));
  // 上报服务器: 让所有人都用"我的声音"播报我的动作
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ t: 'set_voice', voice: g })); } catch (e) {}
  }
}
function setBgmStyle(s) {
  bgmStyle = s;
  try { localStorage.setItem('mj_bgm_style', s); } catch (e) {}
  document.querySelectorAll('#bgmSel .btn').forEach(b =>
    b.classList.toggle('primary', b.dataset.b === s));
  // 正在放音乐时切换风格: 停掉旧曲再按新风格起
  if (bgmOn && musicOn) {
    musicStop();
    if (s === 'classic') classicStart();
    else if (s === 'fest') festStart();
  }
}
function syncVolFill(el) { if (el) el.style.setProperty('--fill', el.value + '%'); }
function syncSoundModal() {
  const b = $('btnSndToggle');
  if (b) b.textContent = bgmOn ? '🔊 声音已开启（点击关闭）' : '🔇 全部声音已关闭（点击开启）';
  const m = $('musicVol');
  if (m) { m.value = musicVol; syncVolFill(m); }
  const ml = $('musicVolLabel');
  if (ml) ml.textContent = musicVol > 0 ? '🎵 背景音乐：' + musicVol + '%（含赢输音乐）' : '🎵 背景音乐：已关闭（拖到最左为关）';
  const v = $('voiceVol');
  if (v) { v.value = voiceVol; syncVolFill(v); }
  const vl = $('voiceVolLabel');
  if (vl) vl.textContent = voiceVol > 0 ? '🗣 语音播报：' + voiceVol + '%' : '🗣 语音播报：已关闭（拖到最左为关）';
  const fx = $('btnFxReal');
  if (fx) fx.textContent = fxReal ? '🀄 牌声：开（和牌音效）' : '🀄 牌声：关';
  const op = $('btnOpSfx');
  if (op) op.textContent = opSfxOn ? '👆 选牌/操作音效：开' : '👆 选牌/操作音效：关';
  const cq = $('btnChatQuick');
  if (cq) cq.textContent = chatQuickOn ? '💬 聊天语录语音：开' : '💬 聊天语录语音：关';
}

// ================= 语音播报 + 游戏音效 (TTS + WebAudio, 随背景音乐开关统一控制) =================
let zhVoice = null;
let ttsUnlocked = false;
function pickVoice() {
  try {
    const vs = speechSynthesis.getVoices();
    zhVoice = vs.find(v => /zh[-_]CN/i.test(v.lang)) || vs.find(v => /^zh/i.test(v.lang)) || null;
  } catch (e) {}
}
if ('speechSynthesis' in window) {
  pickVoice();
  if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = pickVoice;
}
// 手机浏览器要求: 语音必须在用户手势里先"空读"一次才允许出声, 首次触摸时解锁
function unlockTTS() {
  if (ttsUnlocked || !('speechSynthesis' in window)) return;
  ttsUnlocked = true;
  pickVoice();
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.lang = 'zh-CN';
    if (zhVoice) u.voice = zhVoice;
    u.volume = 0.01; // 近乎静音, 只为解锁引擎
    speechSynthesis.speak(u);
  } catch (e) {}
}
['touchstart', 'pointerdown', 'click'].forEach(ev =>
  document.addEventListener(ev, unlockTTS, { passive: true }));
['touchstart', 'pointerdown', 'click'].forEach(ev =>
  document.addEventListener(ev, unlockVoicePool, { passive: true }));
['touchend', 'mouseup'].forEach(ev =>
  document.addEventListener(ev, unlockTTS, { passive: true }));
// 念牌名 (口语化: 一条 → 幺鸡)
function tileVoiceName(id) {
  if (id === 18) return '幺鸡';
  return tileName(id);
}
// 预录语音映射 (文本 → voice/{m|f}/ 目录 mp3, 不依赖手机系统语音引擎)
// 每个词条有多个变体: 基础名 + b(激昂) [+ c], 随机抽取避免听腻
let voiceGender = 'f'; // 我的声音, 默认女声, 播报我出的牌时用
try { voiceGender = localStorage.getItem('mj_voice') === 'm' ? 'm' : 'f'; } catch (e) {}
const VOICE_FILES = {};
for (let i = 1; i <= 9; i++) {
  VOICE_FILES[NUM_CHARS[i - 1] + '万'] = 'wan' + i;
  VOICE_FILES[NUM_CHARS[i - 1] + '饼'] = 'bing' + i;
}
VOICE_FILES['幺鸡'] = 'yaoji';
for (let i = 2; i <= 9; i++) VOICE_FILES[NUM_CHARS[i - 1] + '条'] = 'tiao' + i;
[['东','dong'],['南','nan'],['西','xi'],['北','bei'],['中','zhong'],['发','fa'],['白','bai']]
  .forEach(p => { VOICE_FILES[p[0]] = p[1]; });
VOICE_FILES['碰！'] = 'peng';
VOICE_FILES['吃！'] = 'chi';
VOICE_FILES['我胡啦！'] = 'hu';
const VOICE_VARIANTS = { hu: 3 }; // hu 有 3 个变体, 其余 2 个
let voicePool = {};
// ---- 预解锁语音播放池 (修"经常听不到出牌语音") ----
// 手机浏览器要求每个 Audio 元素在用户手势里启动过一次才允许程序播放;
// 之前按文件懒创建的元素第一次 play() 常被静默拒绝。改为首次触摸时统一解锁 4 个轮换元素。
const VOICE_POOL_N = 4;
let voiceEls = [];
let voiceElsIdx = 0;
let voiceUnlocked = false;
let voiceWarmed = false;
// 0.05 秒静音 wav (运行时生成 data URI, 不发网络请求): 语音池解锁专用。
// iOS 等浏览器对"无 src 元素"的 play() 直接 NotSupportedError 拒绝, 根本没解锁,
// 之后正式语音全被拒 → 表现为语音消失。必须带真实可解码的 src 去 play 才算解锁成功。
const SILENT_WAV = (() => {
  const sr = 8000, n = 400;
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * 2, true);
  return 'data:audio/wav;base64,' + btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
})();
function unlockVoicePool() {
  if (!voiceUnlocked) {
    voiceUnlocked = true;
    for (let i = 0; i < VOICE_POOL_N; i++) {
      const a = new Audio();
      a.preload = 'auto';
      a.muted = true;
      a.__never = true; // 从未成功启动过播放
      // 真实开始播放就是解锁成功的铁证 (promise 在手势并发时可能挂起/误报)
      a.addEventListener('playing', () => { a.__never = false; });
      voiceEls.push(a);
      poolStartEl(a);
    }
    warmVoiceCache();
  }
  // 已解锁的场合: 补解锁首次手势没能启动的元素 (每次手势都尝试, 直到全部成功)。
  // 只碰空闲元素 —— 正在播报的元素绝不能重置 src, 否则会掐断正在响的语音
  voiceEls.forEach(a => { if (a.__never && a.paused) poolStartEl(a); });
  // v6.6.53: 每次手势顺带 resume 音频上下文 + 预解码当前音色语音 (WebAudio 主通道就绪)
  try { const c = _audioCtx(); if (c && c.state !== 'running') c.resume().catch(() => {}); } catch (e) {} // v6.6.43: 覆盖 interrupted
  try { voicePreloadBuf(voiceGender); } catch (e) {}
  // 播报失败补播: 15 秒内有过失败, 下次手势时用 mp3 再试一次
  if (typeof pendingSay !== 'undefined' && pendingSay && Date.now() - pendingSay.at < 15000) {
    const ps = pendingSay; pendingSay = null;
    try { say(ps.text, null, ps.gender); } catch (e) {}
  }
}
function poolStartEl(a) {
  // 关键1: 必须带真实可解码的 src 去 play —— 空 src 的 play() 直接 NotSupportedError 拒绝,
  // 元素根本没解锁, 之后正式语音全被拒 (手机上语音消失的元凶)。用内嵌 0.05s 静音 wav。
  // 关键2: 不能等 promise resolve 才解除 muted —— 部分浏览器对静音源的 promise 永远挂起。
  a.muted = false;
  a.volume = 0;
  try { a.src = SILENT_WAV; } catch (e) {}
  try {
    const p = a.play(); // 手势内调用过 play() 即拿到该元素的播放解锁凭证
    if (p && p.then) {
      p.then(() => { try { a.pause(); } catch (e) {} a.__never = false; })
       .catch(() => { try { a.pause(); } catch (e) {} });
    } else { try { a.pause(); } catch (e) {} a.__never = false; }
  } catch (e) {}
}
// v6.6.53: 后台自愈 —— 每4秒重置坏掉的语音池元素 + resume 挂起的音频上下文, 不再依赖用户点屏
// v6.6.43: resume 判定从 ==='suspended' 放宽为 !=='running' (覆盖 interrupted 等异常态)
setInterval(() => {
  try { voiceEls.forEach(a => { if (a.__never && a.paused) poolStartEl(a); }); } catch (e) {}
  try { const c = _audioCtx(); if (c && c.state !== 'running') c.resume().catch(() => {}); } catch (e) {}
}, 4000);
// 手势解锁后, 后台渐进预热当前音色的语音文件 (只加载不播放, 消除首次播放的下载延迟)
function warmVoiceCache() {
  if (voiceWarmed) return;
  voiceWarmed = true;
  const files = Object.values(VOICE_FILES);
  let i = 0;
  const tick = () => {
    if (i >= files.length) return;
    const name = files[i]; i++;
    const n = VOICE_VARIANTS[name] || 2;
    for (let v = 0; v < n; v++) {
      try { const a = new Audio('voice/' + voiceGender + '/' + name + ['', 'b', 'c'][v] + '.mp3'); a.preload = 'auto'; a.load(); } catch (e) {}
    }
    setTimeout(tick, 250);
  };
  tick();
}
// ---- v6.6.53: 语音播报主通道改走 WebAudio (与牌声同款管线) ----
// 手机浏览器会在媒体状态变化(关/开总开关、切曲库)时回收 HTMLAudio 元素的播放许可,
// 语音池被收走许可就永久哑掉且点屏也修不回; WebAudio 上下文 resume 后即可正常出声。
const voiceBuf = {};         // url -> AudioBuffer
const voiceBufFetching = {}; // 防重复 fetch
function voicePreloadBuf(gender) {
  const c = _audioCtx(); if (!c) return;
  Object.values(VOICE_FILES).forEach(base => {
    const n = VOICE_VARIANTS[base] || 2;
    for (let v = 0; v < n; v++) {
      const url = 'voice/' + gender + '/' + base + ['', 'b', 'c'][v] + '.mp3';
      if (voiceBuf[url] || voiceBufFetching[url]) continue;
      voiceBufFetching[url] = true;
      fetch(url).then(r => { if (!r.ok) throw 0; return r.arrayBuffer(); })
        .then(ab => c.decodeAudioData(ab))
        .then(b => { voiceBuf[url] = b; delete voiceBufFetching[url]; })
        .catch(() => { delete voiceBufFetching[url]; });
    }
  });
}
function voicePlayBuf(url, vol) {
  const c = _audioCtx(); if (!c) return false;
  const buf = voiceBuf[url];
  if (!buf) return false; // 还没解码好 → 调用方走 HTMLAudio 池兜底
  try { if (c.state !== 'running') c.resume().catch(() => {}); } catch (e) {}
  try {
    const src = c.createBufferSource(); src.buffer = buf;
    const gn = c.createGain(); gn.gain.value = vol;
    src.connect(gn); gn.connect(c.destination);
    src.start();
    return true;
  } catch (e) { return false; }
}
function say(text, rate, gender, depth) {
  if (!bgmOn || !voiceOn) return;
  const g = gender || voiceGender;
  const base = VOICE_FILES[text];
  if (base) {
    const n = VOICE_VARIANTS[base] || 2;
    const f = base + ['', 'b', 'c'][Math.floor(Math.random() * n)] + '.mp3';
    const url = 'voice/' + g + '/' + f;
    // v6.6.53: 主通道 WebAudio —— 缓冲就绪直接放, 不受 HTMLAudio 许可回收影响
    try { if (voicePlayBuf(url, voiceGain())) return; } catch (e) {}
    try { voicePreloadBuf(g); } catch (e) {} // 没解码好: 后台补解码, 本次走旧通道兜底
    try {
      let a;
      if (voiceUnlocked && voiceEls.length) {
        // 已解锁: 用轮换池, 优先空闲且解锁成功的元素, 全忙则抢占下一个 (切换 src 走浏览器缓存)
        a = voiceEls.find(x => x.paused && !x.__never) ||
            voiceEls.find(x => !x.__never) ||
            voiceEls[voiceElsIdx++ % voiceEls.length];
      } else {
        a = voicePool[f + g];
        if (!a) { a = new Audio(url); voicePool[f + g] = a; }
      }
      a.volume = voiceGain(); // 语音播报音量
      a.playbackRate = 0.96 + Math.random() * 0.1; // 微变速, 听感更活
      try { a.src = url; } catch (e) {}
      try { a.currentTime = 0; } catch (e) {} // src 刚切换时 iOS 可能抛错, 绝不能让它阻断 play
      // v6.6.51: 起播看门狗 —— play() 挂死(不 resolve 不 reject)的元素 paused 一直为 true,
      // 会被当成"空闲"反复选中又反复 AbortError, 表现为语音永久消失(换曲库抢音频焦点可诱发)。
      // 800ms 内没真正出声(用 playing 事件区分"播完了"和"没播起来") → 标记 __never
      // 交还手势修复机制, 并换元素重试一次(带上限防循环)
      const tok = (a.__tok = (a.__tok || 0) + 1);
      a.__played = false;
      const onPlaying = () => { a.__played = true; };
      a.addEventListener('playing', onPlaying, { once: true });
      setTimeout(() => {
        a.removeEventListener('playing', onPlaying);
        if (a.__tok === tok && !a.__played && a.paused && !a.__never) {
          a.__never = true; // 挂死元素: 等下次手势由 unlockVoicePool 重新解锁
          if ((depth || 0) < 1) setTimeout(() => { try { say(text, rate, gender, (depth || 0) + 1); } catch (e) {} }, 80);
        }
      }, 800);
      const pp = a.play();
      if (pp && pp.then) pp.then(() => { a.__never = false; }).catch((err) => {
        // 元素被更新的播报抢占 (换 src 导致 AbortError) 属正常轮换: 不重试不兜底,
        // 否则两条播报互相打断, 300ms 重试还会抢走别人正在播的元素, 越打越乱
        if (err && err.name === 'AbortError') {
          // 但若元素并没有真的在响(paused) = 挂死而非被抢占: 标记并换元素重试一次
          if (a.paused && !a.__never) {
            a.__never = true;
            if ((depth || 0) < 1) setTimeout(() => { try { say(text, rate, gender, (depth || 0) + 1); } catch (e) {} }, 80);
          }
          return;
        }
        // 其余失败 (autoplay 拒绝等): 延迟强制重载重试一次
        setTimeout(() => {
          try {
            a.src = url;
            try { a.currentTime = 0; } catch (e) {}
            a.volume = voiceGain();
            const p2 = a.play();
            if (p2 && p2.catch) p2.catch((e2) => {
              // 两次都失败: 不再静默 —— 回退系统 TTS 念出来, 并记录待手势重试
              window.__mjLastVoiceErr = (e2 && e2.name) || 'play-failed';
              pendingSay = { text, gender: g, at: Date.now() };
              ttsSay(text, rate);
            });
          } catch (e) {}
        }, 300);
      });
      return;
    } catch (e) {}
  }
  if (!('speechSynthesis' in window)) return;
  ttsSay(text, rate);
}
// 系统 TTS 念读 (mp3 播报失败时的兜底, 也用于无预录音的词)
let pendingSay = null; // 最近一次播报失败的 {text, gender, at}, 下次手势时补播
function ttsSay(text, rate) {
  if (!('speechSynthesis' in window)) return;
  try {
    if (!zhVoice) pickVoice();
    speechSynthesis.cancel();
    // 手机浏览器 cancel 后立刻 speak 会丢语音, 延迟一拍
    setTimeout(() => {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN';
        if (zhVoice) u.voice = zhVoice;
        u.rate = rate || 1.15;
        u.pitch = 1.05;
        u.volume = voiceGain(); // 语音播报音量
        window.__ttsU = u; // 持有引用, 防止部分手机浏览器 GC 中断语音
        speechSynthesis.speak(u);
      } catch (e) {}
    }, 80);
  } catch (e) {}
}
// ================= 牌声 (和牌音效, 声音设置里开关, 默认关 = 原音效不变) =================
let fxReal = true; // 默认开启 (v6.6.16): 出牌"啪"声/吃碰/胡牌/结算全部真实和牌音效
try { fxReal = localStorage.getItem('mj_fx_real') !== '0'; } catch (e) {}
const fxCache = {};
// ---- 低延迟短音效: Web Audio 预解码 (v6.6.20) ----
// new Audio() 在手机浏览器上有 100~500ms 启动延迟; 提前 fetch+decodeAudioData 成
// AudioBuffer 后用 AudioContext 播放只需几 ms。给选牌/操作/牌声等手感敏感的短音用。
const _fxBuf = {};      // name -> AudioBuffer
const _fxFetching = {}; // 防重复 fetch
let _fxOwnCtx = null;
function _audioCtx() {
  if (bgm) return bgm.ctx; // 复用 BGM 的 ctx
  // v6.6.53: 缓存自建上下文 —— 之前每次调用 new AC(), 新上下文必是挂起态且无手势 resume 常失败,
  // 表现为牌声间歇性哑、打若干张后碰巧复活; 固定上下文 + 手势/定时 resume 后不再抖
  if (_fxOwnCtx) return _fxOwnCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  _fxOwnCtx = new AC();
  return _fxOwnCtx;
}
// v6.6.43: 掉线重连后音频整体重建。掉线期间系统回收音频会话 → 上下文变僵尸 (running 但哑) 或
// interrupted, resume 救不回, 报牌声+牌声一起哑。关旧建新: AudioBuffer (voiceBuf/_fxBuf)
// 与上下文无关直接复用; 新上下文由手势 + 4秒自愈 resume 拉起; 语音池元素标 __never 待重解锁。
function audioRebuild() {
  try { if (bgm && bgm.ctx) { try { bgm.ctx.close(); } catch (e) {} } } catch (e) {}
  bgm = null; // 下次 sfxNote / 手势 bgmInit 重建
  try { if (_fxOwnCtx) { try { _fxOwnCtx.close(); } catch (e) {} } } catch (e) {}
  _fxOwnCtx = null; // 下次 _audioCtx() 重建
  try { voiceEls.forEach(a => { a.__never = true; }); } catch (e) {} // 许可可能一并被收走, 空闲时由手势/自愈 poolStartEl 重置
}
function fxPreload(name) {
  if (_fxBuf[name] || _fxFetching[name]) return;
  const c = _audioCtx(); if (!c) return;
  _fxFetching[name] = true;
  fetch('music/fx/' + name + '.mp3')
    .then(r => { if (!r.ok) throw 0; return r.arrayBuffer(); })
    .then(ab => c.decodeAudioData(ab))
    .then(b => { _fxBuf[name] = b; delete _fxFetching[name]; })
    .catch(() => { delete _fxFetching[name]; });
}
function fxPlayLowLatency(name, vol) {
  const c = _audioCtx(); if (!c) return false;
  const buf = _fxBuf[name];
  if (!buf) { fxPreload(name); return false; } // 还没解码好 → 调用方走 HTMLAudio 回退
  try { if (c.state !== 'running') c.resume().catch(() => {}); } catch (e) {}
  try {
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain(); g.gain.value = vol;
    src.connect(g); g.connect(c.destination);
    src.start();
    return true;
  } catch (e) { return false; }
}
// 常用短音开场就后台预解码 (fetch 不需要用户手势, 首次点击即可低延迟出声)
['SpecOk', 'SpecSelectCard', 'discard_tile', 'track_17'].forEach(fxPreload);

function playFx(name, vol, delay) {
  if (!fxReal || !bgmOn) return; // 总开关关闭时一并静音(与语音播报同规矩)
  const v = (vol == null ? 0.6 : vol) * voiceGain(); // 牌声随语音播报音量 (v6.6.50: 维持原归属)
  if (v <= 0) return;
  const go = () => {
    if (fxPlayLowLatency(name, v)) return; // 低延迟路径 (v6.6.20)
    try {
      let a = fxCache[name];
      if (!a) { a = new Audio('music/fx/' + name + '.mp3'); a.preload = 'auto'; fxCache[name] = a; }
      a.volume = v;
      try { a.currentTime = 0; } catch (e) {}
      a.play().catch(() => {});
    } catch (e) {}
  };
  if (delay) setTimeout(go, delay * 1000); else go();
}
function setFxReal(on) {
  fxReal = on;
  try { localStorage.setItem('mj_fx_real', on ? '1' : '0'); } catch (e) {}
  if (on) playFx('discard_tile'); // 开启瞬间试听一声
  syncSoundModal();
}
// 选牌/操作音效 (SpecSelectCard=选牌, SpecOk=全局按钮点击): 独立开关, 默认开, 受声音总开关管控
let opSfxOn = true;
try { opSfxOn = localStorage.getItem('mj_op_sfx') !== '0'; } catch (e) {}
const opCache = {};
function playOp(name) {
  if (!bgmOn || !opSfxOn) return;
  if (fxPlayLowLatency(name, 0.5 * musicGain())) return; // 低延迟路径 (v6.6.20), 随背景音乐音量 (v6.6.50)
  try {
    let a = opCache[name];
    if (!a) { a = new Audio('music/fx/' + name + '.mp3'); a.preload = 'auto'; opCache[name] = a; }
    a.volume = 0.5 * musicGain();
    try { a.currentTime = 0; } catch (e) {}
    a.play().catch(() => {});
  } catch (e) {}
}
function setOpSfx(on) {
  opSfxOn = on;
  try { localStorage.setItem('mj_op_sfx', on ? '1' : '0'); } catch (e) {}
  syncSoundModal(); // 开关本身也是按钮, 全局监听会自动响一声
}
// SpecOk 全局按钮音: 几乎所有 <button> 点击都响 (设置/聊天/操作栏/关闭等),
// 由「选牌/操作音效」开关统一管控 (v6.6.18); 带 data-noop 的按钮跳过 (它们自己会播别的语音) (v6.6.18b)
document.addEventListener('click', (e) => {
  const b = (e.target && e.target.closest) ? e.target.closest('button') : null;
  if (b && !b.disabled && !b.dataset.noop) playOp('SpecOk');
}, true);
// 音效走 bgm 的 AudioContext (bgm 关时 ctx 仍在, 但 bgmOn=false 时统一静音)
function sfxNote(freq, dur, vol, type, delay) {
  if (!bgmOn) return;
  if (!bgm && !bgmInit()) return; // 两种 BGM 都走 HTMLAudio, ctx 由音效按需初始化
  if (bgm.ctx.state !== 'running') { try { bgm.ctx.resume(); } catch (e) {} } // v6.6.43: 覆盖 interrupted
  const t = bgm.ctx.currentTime + (delay || 0);
  const o = bgm.ctx.createOscillator(), gn = bgm.ctx.createGain();
  o.type = type || 'sine';
  o.frequency.value = freq;
  gn.gain.setValueAtTime(0, t);
  gn.gain.linearRampToValueAtTime(vol, t + 0.015);
  gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(gn); gn.connect(bgm.master);
  o.start(t); o.stop(t + dur + 0.05);
}
function sfxTile() { if (fxReal) { playFx('discard_tile'); return; } if (!voiceOn) return; sfxNote(880, 0.07, 0.5 * voiceGain(), 'triangle'); sfxNote(1320, 0.05, 0.3 * voiceGain(), 'sine', 0.01); } // 打牌"嗒" (随语音播报音量)
// 结算音乐: 自备 Win/Lose 音效, 加载失败回退合成音
function playResultMusic(file, fallback) {
  if (!musicOn) return;
  try {
    const a = new Audio('music/' + file);
    a.volume = 0.55 * musicGain();
    // 结算曲播完 (v6.6.42) → 从普通曲池全新起播 (对局曲池已在结算时停掉)
    a.addEventListener('ended', () => { if (bgmStyle === 'classic' && bgmOn && musicOn && classicInGame()) classicStart(); });
    a.play().catch(() => fallback());
  } catch (e) { fallback(); }
}
// 赢输结算曲按 BGM 风格分流 (v6.6.17): 大胡恒用 win_big(CompetitiveWin);
// 平胡/输 — 经典曲库用 win/lose, 节日曲库用自备结算曲; 不受牌声开关影响
function sfxWin(big) { playResultMusic(big ? 'win_big.mp3' : (bgmStyle === 'fest' ? 'fx/result_win.mp3' : 'win.mp3'), () => { if (!musicOn) return; [523, 659, 784, 1047, 1319].forEach((f, i) => sfxNote(f, 0.35, 0.4 * musicGain(), 'triangle', i * 0.12)); }); }
function sfxLose() { playResultMusic(bgmStyle === 'fest' ? 'fx/result_lose.mp3' : 'lose.mp3', () => { if (!musicOn) return; [392, 330, 262].forEach((f, i) => sfxNote(f, 0.4, 0.35 * musicGain(), 'sine', i * 0.18)); }); }
function sfxDraw() { if (!musicOn) return; sfxNote(440, 0.3, 0.25 * musicGain(), 'sine'); }                                                                // 流局中性音

// ---- 触发: 出牌/吃/碰 (依据 game 同步的 seq 与副露变化) ----
let lastDiscardSeq = null;
let prevMeldLens = null;
let lastSoundRound = null;
function hookGameSounds(m) {
  if (!m || !m.players) return;
  const lens = m.players.map(p => (p.melds || []).length);
  // 新一局开始: 用局号判断重置 (开局首条同步时 phase 已是 'discard', 且 discardSeq 从 1 重新计数,
  // 之前等 phase==='draw' 的分支永远不会命中 → 第二局 seq 全部小于上局末尾, 整局不报牌)
  if (m.round !== lastSoundRound) {
    lastSoundRound = m.round;
    prevMeldLens = lens;
    lastDiscardSeq = m.lastDiscard ? m.lastDiscard.seq : 0; // 首条同步已带出牌(中途进房/观战): 记为历史不播
    if (!m.lastDiscard) return; // 开局还没人出牌, 无历史要播
  }
  if (!m.lastDiscard) { if (lastDiscardSeq === null) lastDiscardSeq = 0; return; }
  const seq = m.lastDiscard.seq;
  if (lastDiscardSeq === null) lastDiscardSeq = seq;   // 中途进房/观战: 首次同步不播历史
  else if (seq > lastDiscardSeq) {
    lastDiscardSeq = seq;
    const dvoicer = m.players[m.lastDiscard.from];
    say(tileVoiceName(m.lastDiscard.id), null, (dvoicer && dvoicer.voice) || 'f'); // 用出牌者的声音念
    sfxTile();
  }
  if (prevMeldLens === null) prevMeldLens = lens;
  else if (m.phase !== 'over') {
    for (let i = 0; i < lens.length; i++) {
      if (lens[i] > prevMeldLens[i]) {
        const type = m.players[i].melds[lens[i] - 1] && m.players[i].melds[lens[i] - 1].type;
        const mvoice = m.players[i].voice || 'f';
        if (type === 'peng') { say('碰！', null, mvoice); if (fxReal) playFx('track_17'); }
        else if (type === 'chi') { say('吃！', null, mvoice); if (fxReal) playFx('track_17'); }
      }
    }
    prevMeldLens = lens;
  }
}
// ---- 触发: 胡牌/结算 ----
function hookResultSounds(m) {
  if (m.draw) { sfxDraw(); return; }
  say('我胡啦！', null, m.winnerVoice || 'f'); // 用胡牌者的声音喊
  // 和牌音效为可选外部素材 — 缺失时胡牌瞬间只有语音+结算曲 (v6.6.23)
  const my = (m.deltas && gameState && gameState.me) ? m.deltas[gameState.me.seat] : null;
  // 赢输结算曲不再受牌声开关影响, 具体曲子按风格分流见 sfxWin/sfxLose (v6.6.17)
  if (my > 0) setTimeout(() => { classicHaltFor(); sfxWin(m.daHu); }, 650);
  else if (my < 0) setTimeout(() => { classicHaltFor(); sfxLose(); }, 650);
  else setTimeout(sfxDraw, 650);
}
// setBgm 关闭时停掉语音 + 同步设置弹窗按钮
const _setBgm = setBgm;
setBgm = function (on) {
  _setBgm(on);
  if (!on && 'speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (e) {} }
  syncSoundModal();
};

// ================= 声音设置弹窗绑定 (元素与变量均已就绪) =================
$('btnSndToggle').onclick = () => setBgm(!bgmOn);
$('btnSndCloseX').onclick = () => $('soundModal').classList.add('hidden');
$('btnSoundClose').onclick = () => $('soundModal').classList.add('hidden');
document.querySelectorAll('#voiceSel .btn').forEach(b =>
  b.onclick = () => setVoiceGender(b.dataset.v));
document.querySelectorAll('#bgmSel .btn').forEach(b =>
  b.onclick = () => setBgmStyle(b.dataset.b));
$('btnFxReal').onclick = () => setFxReal(!fxReal);
$('btnOpSfx').onclick = () => setOpSfx(!opSfxOn);
$('btnChatQuick').onclick = () => setChatQuick(!chatQuickOn);
// 测试报牌语音: 在点击手势内直接走真实播报链路 (解锁语音池 + 播 mp3)
setVoiceGender(voiceGender);
setBgmStyle(bgmStyle);
syncSoundModal();

// 背景音乐/语音 音量滑条绑定 (拖到最左 = 0 = 关)
$('musicVol').addEventListener('input', (e) => setMusicVol(parseInt(e.target.value, 10)));
$('voiceVol').addEventListener('input', (e) => setVoiceVol(parseInt(e.target.value, 10)));
syncVolFill($('musicVol'));
syncVolFill($('voiceVol'));

// ================= 房间语音通话 (WebRTC mesh, 服务器只转发信令) =================
let voiceActive = false;
let voiceStream = null;
let voiceMuted = false;
let voicePeersList = [];
const voicePcs = new Map(); // seat -> RTCPeerConnection
const VOICE_ICE = { iceServers: [{ urls: ['stun:stun.qq.com:3478', 'stun:stun.miwifi.com:3478'] }] };

function voiceSetBtn() {
  document.querySelectorAll('.js-voice-fab').forEach(b => b.classList.toggle('voice-on', voiceActive));
}
function renderVoicePanel(m) {
  if (m && m.list) voicePeersList = m.list;
  const list = voicePeersList || [];
  const ul = $('voiceMembers');
  if (ul) {
    ul.innerHTML = list.length
      ? list.map(x => `<li><span>${x.online === false ? '💤 ' : '🎙 '}${x.name}</span><span>${x.seat === me.seat ? '(我)' : ''}</span></li>`).join('')
      : '<li>还没有人在通话</li>';
  }
  $('btnVoiceGo').classList.toggle('hidden', voiceActive);
  $('btnVoiceMute').classList.toggle('hidden', !voiceActive);
  $('btnVoiceHang').classList.toggle('hidden', !voiceActive);
  if (voiceActive) $('btnVoiceMute').textContent = voiceMuted ? '🔇 已静音（点击恢复）' : '🎤 麦克风开启（点击静音）';
}
async function voiceJoin() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert(location.protocol === 'https:'
      ? '当前浏览器不支持麦克风通话'
      : '语音通话需要 HTTPS 访问\n请改用 https://' + location.hostname + ' 打开后重试');
    return;
  }
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) { alert('无法打开麦克风: ' + (e.message || e)); return; }
  voiceMuted = false;
  voiceActive = true;
  try { ws.send(JSON.stringify({ t: 'voice_hello' })); } catch (e) {}
  voiceSetBtn(); renderVoicePanel();
}
function voiceLeave() {
  voiceActive = false;
  voicePcs.forEach(pc => { try { pc.close(); } catch (e) {} });
  voicePcs.clear();
  document.querySelectorAll('audio[id^="voiceAudio"]').forEach(a => a.remove());
  if (voiceStream) { voiceStream.getTracks().forEach(t => t.stop()); voiceStream = null; }
  try { ws.send(JSON.stringify({ t: 'voice_bye' })); } catch (e) {}
  voiceSetBtn(); renderVoicePanel();
}
function pcFor(seat) {
  let pc = voicePcs.get(seat);
  if (pc) return pc;
  pc = new RTCPeerConnection(VOICE_ICE);
  voiceStream.getAudioTracks().forEach(t => pc.addTrack(t, voiceStream));
  pc.onicecandidate = (e) => { if (e.candidate) { try { ws.send(JSON.stringify({ t: 'voice_ice', to: seat, c: e.candidate })); } catch (err) {} } };
  pc.ontrack = (e) => {
    let au = document.getElementById('voiceAudio' + seat);
    if (!au) { au = document.createElement('audio'); au.id = 'voiceAudio' + seat; au.autoplay = true; document.body.appendChild(au); }
    au.srcObject = e.streams[0];
  };
  voicePcs.set(seat, pc);
  return pc;
}
async function voiceOnPeers(m) {
  renderVoicePanel(m);
  if (!voiceActive || !voiceStream) return;
  const my = m.list.find(x => x.seat === me.seat);
  const mySeq = my ? my.seq : 0;
  // 加入序号比我小的 → 由我发起连接; 比我大的 → 等对方 offer (避免双向 offer 冲突)
  for (const x of m.list) {
    if (x.seat === me.seat || x.seq >= mySeq) continue;
    const pc = pcFor(x.seat);
    if (pc.signalingState !== 'stable') continue;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ t: 'voice_offer', to: x.seat, sdp: pc.localDescription }));
    } catch (e) {}
  }
  // 清理已退出通话的连接
  for (const [seat, pc] of voicePcs) {
    if (!m.list.find(x => x.seat === seat)) {
      try { pc.close(); } catch (e) {}
      voicePcs.delete(seat);
      const au = document.getElementById('voiceAudio' + seat);
      if (au) au.remove();
    }
  }
}
async function voiceOnOffer(m) {
  if (!voiceActive || !voiceStream) return;
  const pc = pcFor(m.from);
  try {
    await pc.setRemoteDescription(m.sdp);
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    ws.send(JSON.stringify({ t: 'voice_answer', to: m.from, sdp: pc.localDescription }));
  } catch (e) {}
}
// 弹窗与入口绑定
document.querySelectorAll('.js-voice-fab').forEach(b =>
  b.onclick = () => { renderVoicePanel(); $('voiceModal').classList.remove('hidden'); });
$('btnVoiceCloseX').onclick = () => $('voiceModal').classList.add('hidden');
$('btnVoiceGo').onclick = voiceJoin;
$('btnVoiceHang').onclick = voiceLeave;
$('btnVoiceMute').onclick = () => {
  voiceMuted = !voiceMuted;
  if (voiceStream) voiceStream.getAudioTracks().forEach(t => { t.enabled = !voiceMuted; });
  renderVoicePanel();
};
