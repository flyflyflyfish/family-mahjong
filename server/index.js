'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const G = require('./game.js');

const PORT = process.env.PORT || 3000;

// ================= 账号与好友 =================
const fs = require('fs');
const ACC_PATH = path.join(__dirname, 'accounts.json');
let accounts = { users: {} };
try { accounts = JSON.parse(fs.readFileSync(ACC_PATH, 'utf8')); } catch (e) {}
function saveAcc() { try { fs.writeFileSync(ACC_PATH, JSON.stringify(accounts)); } catch (e) { console.error('保存账号失败', e); } }

// ================= Web Push (浏览器离线推送) =================
let webpush = null;
try { webpush = require('web-push'); } catch (e) { console.error('[push] 未安装 web-push, 离线推送不可用'); }
const SECRETS_PATH = path.join(__dirname, 'secrets.json');
let VAPID = null;
if (webpush) {
  let secrets = {};
  try { secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8')); } catch (e) {}
  if (!secrets.vapid || !secrets.vapid.pub || !secrets.vapid.priv) {
    const keys = webpush.generateVAPIDKeys();
    secrets = Object.assign({}, secrets, { vapid: { pub: keys.publicKey, priv: keys.privateKey } });
    try { fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 1)); console.log('[push] 已生成 VAPID 密钥'); } catch (e) { console.error('[push] 写入密钥失败', e); }
  }
  VAPID = secrets.vapid;
  webpush.setVapidDetails('mailto:mahjong@local', VAPID.pub, VAPID.priv);
}
// 给离线用户推一条系统通知 (浏览器/手机通知栏); 订阅失效自动清理
function pushUser(user, title, body) {
  if (!webpush) return;
  const a = accounts.users[user];
  if (!a || !Array.isArray(a.pushSubs) || !a.pushSubs.length) return;
  const payload = JSON.stringify({ title, body });
  a.pushSubs.forEach(s => {
    webpush.sendNotification(s, payload).catch(err => {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        a.pushSubs = a.pushSubs.filter(x => x.endpoint !== s.endpoint);
        saveAcc();
      }
    });
  });
}

// ================= 战绩 =================
const HIST_PATH = path.join(__dirname, 'history.json');
let gameHistory = [];
try { gameHistory = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8')); if (!Array.isArray(gameHistory)) gameHistory = []; } catch (e) {}
function saveHist() { try { fs.writeFileSync(HIST_PATH, JSON.stringify(gameHistory.slice(-5000))); } catch (e) { console.error('保存战绩失败', e); } }
function histUser(p) { return p.user || (p.ws && p.ws._user) || null; }

const onlineUsers = new Map(); // username -> ws
const userRoom = new Map();    // username -> 房间号(用于好友列表显示"在房间")

function hashPass(salt, pass) { return crypto.createHash('sha256').update(salt + ':' + pass).digest('hex'); }

function friendsView(username) {
  const meAcc = accounts.users[username];
  if (!meAcc) return { friends: [], requests: [] };
  const friends = (meAcc.friends || []).map(u => {
    const a = accounts.users[u];
    return a ? { user: u, name: a.name, online: onlineUsers.has(u), room: userRoom.get(u) || null } : null;
  }).filter(Boolean);
  const requests = (meAcc.requests || []).map(u => {
    const a = accounts.users[u];
    return a ? { user: u, name: a.name } : null;
  }).filter(Boolean);
  return { friends, requests };
}

function pushFriendsAll() {
  for (const [u, tws] of onlineUsers) {
    if (tws.readyState === 1) send(tws, { t: 'friends', ...friendsView(u) });
  }
}

function becomeFriends(a, b) {
  const aa = accounts.users[a], ab = accounts.users[b];
  if (!aa || !ab) return;
  aa.friends = aa.friends || []; ab.friends = ab.friends || [];
  if (!aa.friends.includes(b)) aa.friends.push(b);
  if (!ab.friends.includes(a)) ab.friends.push(a);
  aa.requests = (aa.requests || []).filter(u => u !== b);
  ab.requests = (ab.requests || []).filter(u => u !== a);
  saveAcc();
  pushFriendsAll();
}

function doLogin(ws, user, opts = {}) {
  // 多设备处理: 手动登录(输密码/注册)顶掉旧设备 → 旧设备账号层下线(牌局连接基于sid, 不受影响);
  // auto_login/wx_login 等自动重登不顶号, 避免手机切后台重连时把正在用的电脑端踢下线
  const prev = onlineUsers.get(user);
  if (opts.manual && prev && prev !== ws && prev.readyState === 1) {
    prev._user = null;
    send(prev, { t: 'logged_out', msg: '你的账号刚在其他设备上登录, 本设备已退出登录(牌局不受影响)' });
  }
  ws._user = user;
  onlineUsers.set(user, ws);
  const a = accounts.users[user];
  send(ws, { t: 'auth_ok', user, name: a.name, token: a.token, vapidPub: VAPID ? VAPID.pub : null, ...friendsView(user) });
  // 送达排队中的房间邀请 (10分钟内有效)
  const now = Date.now();
  const pending = (a.pendingInvites || [])
    .filter(iv => now - iv.ts < 10 * 60 * 1000)
    .filter(iv => iv.code == null || rooms.has(iv.code));
  a.pendingInvites = [];
  saveAcc();
  pending.forEach(iv => send(ws, { t: 'invite', from: iv.from, fromName: iv.fromName, code: iv.code }));
  pushFriendsAll();
}

// 解散房间: 通知所有人(带原因), 清理定时器与映射
function dissolveAll(room, reason) {
  for (const k of Object.keys(room.timers)) clearTimeout(room.timers[k]);
  room.players.forEach((p) => {
    sidIndex.delete(p.sid);
    if (p.ws) {
      send(p.ws, { t: 'room_dissolved', msg: reason });
      if (p.ws._user) userRoom.delete(p.ws._user);
    }
  });
  rooms.delete(room.code);
  pushFriendsAll();
}

// 玩家退出房间: 语音通话组同步清理(含座位重映射), 座位前移, 比分对齐; 剩 1 人时解散
function removePlayer(room, seat) {
  const p = room.players[seat];
  if (!p) return;
  // 权限交接准备: 房主离开时, 管理员优先接任, 否则顺位下一个人; 申请中的管理员请求若来自离开者则作废
  const wasHost = seat === room.hostSeat;
  const n0 = room.players.length;
  const nextRaw = (seat + 1) % n0; // 顺位下家(原座位号)
  if (room.adminReq && room.adminReq.sid === p.sid) clearAdminReq(room);
  if (room.admins) room.admins.delete(p.sid);
  sidIndex.delete(p.sid);
  if (room.spectators && p.sid) room.spectators.delete(p.sid);
  if (p.ws && p.ws._user) { userRoom.delete(p.ws._user); pushFriendsAll(); }
  // 语音通话组成员表: 删掉退出者, 其他人座位前移后重映射
  if (room.voice && room.voice.members[seat] !== undefined) {
    delete room.voice.members[seat];
    const remapped = {};
    Object.entries(room.voice.members).forEach(([s, seq]) => {
      remapped[Number(s) > seat ? Number(s) - 1 : Number(s)] = seq;
    });
    room.voice.members = remapped;
  }
  room.players.splice(seat, 1);
  room.players.forEach((q, i) => {
    q.seat = i;
    if (q.sid) sidIndex.set(q.sid, { code: room.code, seat: i });
  });
  if (room.scores && room.scores.length > room.players.length) room.scores.splice(seat, 1);
  if (wasHost) {
    // 房主退出/被踢: 管理员优先接任房主, 没有管理员则顺位下一个人
    let hi = (room.admins && room.admins.size) ? room.players.findIndex(q => room.admins.has(q.sid)) : -1;
    if (hi < 0) hi = nextRaw > seat ? nextRaw - 1 : nextRaw; // 座位前移后的下家
    room.hostSeat = Math.max(0, Math.min(hi, room.players.length - 1));
    if (room.admins && room.players[room.hostSeat] && room.admins.has(room.players[room.hostSeat].sid))
      room.admins.delete(room.players[room.hostSeat].sid); // 接任房主后不再是普通管理员
    const nh = room.players[room.hostSeat];
    if (nh && room.players.length > 1) broadcast(room, { t: 'info', msg: `${nh.name} 成为新房主` });
  } else if (room.hostSeat > seat) {
    room.hostSeat -= 1; // 座位前移修正
  }
  room.dealer = room.players.length ? room.dealer % room.players.length : 0;
  if (room.players.length && room.players.every(q => q.bot)) {
    // v6.6.32: 真人全走光, 剩下的都是机器人 → 自动解散, 不让机器人自己打下去
    dissolveAll(room, '真人都离开了, 房间已解散');
  } else if (room.players.length <= 1) {
    // 只剩一个人(或没人)了: 房间维持不下去, 解散
    dissolveAll(room, room.players.length === 1 ? '其他人都走了, 房间已解散' : '房间已解散');
  } else {
    if (room.voice) broadcastVoicePeers(room);
    syncRoom(room);
    // 有待处理的管理员申请且房主换人了 → 重新弹给新房主
    if (room.adminReq) {
      const ap = room.players.find(q => q.sid === room.adminReq.sid);
      if (ap) broadcast(room, { t: 'admin_request', seat: ap.seat, name: ap.name });
      else clearAdminReq(room);
    }
  }
}

// ===== 房主/管理员权限 =====
// 管理员与房主同权: 踢人(含房主) + 解散房间; 身份按会话 sid 记录, 座位变化不受影响
function isAdmin(room, seat) {
  const p = room.players[seat];
  return !!(p && p.sid && room.admins && room.admins.has(p.sid));
}
function hasPower(room, seat) { return seat === room.hostSeat || isAdmin(room, seat); }
function clearAdminReq(room) { clearTimeout(room.timers.adminReq); room.adminReq = null; }
function grantAdmin(room, sid, auto) {
  clearAdminReq(room);
  const p = room.players.find(q => q.sid === sid);
  if (!p) return;
  room.admins = room.admins || new Set();
  room.admins.add(sid);
  broadcast(room, { t: 'admin_request_done' });
  broadcast(room, { t: 'info', msg: `${p.name} 已成为管理员${auto ? '(房主未处理, 超时自动通过)' : ''}` });
  syncRoom(room);
}

const app = express();

// ================= 微信测试号 (房间邀请提醒) =================
// secrets.json: wx: { appId, secret, token, templateId, gameUrl }
let WXCFG = {};
try { WXCFG = (JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8')).wx) || {}; } catch (e) {}
let wxToken = null, wxTokenExp = 0;
async function wxAccessToken() {
  if (!WXCFG.appId || !WXCFG.secret) return null;
  const now = Date.now();
  if (wxToken && now < wxTokenExp - 60000) return wxToken;
  try {
    const res = await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WXCFG.appId}&secret=${WXCFG.secret}`);
    const j = await res.json();
    if (j.access_token) { wxToken = j.access_token; wxTokenExp = now + ((j.expires_in || 7200) * 1000); return wxToken; }
    console.error('[wx] 获取 access_token 失败', j);
  } catch (e) { console.error('[wx] token 请求异常', e.message); }
  return null;
}
// 给账号生成一次性登录钥匙拼进 gameUrl (10分钟有效, 最多留3把, 用过即作废)
// → 微信提醒/推送点开即自动登录, 不用再手输账号 (v6.6.13)
function makeWxLoginUrl(acc) {
  let url = WXCFG.gameUrl || '';
  if (!acc || !url) return url;
  const key = crypto.randomBytes(12).toString('hex');
  acc.wxKeys = (acc.wxKeys || []).filter(x => Date.now() - x.ts < 10 * 60 * 1000);
  acc.wxKeys.push({ k: key, ts: Date.now() });
  if (acc.wxKeys.length > 3) acc.wxKeys = acc.wxKeys.slice(-3);
  saveAcc();
  return url + (url.includes('?') ? '&' : '?') + 'wxlogin=' + key;
}
// 给绑定了微信的用户发模板消息 (房间邀请)
async function wxNotify(openid, fromName, code) {
  try {
    if (!openid || !WXCFG.templateId) return;
    const token = await wxAccessToken();
    if (!token) return;
    const acc = Object.values(accounts.users).find(a => a.wxOpenid === openid);
    const url = makeWxLoginUrl(acc);
    const res = await fetch(`https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: openid, template_id: WXCFG.templateId, url,
        data: {
          from: { value: fromName },
          code: { value: code },
          time: { value: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) },
        },
      }),
    });
    const j = await res.json();
    if (j.errcode) console.error('[wx] 模板消息发送失败', j);
  } catch (e) { console.error('[wx] 发送异常', e.message); }
}

// ================= 离线召回 (v6.6.13) =================
// 给房间里掉线的真人玩家发浏览器推送 + 微信提醒(链接带一次性登录钥匙, 点开自动登录回到牌桌)。
// 同一人 60 秒内只提醒一次, 防止网络抖动反复掉线时轰炸; 绝不自动替TA打牌。
function recallPlayer(room, seat, why) {
  const p = room.players[seat];
  if (!p || p.bot || p.online) return 'skip';
  const now = Date.now();
  if (p._lastRecall && now - p._lastRecall < 60 * 1000) return 'throttle';
  const user = p.user;
  if (!user || !accounts.users[user]) return 'noaccount';
  p._lastRecall = now;
  const name = accounts.users[user].name || p.name;
  pushUser(user, '麻将 · 牌局召回', `${name} ${why}, 房间 ${room.code}, 点此回到牌桌`);
  const acc = accounts.users[user];
  if (acc.wxOpenid) wxNotify(acc.wxOpenid, '牌局等你回来', room.code);
  return 'sent';
}
// 回调: 微信服务器验证(GET) + 用户发消息绑定/解绑(POST)
app.get('/wechat/callback', (req, res) => {
  const { signature, timestamp, nonce, echostr } = req.query;
  if (!WXCFG.token) return res.send('wx not configured');
  const s = crypto.createHash('sha1').update([WXCFG.token, timestamp, nonce].filter(Boolean).sort().join('')).digest('hex');
  res.send(s === signature ? echostr : 'signature mismatch');
});
app.post('/wechat/callback', express.text({ type: '*/*', limit: '64kb' }), (req, res) => {
  const xml = String(req.body || '');
  const get = tag => {
    const m = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`)) || xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return m ? m[1].trim() : '';
  };
  const openid = get('FromUserName'), ghId = get('ToUserName') || 'gh_c05c11eeb47b';
  const reply = text => res.type('xml').send(`<xml><ToUserName><![CDATA[${openid}]]></ToUserName><FromUserName><![CDATA[${ghId}]]></FromUserName><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${text}]]></Content></xml>`);
  try {
    const content = get('Content'), type = get('MsgType'), event = get('Event');
    const gameUrl = WXCFG.gameUrl || '';
    // 关注 → 欢迎语 + 操作指引
    if (type === 'event' && event === 'subscribe') {
      reply(`欢迎关注游戏邀请提醒助手📢\n\n只需一步: 回复你登录游戏用的账号完成绑定, 之后有人邀请你上桌, 微信会第一时间提醒你🎮\n\n游戏入口: ${gameUrl}\n\n其他指令:\n· 查询绑定状态 → 发送"状态"\n· 取消提醒 → 发送"解绑"`);
    } else if (type === 'text' && content) {
      if (content === '解绑') {
        let hit = false;
        Object.values(accounts.users).forEach(a => { if (a.wxOpenid === openid) { delete a.wxOpenid; hit = true; } });
        if (hit) { saveAcc(); reply('已解绑微信邀请提醒'); } else reply('你还没有绑定过提醒');
      } else if (content === '状态') {
        const bound = Object.values(accounts.users).find(a => a.wxOpenid === openid);
        reply(bound ? `当前绑定账号: 「${bound.name || '?'}」✅\n游戏入口: ${gameUrl}` : '你还没有绑定提醒。回复你登录游戏用的账号即可完成绑定');
      } else {
        const acc = accounts.users[content];
        if (acc) {
          Object.values(accounts.users).forEach(a => { if (a.wxOpenid === openid && a !== acc) delete a.wxOpenid; });
          acc.wxOpenid = openid; saveAcc();
          reply(`绑定成功✅ 账号「${acc.name || content}」之后收到房间邀请时, 微信会提醒你\n\n游戏入口: ${gameUrl}`);
        } else {
          reply(`没有找到账号「${content}」。请发送你登录游戏用的账号完成绑定; 查询状态发"状态", 取消提醒发"解绑"`);
        }
      }
    }
  } catch (e) { console.error('[wx] 回调处理异常', e.message); }
  res.send('success');
});

// HTML 入口禁止缓存(协商缓存): 保证浏览器每次都重新拿最新版本号引用,
// 修"部分玩家手机一直缓存旧脚本, 修过的 bug 反复出现"的问题; mp3/js 等静态资源不受影响
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    // Service Worker 必须可及时更新, 否则推送逻辑改了也下不去
    if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    // js/css 带版本号、mp3/图几乎不变 → 强缓存7天, 隧道链路慢时二次访问不再逐个回源验证
    if (/\.(js|css|mp3|png|jpg|svg|ico|woff2?)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800');
  },
}));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map(); // code -> room
const sidIndex = new Map(); // sid -> {room, seat}

function newCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c));
  return c;
}
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj, exceptSeat = -1) {  room.players.forEach((p, i) => { if (i !== exceptSeat) send(p.ws, obj); });
}
// 广播语音通话组成员 (带加入序号, 客户端据此决定谁发 offer)
function broadcastVoicePeers(room) {
  if (!room.voice) return;
  const list = Object.entries(room.voice.members).map(([s, seq]) => {
    const p = room.players[Number(s)];
    return { seat: Number(s), name: p ? p.name : '?', online: !!(p && p.ws), seq };
  });
  broadcast(room, { t: 'voice_peers', list });
}

function createRoom(ws, name) {
  const code = newCode();
  const room = { code, players: [], state: 'lobby', game: null, round: 1, dealer: 0, hostSeat: 0, timers: {} };
  rooms.set(code, room);
  joinRoom(room, ws, name);
  return room;
}

// 全员离线后房间保留 2 小时再清理, 期间随时回来都能续上
const ROOM_TTL = 2 * 60 * 60 * 1000;
function scheduleRoomCleanup(room) {
  clearTimeout(room.timers.cleanup);
  room.timers.cleanup = setTimeout(() => {
    if (!room.players.some(x => x.online)) {
      rooms.delete(room.code);
      room.players.forEach(x => sidIndex.delete(x.sid));
      console.log(`房间 ${room.code} 全员离线超过2小时, 已清理`);
    }
  }, ROOM_TTL);
}

function joinRoom(room, ws, name) {
  if (room.players.length >= 4) { send(ws, { t: 'error', msg: '房间已满(4人)' }); return; }
  const sid = crypto.randomBytes(8).toString('hex');
  const seat = room.players.length;
  const p = { ws, name, sid, seat, online: true, user: ws._user || null,
    voice: (ws._user && accounts.users[ws._user] && accounts.users[ws._user].voice) || 'f' };
  room.players.push(p);
  clearTimeout(room.timers.cleanup); // 有人回来, 取消房间清理
  ws._sid = sid;
  sidIndex.set(sid, { code: room.code, seat });
  // 开局后新加入的人一律先旁观 (本局手牌是开局时发的, 后来者进不了本局), 下一局正式加入
  const spectator = room.state !== 'lobby' && (!room.game || room.game.phase === 'over' || seat >= room.game.n);
  if (spectator) { room.spectators = room.spectators || new Set(); room.spectators.add(sid); }
  send(ws, { t: 'welcome', code: room.code, seat, sid, spectator });
  if (spectator) send(ws, { t: 'info', msg: '本局已在进行中, 你先观战, 下一局正式加入' });
  if (ws._user) { userRoom.set(ws._user, room.code); pushFriendsAll(); }
  syncRoom(room);
}

function syncRoom(room) {
  const info = {
    t: 'room',
    code: room.code,
    state: room.state,
    round: room.round,
    hostSeat: room.hostSeat,
    admins: room.players.map(q => !!(room.admins && q.sid && room.admins.has(q.sid))),
    players: room.players.map(p => ({ name: p.name, online: p.online, bot: !!p.bot, user: p.user || null })),
  };
  room.players.forEach((p, i) => send(p.ws, { ...info, seat: i }));
}

// ================= 对局核心 =================
function startGame(room) {
  const n = room.players.length;
  // 比分数组与新局人数对齐 (中途加入的人从 0 开始, 已离开的人的累计分已随座位移除)
  room.scores = room.scores || [];
  while (room.scores.length < n) room.scores.push(0);
  room.scores.length = n;
  const wall = G.shuffle(G.fullDeck());
  const flipped = wall.pop();            // 翻开亮出的牌, 移出游戏
  const wildFace = G.nextOf(flipped);    // 混儿 = 亮牌的下一张, 同牌的4张全是混儿
  const hands = [];
  for (let i = 0; i < n; i++) {
    const h = [];
    for (let k = 0; k < 13; k++) {
      const id = wall.pop();
      h.push({ id, wild: id === wildFace }); // 发到手里的混儿也是万能牌
    }
    hands.push(h);
  }
  room.game = {
    n, wall, flipped, wildFace,
    hands,
    melds: Array.from({ length: n }, () => []),
    rivers: Array.from({ length: n }, () => []),
    turn: room.dealer,
    phase: 'draw',        // draw | discard | claim | over
    discardSeq: 0,        // 出牌序号, 客户端用于检测新出牌(播语音)
    lastDraw: null,       // 本回合刚摸的牌引用
    lastDiscard: null,    // {id, wild, from}
    claims: null,         // {need:Set, got:Map, optionsBySeat, deadline}
    dealer: room.dealer,
  };
  for (let i = 0; i < n; i++) markFourthWild(room.game, i); // 家规: 第四张变儿("本该杠") — 起手就凑齐4张也要标混 (v6.6.26)
  drawTile(room);
}

function countOwned(g, seat, id) {
  let c = g.hands[seat].filter(t => t.id === id).length;
  for (const m of g.melds[seat]) c += m.tiles.filter(x => x === id).length;
  return c;
}

// 家规(v6.6.59): 进张算混判定 — 手牌(暗)里有三张真实同牌 → 第4张"本该杠"算混
// 无论这张是自己摸的(已在 drawTile 标)还是别人打的(弃牌胡/听牌计算走这里);
// 已碰过的(亮牌三张)手里没有暗三张, 天然不满足 → 别人再打第4张不算混
function incomingIsWild(tiles, id) {
  return tiles.filter(t => !t.wild && t.id === id).length === 3;
}

// 家规「第四张变儿」统一入口: 任一牌面凑齐 4 张全归我 → 手里该牌全部变万能牌 (v6.6.26)
// 之前只有摸牌/碰两条路挂了检查, 吃牌(手里3张+吃1张)和开局起手4张漏标 → 统一在这里补
function markFourthWild(g, seat) {
  const ids = new Set(g.hands[seat].map(t => t.id));
  for (const id of ids) {
    if (countOwned(g, seat, id) === 4) {
      g.hands[seat].forEach(t => { if (t.id === id && !t.wild) t.wild = true; });
    }
  }
}

function drawTile(room) {
  const g = room.game;
  const seat = g.turn;
  if (g.wall.length === 0) { endRoundDraw(room); return; }
  const tile = { id: g.wall.pop(), wild: false };
  if (tile.id === g.wildFace) tile.wild = true;
  g.hands[seat].push(tile);
  g.lastDraw = tile;
  // 第四张变儿: 四张全归我 → 刚摸的这张变万能牌
  if (!tile.wild && countOwned(g, seat, tile.id) === 4) tile.wild = true;
  g.phase = 'discard';
  syncGame(room);
  scheduleBotMove(room);
}

function doDiscard(room, seat, handIdx) {
  const g = room.game;
  clearTimeout(room.timers.turn);
  const hand = g.hands[seat];
  if (!Number.isInteger(handIdx) || handIdx < 0 || handIdx >= hand.length) {
    console.log(`[警告] 无效出牌请求 seat=${seat} idx=${handIdx} 手牌数=${hand.length}`);
    return;
  }
  const [tile] = hand.splice(handIdx, 1);
  g.lastDraw = null;
  g.lastDiscard = { id: tile.id, wild: tile.wild, from: seat, seq: ++g.discardSeq };
  g.rivers[seat].push(tile);
  g.lastDiscardRef = tile;

  // 检查其他玩家可做的动作
  const options = {}; // seat -> [acts]
  const claims = { need: new Set(), got: new Map(), optionsBySeat: {} };
  const n = g.n;
  for (let i = 1; i <= n - 1; i++) {
    const s = (seat + i) % n;
    const acts = [];
    if (!tile.wild) {
      // 胡
      if (canClaimHu(g, s, tile.id)) acts.push('hu');
      // 碰: 手里有两张真实同牌
      if (g.hands[s].filter(x => !x.wild && x.id === tile.id).length >= 2) acts.push('peng');
      // 吃: 只能吃上家(上一顺位), 且手里有真实组合
      if (i === 1) {
        const chiOpts = chiOptions(g.hands[s], tile.id);
        if (chiOpts.length) acts.push('chi');
      }
    }
    if (acts.length) {
      claims.need.add(s);
      claims.optionsBySeat[s] = {
        hu: acts.includes('hu'),
        peng: acts.includes('peng'),
        // v6.6.60 修复: 吃组合只下发给真正能吃的(下家), 否则非上家也会弹吃按钮且能吃成功
        chi: acts.includes('chi') ? chiOptions(g.hands[s], tile.id) : [],
      };
    }
  }
  if (claims.need.size > 0) {
    g.phase = 'claim';
    g.claims = claims;
    syncGame(room);
    scheduleBotClaims(room);
  } else {
    g.turn = (seat + 1) % g.n;
    drawTile(room);
  }
}

function chiOptions(hand, id) {
  const opts = [];
  const has = (x) => hand.some(t => !t.wild && t.id === x);
  const suit = G.tileSuit(id);
  if (suit < 3) {
    const inSuit = id % 9;
    if (inSuit >= 2 && has(id - 2) && has(id - 1)) opts.push([id - 2, id - 1]);
    if (inSuit >= 1 && inSuit <= 7 && has(id - 1) && has(id + 1)) opts.push([id - 1, id + 1]);
    if (inSuit <= 6 && has(id + 1) && has(id + 2)) opts.push([id + 1, id + 2]);
  }
  return opts;
}

function canClaimHu(g, seat, id) {
  const hand = g.hands[seat].map(t => ({ ...t }));
  hand.push({ id, wild: incomingIsWild(g.hands[seat], id) }); // 家规(v6.6.59): 暗三张的第4张=可杠=算混
  // 必须已开门
  if (g.melds[seat].length === 0) return false;
  return G.checkWin(hand, g.melds[seat]).hu;
}

function checkSelfHu(g, seat) {
  // 只有刚摸牌(lastDraw存在)才能自摸胡; 吃/碰完手牌凑齐也不算, 必须打出一张继续游戏
  if (!g.lastDraw) return null;
  // 家规: 必须开门(有碰/吃)才能胡
  if (g.melds[seat].length === 0) return null;
  const r = G.checkWin(g.hands[seat], g.melds[seat]);
  return r.hu ? r : null;
}

// 所有需要响应的人都表态了 → 结算; 全过 → 下家摸牌
function settleIfAllResponded(room) {
  const g = room.game;
  const claims = g.claims;
  if (!claims) return;
  const responded = [...claims.need].every(s => claims.got.has(s) && claims.got.get(s) !== undefined);
  const allPass = [...claims.need].every(s => claims.got.get(s) === 'pass');
  if (allPass) {
    g.claims = null;
    g.lastDiscardRef = null;
    g.turn = (g.lastDiscard.from + 1) % g.n;
    drawTile(room);
  } else if (responded) {
    resolveClaims(room);
  }
}

function resolveClaims(room) {
  const g = room.game;
  const claims = g.claims;
  const from = g.lastDiscard.from;
  const tile = g.lastDiscard;

  const hus = [];
  const pengs = [];
  const chis = [];
  for (const [sStr, act] of claims.got) {
    const s = Number(sStr);
    if (act === 'hu') hus.push(s);
    else if (act === 'peng') pengs.push(s);
    else if (act === 'chi') chis.push(s);
  }
  // 胡: 大胡优先, 否则按点炮者下家顺序
  let huSeat = -1;
  if (hus.length) {
    const daHuSeats = hus.filter(s => {
      const hand = g.hands[s].map(t => ({ ...t }));
      hand.push({ id: tile.id, wild: incomingIsWild(g.hands[s], tile.id) }); // 家规(v6.6.59): 暗三张的第4张算混; 碰过的不算
      return G.checkWin(hand, g.melds[s]).daHu;
    });
    const pool = daHuSeats.length ? daHuSeats : hus;
    pool.sort((a, b) => orderFrom(from, a, g.n) - orderFrom(from, b, g.n));
    huSeat = pool[0];
  }
  if (huSeat >= 0) {
    const hand = g.hands[huSeat];
    hand.push({ id: tile.id, wild: incomingIsWild(g.hands[huSeat], tile.id) }); // 家规(v6.6.59): 暗三张的第4张算混; 碰过的不算
    g.rivers[from].pop();
    doHu(room, huSeat, tile.id, false, from);
    return;
  }
  if (pengs.length) {
    pengs.sort((a, b) => orderFrom(from, a, g.n) - orderFrom(from, b, g.n));
    applyPeng(room, pengs[0]);
    return;
  }
  if (chis.length && claims.got.get(chis[0]) === 'chi') {
    applyChi(room, chis[0], claims.got.get('_chiTiles_' + chis[0]));
    return;
  }
  // 无人要 → 下家摸牌
  g.claims = null;
  g.lastDiscardRef = null;
  g.turn = (from + 1) % g.n;
  drawTile(room);
}

function orderFrom(from, seat, n) {
  return (seat - from - 1 + n) % n;
}

function applyPeng(room, seat) {
  const g = room.game;
  const from = g.lastDiscard.from;
  const id = g.lastDiscard.id;
  g.rivers[from].pop();
  const hand = g.hands[seat];
  const taken = [];
  for (let k = 0; k < 2; k++) {
    const i = hand.findIndex(t => !t.wild && t.id === id);
    taken.push(hand.splice(i, 1)[0]);
  }
  g.melds[seat].push({ type: 'peng', tiles: [id, id, id], from });
  // 第四张变儿(碰): 碰完该牌 4 张全归我 → 手里剩的那张也算混儿
  // (它是我随时可以自己补杠的牌 = "本该杠"; 注意: 别人打出的那张本身永远不变混, 只有自摸/补杠路线才给混)
  if (countOwned(g, seat, id) === 4) {
    hand.forEach(t => { if (t.id === id && !t.wild) t.wild = true; });
  }
  g.claims = null;
  g.turn = seat;
  g.phase = 'discard';
  g.lastDraw = null;
  syncGame(room);
  scheduleBotMove(room);
}

function applyChi(room, seat, tiles) {
  const g = room.game;
  const from = g.lastDiscard.from;
  const id = g.lastDiscard.id;
  g.rivers[from].pop();
  const hand = g.hands[seat];
  for (const x of tiles) {
    const i = hand.findIndex(t => !t.wild && t.id === x);
    hand.splice(i, 1);
  }
  g.melds[seat].push({ type: 'chi', tiles: [...tiles, id], from });
  // 注意: 吃牌不标「第四张变儿」— 家规的本意是"本该杠"的牌(4张全在手), 吃进的第4张已成明牌, 不算
  g.claims = null;
  g.turn = seat;
  g.phase = 'discard';
  g.lastDraw = null;
  syncGame(room);
  scheduleBotMove(room);
}

function doHu(room, seat, huTileId, selfDraw, dianpaoIdx) {
  const g = room.game;
  clearTimeout(room.timers.turn);
  const hand = g.hands[seat];
  if (!selfDraw) {
    // 点炮的牌已在 resolveClaims 中加入手牌
  } else {
    // 自摸: 牌已在手
  }
  const winRes = G.checkWin(hand, g.melds[seat]);
  const qiong = G.isQiong(hand, g.melds[seat]);
  const zhuang = seat === g.dealer;
  const result = G.settle(seat, g.n, {
    daHu: winRes.daHu, qiong, zhuang, selfDraw,
    dianpaoIdx: selfDraw ? -1 : dianpaoIdx,
    dealerIdx: g.dealer,
  });
  room.scores = room.scores || new Array(g.n).fill(0);
  result.deltas.forEach((d, i) => { room.scores[i] += d; });

  // 战绩: 胡法描述 (胡者视角, 如 "庄家点炮穷胡" / "穷大胡自摸")
  const huDesc = `${seat === g.dealer ? '庄家' : ''}${selfDraw ? '自摸' : '点炮'}${qiong ? '穷' : ''}${winRes.daHu ? '大胡' : '胡'}`;
  gameHistory.push({
    ts: Date.now(), code: room.code, round: room.round, draw: false, dealer: g.dealer,
    winner: seat, calc: result.desc,
    players: room.players.map((p, i) => {
      let desc;
      if (i === seat) desc = huDesc;
      else if (!selfDraw && i === dianpaoIdx) desc = '点炮';
      else desc = selfDraw ? '被自摸' : '被胡';
      return {
        name: p.name, user: histUser(p), bot: !!p.bot, delta: result.deltas[i], desc,
        hand: (g.hands[i] || []).map(t => ({ id: t.id, wild: !!t.wild })),
        melds: (g.melds[i] || []).map(m => ({ type: m.type, tiles: m.tiles.slice(), from: m.from })),
      };
    }),
  });
  saveHist();

  const detail = {
    t: 'result',
    winner: seat,
    winnerName: room.players[seat].name,
    winnerVoice: room.players[seat].voice || 'f',
    daHu: winRes.daHu,
    qiong, zhuang, selfDraw,
    dianpaoIdx: selfDraw ? -1 : dianpaoIdx,
    dianpaoName: selfDraw ? null : room.players[dianpaoIdx].name,
    hand: hand.map(t => ({ id: t.id, wild: t.wild })),
    melds: g.melds[seat],
    deltas: result.deltas,
    totalScores: room.scores.slice(),
    desc: result.desc,
    winTileId: huTileId,
  };
  g.phase = 'over';
  g.lastDealerWon = seat === g.dealer;
  broadcast(room, detail);
  room.state = 'over';
  syncRoom(room);
}

function endRoundDraw(room) {
  const g = room.game;
  clearTimeout(room.timers.turn);
  g.phase = 'over';
  g.lastDealerWon = false;
  room.scores = room.scores || new Array(g.n).fill(0);
  gameHistory.push({
    ts: Date.now(), code: room.code, round: room.round, draw: true, dealer: g.dealer,
    winner: null, calc: null,
    players: room.players.map((p, i) => ({
      name: p.name, user: histUser(p), bot: !!p.bot, delta: 0, desc: '流局',
      hand: (g.hands[i] || []).map(t => ({ id: t.id, wild: !!t.wild })),
      melds: (g.melds[i] || []).map(m => ({ type: m.type, tiles: m.tiles.slice(), from: m.from })),
    })),
  });
  saveHist();
  broadcast(room, {
    t: 'result', draw: true, totalScores: room.scores.slice(),
    hand: null, deltas: new Array(g.n).fill(0),
  });
  room.state = 'over';
  syncRoom(room);
}

function nextRound(room) {
  const g = room.game;
  if (g && g.lastDealerWon) {
    // 连庄
  } else {
    room.dealer = (room.dealer + 1) % room.players.length;
  }
  room.round++;
  room.state = 'playing';
  startGame(room);
  // 上一局旁观的人这一局正式加入: 重发 welcome 清掉观战标记, 客户端进入牌桌
  if (room.spectators && room.spectators.size) {
    room.spectators.forEach((sid) => {
      const idx = room.players.findIndex(q => q.sid === sid);
      if (idx >= 0 && room.players[idx].ws) {
        send(room.players[idx].ws, { t: 'welcome', code: room.code, seat: idx, sid });
      }
    });
    room.spectators.clear();
  }
}

// 每个玩家个性化的同步
function syncGame(room) {
  const g = room.game;
  if (!g) return;
  const pub = {
    turn: g.turn,
    phase: g.phase,
    wildFace: g.wildFace,
    flipped: g.flipped,
    wallCount: g.wall.length,
    dealer: g.dealer,
    lastDiscard: g.lastDiscard,
    round: room.round,
    scores: (room.scores || []).slice(),
    players: room.players.map((p, i) => ({
      name: p.name, online: p.online, voice: p.voice || 'f',
      // v6.6.60 修复: 对局中有人加入时 room.players 比本局人数多, 本局无手牌数据的座位给空值, 否则 syncGame 崩溃
      melds: g.melds[i] || [],
      river: (g.rivers[i] || []).map(t => ({ id: t.id, wild: t.wild })),
      handCount: g.hands[i] ? g.hands[i].length : 0,
    })),
  };
  room.players.forEach((p, i) => {
    if (i >= g.n) return; // 本局旁观者/座位超出本局人数: 不同步牌局数据
    if (!p.ws) return;
    const me = {
      seat: i,
      hand: g.hands[i],
      canHu: (g.phase === 'discard' && g.turn === i) ? !!checkSelfHu(g, i) : false,
      isDealer: i === g.dealer,
      // 轮到自己出牌时, 下发听牌分析: 打哪几张牌分别可以胡几张
      ting: (g.phase === 'discard' && g.turn === i) ? tingCalc(g, i) : null,
      // 已上听 (等待形态) 时常驻下发: 现在就能胡哪些牌、各剩几张 (没轮到自己也能看)
      tingReady: readyWaits(g, i),
      // 刚摸的牌只发给摸牌者本人, 用于前端放到手牌末尾
      lastDraw: (i === g.turn && g.lastDraw) ? { id: g.lastDraw.id, wild: !!g.lastDraw.wild } : null,
    };
    let myClaim = null;
    if (g.phase === 'claim' && g.claims.need.has(i) && !g.claims.got.has(i)) {
      myClaim = g.claims.optionsBySeat[i];
    }
    send(p.ws, { t: 'game', ...pub, me, myClaim });
  });
}

// ================= 机器人 (LLM 决策, 规则兜底) =================
// 连通性已实测 (2026-10-31): 三个 key 均有效
// 实测耗时 (麻将决策题, 用户接受≤19秒):
//   蓝色大肥鱼: DeepSeek deepseek-flash, 思考 effort:low → 8.2s (关思考0.7s但策略差)
//   豆包: 火山方舟 doubao-seed-2-1-pro, 关思考 → 3.5s (开思考要2分半, 必须关)
//   Z: 智谱 glm-5.3-flashx, 思考 effort:low → 9.6s (token给少了会思考超限返回空)
// 公私分离: LLM Key 存 server/secrets.json (已 gitignore, 不入库)
let SECRETS = {};
try { SECRETS = require('./secrets.json'); } catch (e) { console.error('[bot] 未找到 server/secrets.json, 机器人 LLM 不可用, 将走规则兜底'); }
const BOT_CONFIGS = [
  {
    name: '蓝色大肥鱼', model: 'deepseek-flash',
    apiKey: SECRETS.deepseek || '',
    url: 'https://api.deepseek.com/chat/completions',
    extra: { thinking: { type: 'enabled', effort: 'low' } }, maxTokens: 3000, timeout: 30000,
  },
  {
    name: '豆包', model: 'doubao-seed-2-1-pro-260628',
    apiKey: SECRETS.ark || '',
    url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    extra: { thinking: { type: 'disabled' } }, maxTokens: 700, timeout: 20000,
  },
  {
    name: 'Z', model: 'glm-5.3-flashx',
    apiKey: SECRETS.zhipu || '',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    extra: { thinking: { type: 'enabled', effort: 'low' } }, maxTokens: 3000, timeout: 30000,
  },
];

function isBot(room, seat) {
  const p = room.players[seat];
  return !!(p && p.bot);
}

function handDesc(hand) {
  return hand.map((t, i) => `${i}:${G.tileName(t.id)}${t.wild ? '(混儿)' : ''}`).join(' ');
}
function meldDesc(m) {
  return (m.type === 'peng' ? '碰' : '吃') + '[' + m.tiles.map(id => G.tileName(id)).join('') + ']';
}
function rulesText() {
  return '家规麻将规则: 136张(万饼条1-9+东南西北中发白); 混儿是万能牌但不能当幺九; 胡牌需4组(顺/刻)+1对, 必须有真幺九(要进的那张幺九算数), 必须开门(至少吃/碰过一组), 不限花色覆盖(缺哪门也能胡), 至少一个刻子(将牌是中发白时可除外); 第四张变混: 手里有暗三张时第4张(自摸或别人打)算混可胡, 已碰过的牌别人再打第4张不算混; 大胡=全刻子无顺子, 可插队优先胡; 只有吃(仅上家)和碰, 没有杠。';
}
function tableDesc(room, seat) {
  const g = room.game;
  const lines = [];
  room.players.forEach((p, i) => {
    if (i === seat || !g.hands[i]) return; // v6.6.60: 跳过本局未上桌的旁观者(无牌数据)
    lines.push(`${p.name}(座位${i}): 亮牌[${g.melds[i].map(meldDesc).join(' ') || '无'}] 牌河[${g.rivers[i].map(t => G.tileName(t.id)).join('') || '无'}] 手牌${g.hands[i].length}张`);
  });
  return lines.join('\n');
}

async function llmChat(cfg, prompt) {
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model, max_tokens: cfg.maxTokens || 1500,
        ...(cfg.extra || {}),
        messages: [
          { role: 'system', content: '你是麻将机器人玩家。只输出一个JSON对象, 不要输出任何其它文字。' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(cfg.timeout || 20000),
    });
    const j = await res.json();
    const c = j && j.choices && j.choices[0] && j.choices[0].message;
    return ((c && c.content) || '').trim();
  } catch (e) { return ''; }
}

// 规则兜底: 出牌 — 留混儿, 打出与手牌关联度最低的牌
function botChooseDiscardIdx(g, seat) {
  const hand = g.hands[seat];
  let worst = -1, worstScore = Infinity;
  hand.forEach((t, i) => {
    if (t.wild) return;
    let s = 0;
    for (const o of hand) {
      if (o.wild) continue;
      if (o.id === t.id) s += 2;
      else if (G.tileSuit(o.id) === G.tileSuit(t.id)) {
        const d = Math.abs(o.id - t.id);
        if (d === 1) s += 1; else if (d === 2) s += 0.4;
      }
    }
    if (s < worstScore) { worstScore = s; worst = i; }
  });
  return worst >= 0 ? worst : hand.length - 1;
}

function parseLlmJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

// 桌面可见牌统计: 各家牌河 + 各家副露 + 自己手牌 (其他人手牌和牌墙不可见, 不计入)
// 用于计算每种听牌"还剩几张" = 4 - 可见数
function visibleCounts(g, seat) {
  const cnt = new Array(34).fill(0);
  g.rivers.forEach(river => river.forEach(t => { cnt[t.id]++; }));
  g.melds.forEach(melds => melds.forEach(m => m.tiles.forEach(id => { cnt[id]++; })));
  g.hands[seat].forEach(t => { cnt[t.id]++; });
  return cnt;
}

// 听牌计算: 对手牌每个不同下标, 模拟打出后逐张试胡, 返回能进入听牌的出法
// 返回: [{idx, name, waits:[{id,name,n(剩几张)}], total(可胡总张数)}]
// 剩几张按桌面可见牌算 (打出的那张从手里进牌河, 可见总数不变, 无需特判)
function tingCalc(g, seat) {
  const hand = g.hands[seat];
  const melds = g.melds[seat];
  const remain = visibleCounts(g, seat).map(v => Math.max(0, 4 - v));
  const seen = new Set();
  const ready = [];
  for (let i = 0; i < hand.length; i++) {
    const t = hand[i];
    if (t.wild) continue; // 混儿不参与听牌出法枚举
    const key = t.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const rest = hand.filter((_, k) => k !== i);
    const waits = [];
    for (let id = 0; id < 34; id++) {
      if (G.checkWin([...rest, { id, wild: incomingIsWild(rest, id) }], melds).hu)
        waits.push({ id, name: G.tileName(id), n: remain[id] });
    }
    if (waits.length) {
      waits.sort((a, b) => b.n - a.n);
      ready.push({
        idx: i, name: G.tileName(t.id), waits,
        total: waits.reduce((s, w) => s + w.n, 0),
      });
    }
  }
  // 可胡总张数多的出法排前 (绝张不加总), 种数做次要排序
  ready.sort((a, b) => b.total - a.total || b.waits.length - a.waits.length);
  return ready;
}

// 手牌 tiles 是否已听牌 (来一张就能胡 — 含暗三张的第4张, 那张来时算混)
function isTingHand(tiles, melds) {
  for (let id = 0; id < 34; id++) {
    if (G.checkWin([...tiles, { id, wild: incomingIsWild(tiles, id) }], melds).hu) return true;
  }
  return false;
}

// 已上听 (手牌为等待形态 3k+1) 时, 列出当前就能胡的牌及各剩几张; 未上听/非等待形态返回 null
// 与 tingCalc 共用 visibleCounts 的"桌面可见牌"口径: 剩几张 = 4 - 可见数
function readyWaits(g, seat) {
  const hand = g.hands[seat];
  if (hand.length % 3 !== 1) return null; // 轮到自己 (3k+2) 时走 tingCalc 的"打哪张"分析
  const remain = visibleCounts(g, seat).map(v => Math.max(0, 4 - v));
  const melds = g.melds[seat];
  const waits = [];
  for (let id = 0; id < 34; id++) {
    if (G.checkWin([...hand, { id, wild: incomingIsWild(hand, id) }], melds).hu)
      waits.push({ id, name: G.tileName(id), n: remain[id] });
  }
  if (!waits.length) return null;
  waits.sort((a, b) => b.n - a.n);
  return waits;
}

// 接近度: 打出某张后, 随便换一张牌就能听牌的换法数 (越大离听牌越近)
function closenessMap(g, seat) {
  const hand = g.hands[seat];
  const melds = g.melds[seat];
  const byId = new Map();
  const list = [];
  for (let i = 0; i < hand.length; i++) {
    const t = hand[i];
    if (t.wild) continue;
    if (byId.has(t.id)) { list.push({ idx: i, name: G.tileName(t.id), score: byId.get(t.id) }); continue; }
    const rest = hand.filter((_, k) => k !== i);
    let c = 0;
    for (let id = 0; id < 34; id++) {
      if (isTingHand([...rest, { id, wild: false }], melds)) c++;
    }
    byId.set(t.id, c);
    list.push({ idx: i, name: G.tileName(t.id), score: c });
  }
  list.sort((a, b) => b.score - a.score);
  return list;
}

// 模拟碰/吃后 (再弃一张), 是否存在能听牌的打法
function meldThenTing(g, seat, type, takeIds, newMeld) {
  const hand = g.hands[seat].map(t => ({ ...t }));
  for (const id of takeIds) {
    const k = hand.findIndex(t => !t.wild && t.id === id);
    if (k < 0) return false;
    hand.splice(k, 1);
  }
  const melds = [...g.melds[seat], newMeld];
  for (let i = 0; i < hand.length; i++) {
    const rest = hand.filter((_, k) => k !== i);
    if (isTingHand(rest, melds)) return true;
  }
  return false;
}

async function botDecideDiscard(room, seat) {
  const g = room.game;
  // ① 能胡必胡 — 纯代码判断, 0秒, 不问模型
  if (checkSelfHu(g, seat)) return { action: 'hu' };
  const ting = tingCalc(g, seat);
  // ② 听牌 → 打"可胡总张数"最多的那张 (每张听牌按桌面可见牌折算剩几张, 绝张不加分), 0秒。
  //    不是硬锁: 每回合重新计算, 手牌变化后听牌列表随之更新, 可自由换听。
  if (ting.length) return { action: 'discard', idx: ting[0].idx };
  const closeness = closenessMap(g, seat);
  const closeText = closeness.slice(0, 5).map(c => `下标${c.idx}(${c.name})接近度${c.score}`).join('; ');
  // 提醒 LLM 混儿的价值 (接近度列表不含混儿, 弱模型容易把它当闲张打掉)
  const wildIdx = g.hands[seat].map((t, i) => t.wild ? i : -1).filter(i => i >= 0);
  const wildNote = wildIdx.length ? `\n【特别注意】下标${wildIdx.join('、')}是混儿(万能牌, 能当任何牌用但不能当幺九), 是手里最值钱的牌, 留着凑刻/将都行, 绝对不要打出去。` : '';
  const fallback = () => {
    // 规则兜底: 接近度最高 > 关联度孤张 (有听牌出法已在上面直接打, 不会到这里)
    if (closeness.length && closeness[0].score > 0) return { action: 'discard', idx: closeness[0].idx };
    return { action: 'discard', idx: botChooseDiscardIdx(g, seat) };
  };
  const cfg = room.players[seat] && room.players[seat].botCfg;
  if (!cfg) return fallback();
  const prompt = `${rulesText()}
你(座位${seat}, 昵称${room.players[seat].name})的手牌(下标:牌): ${handDesc(g.hands[seat])}
你的亮牌: ${g.melds[seat].map(meldDesc).join(' ') || '无(还没开门)'}
桌上其它玩家:
${tableDesc(room, seat)}
牌墙剩余: ${g.wall.length} 张
【接近度(打出该张后离听牌的距离, 越大越好; 目前打任何一张都不能直接听牌)】${closeText}${wildNote}
出牌优先级: ①选接近度最高的方向推进(拆搭留搭自己判断); ②参考桌上的牌避免点炮。
只输出JSON: {"action":"discard","idx":手牌下标}`;
  const text = await llmChat(cfg, prompt);
  const j = parseLlmJson(text);
  if (j) {
    const idx = Number(j.idx);
    if (j.action === 'discard' && Number.isInteger(idx) && idx >= 0 && idx < g.hands[seat].length) return { action: 'discard', idx };
  }
  return fallback();
}

async function botDecideClaim(room, seat) {
  const g = room.game;
  const opts = g.claims.optionsBySeat[seat];
  const discId = g.lastDiscard.id;
  // ① 能胡必胡 — 纯代码判断, 0秒, 不问模型
  if (opts.hu) return { action: 'hu' };
  // ② 模拟碰/吃后再弃一张能听牌 → 立即执行, 0秒
  if (opts.peng && meldThenTing(g, seat, 'peng', [discId, discId], { type: 'peng', tiles: [discId, discId, discId], from: g.lastDiscard.from })) {
    return { action: 'peng' };
  }
  if (opts.chi && opts.chi.length) {
    for (const o of opts.chi) {
      if (meldThenTing(g, seat, 'chi', o, { type: 'chi', tiles: [...o, discId], from: g.lastDiscard.from })) {
        return { action: 'chi', tiles: o };
      }
    }
  }
  // ③ 还没开门 → 能碰/吃就开门 (家规不开门不能胡, 不开门等死)
  if (g.melds[seat].length === 0) {
    if (opts.peng) return { action: 'peng' };
    if (opts.chi && opts.chi.length) return { action: 'chi', tiles: opts.chi[0] };
    return { action: 'pass' };
  }
  const fallback = () => {
    if (opts.peng) return { action: 'peng' };
    if (opts.chi && opts.chi.length) return { action: 'chi', tiles: opts.chi[0] };
    return { action: 'pass' };
  };
  const cfg = room.players[seat] && room.players[seat].botCfg;
  if (!cfg) return fallback();
  const acts = [];
  if (opts.peng) acts.push('"peng"=碰');
  if (opts.chi && opts.chi.length) acts.push(`"chi"=吃(组合序号: ${opts.chi.map((o, k) => k + '=' + o.map(id => G.tileName(id)).join('')).join(', ')})`);
  acts.push('"pass"=过');
  const prompt = `${rulesText()}
你(座位${seat}, 昵称${room.players[seat].name})的手牌(下标:牌): ${handDesc(g.hands[seat])}
你的亮牌: ${g.melds[seat].map(meldDesc).join(' ')}
刚有玩家打出: ${G.tileName(discId)}${g.lastDiscard.wild ? '(这是混儿, 不能吃碰)' : ''}
你可以选择: ${acts.join(', ')}
判断要点: 碰/吃若能帮你组牌或推进听牌就做; 若会拆散好牌型或给你留太多孤张则过。
只输出JSON: {"action":"peng"} / {"action":"chi","opt":组合序号} / {"action":"pass"}`;
  const text = await llmChat(cfg, prompt);
  const j = parseLlmJson(text);
  if (j) {
    if (j.action === 'peng' && opts.peng) return { action: 'peng' };
    if (j.action === 'chi' && opts.chi && opts.chi.length) {
      const oi = Number(j.opt);
      if (Number.isInteger(oi) && oi >= 0 && oi < opts.chi.length) return { action: 'chi', tiles: opts.chi[oi] };
      return { action: 'chi', tiles: opts.chi[0] };
    }
    if (j.action === 'pass') return { action: 'pass' };
  }
  return fallback();
}

function scheduleBotMove(room) {
  const g = room.game;
  if (!g || g.phase !== 'discard' || !isBot(room, g.turn)) return;
  const seat = g.turn;
  clearTimeout(room.timers['bot' + seat]);
  room.timers['bot' + seat] = setTimeout(async () => {
    const g2 = room.game;
    if (!g2 || g2.phase !== 'discard' || g2.turn !== seat || !isBot(room, seat)) return;
    const dec = await botDecideDiscard(room, seat);
    const g3 = room.game;
    if (!g3 || g3.phase !== 'discard' || g3.turn !== seat || !isBot(room, seat)) return;
    if (dec.action === 'hu') {
      const huTile = g3.lastDraw || g3.hands[seat][g3.hands[seat].length - 1];
      return doHu(room, seat, huTile.id, true, -1);
    }
    doDiscard(room, seat, dec.idx);
  }, 1000 + Math.random() * 900);
}

function scheduleBotClaims(room) {
  const g = room.game;
  if (!g || g.phase !== 'claim' || !g.claims) return;
  for (const seat of g.claims.need) {
    if (!isBot(room, seat)) continue;
    clearTimeout(room.timers['botclaim' + seat]);
    room.timers['botclaim' + seat] = setTimeout(async () => {
      const g2 = room.game;
      if (!g2 || g2.phase !== 'claim' || !g2.claims || !g2.claims.need.has(seat) || g2.claims.got.has(seat)) return;
      const dec = await botDecideClaim(room, seat);
      const g3 = room.game;
      if (!g3 || g3.phase !== 'claim' || !g3.claims || !g3.claims.need.has(seat) || g3.claims.got.has(seat)) return;
      const opts = g3.claims.optionsBySeat[seat];
      if (dec.action === 'hu' && opts.hu) g3.claims.got.set(seat, 'hu');
      else if (dec.action === 'peng' && opts.peng) g3.claims.got.set(seat, 'peng');
      else if (dec.action === 'chi' && opts.chi && opts.chi.length) {
        const ok = opts.chi.some(o => o[0] === dec.tiles[0] && o[1] === dec.tiles[1]);
        g3.claims.got.set(seat, 'chi');
        g3.claims.got.set('_chiTiles_' + seat, ok ? dec.tiles : opts.chi[0]);
      } else g3.claims.got.set(seat, 'pass');
      syncGame(room);
      settleIfAllResponded(room);
    }, 800 + Math.random() * 800);
  }
}

// ================= WebSocket 处理 =================
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handle(ws, msg); } catch (e) { console.error(e); send(ws, { t: 'error', msg: '服务器内部错误' }); }
  });
  ws.on('close', () => {
    if (ws._user && onlineUsers.get(ws._user) === ws) {
      onlineUsers.delete(ws._user);
      userRoom.delete(ws._user);
      pushFriendsAll();
    }
    const ref = sidIndex.get(ws._sid);
    if (!ref) return;
    const room = rooms.get(ref.code);
    if (!room) return;
    // 掉线时移出语音通话组
    if (room.voice && room.voice.members[ref.seat] !== undefined) {
      delete room.voice.members[ref.seat];
      broadcastVoicePeers(room);
    }
    const p = room.players[ref.seat];
    if (p) {
      p.online = false; p.ws = null;
      // 不再自动推送/微信轰炸 (v6.6.27): 想召回TA的人点头像弹框手动「发消息」
    }
    if (room.state === 'lobby' && room.players.every(x => !x.online)) {
      scheduleRoomCleanup(room); // 不立刻解散, 保留2小时等人回来
    } else {
      syncRoom(room);
      if (room.game && room.game.phase !== 'over') syncGame(room);
    }
  });
});

// 心跳: 每 30 秒清理一次僵尸连接(手机后台挂起但没有触发 close 的情况)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

function handle(ws, msg) {
  const ref = ws._sid ? sidIndex.get(ws._sid) : null;
  const room = ref ? rooms.get(ref.code) : null;
  if (process.env.MJ_LOG) console.log(`[消息] t=${msg.t} seat=${ref ? ref.seat : '?'} code=${msg.code || (room && room.code) || '-'}`);

  switch (msg.t) {
    case 'create': {
      if (typeof msg.name !== 'string' || !msg.name.trim()) return send(ws, { t: 'error', msg: '请输入昵称' });
      createRoom(ws, msg.name.trim().slice(0, 8));
      break;
    }
    case 'join': {
      if (typeof msg.name !== 'string' || !msg.name.trim()) return send(ws, { t: 'error', msg: '请输入昵称' });
      const r = rooms.get(String(msg.code));
      if (!r) return send(ws, { t: 'error', msg: '房间不存在' });
      if (r.players.length >= 4) return send(ws, { t: 'error', msg: '房间已满(4人)' });
      // 开局中也允许加入: 本局旁观, 下一局正式加入 (joinRoom 内部标记 spectator)
      joinRoom(r, ws, msg.name.trim().slice(0, 8));
      break;
    }
    case 'register': {
      const user = String(msg.user || '').trim();
      const pass = String(msg.pass || '');
      const name = (String(msg.name || '').trim() || user).slice(0, 8);
      if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,16}$/.test(user)) return send(ws, { t: 'error', msg: '账号需 2-16 位(中文/字母/数字/下划线)' });
      if (pass.length < 4) return send(ws, { t: 'error', msg: '密码至少 4 位' });
      if (accounts.users[user]) return send(ws, { t: 'error', msg: '该账号已被注册' });
      const salt = crypto.randomBytes(8).toString('hex');
      accounts.users[user] = { salt, pass: hashPass(salt, pass), name, token: crypto.randomBytes(16).toString('hex'), friends: [], requests: [] };
      saveAcc();
      doLogin(ws, user);
      break;
    }
    case 'login': {
      const user = String(msg.user || '').trim();
      const a = accounts.users[user];
      if (!a || a.pass !== hashPass(a.salt, String(msg.pass || ''))) return send(ws, { t: 'error', msg: '账号或密码错误' });
      doLogin(ws, user, { manual: true });
      break;
    }
    case 'auto_login': {
      const user = Object.keys(accounts.users).find(k => accounts.users[k].token === msg.token);
      if (user) doLogin(ws, user);
      break;
    }
    case 'wx_login': {
      // 微信邀请模板消息链接带的一次性登录钥匙: 10分钟内有效, 用过即作废 (v6.6.13)
      const key = String(msg.key || '');
      const now = Date.now();
      const user = Object.keys(accounts.users).find(k => (accounts.users[k].wxKeys || []).some(x => x.k === key && now - x.ts < 10 * 60 * 1000));
      if (!user) return send(ws, { t: 'error', msg: '微信登录链接已失效, 请手动登录' });
      const acc = accounts.users[user];
      acc.wxKeys = (acc.wxKeys || []).filter(x => x.k !== key);
      saveAcc();
      doLogin(ws, user);
      break;
    }
    case 'push_sub': {
      // 浏览器推送订阅: 登录用户上报, 存到账号下 (同一浏览器重复上报按 endpoint 去重)
      if (!ws._user) break;
      const sub = msg.sub;
      if (!sub || !sub.endpoint) break;
      const a = accounts.users[ws._user];
      a.pushSubs = (a.pushSubs || []).filter(x => x.endpoint !== sub.endpoint);
      a.pushSubs.push(sub);
      if (a.pushSubs.length > 5) a.pushSubs = a.pushSubs.slice(-5); // 每人最多留5台设备
      saveAcc();
      break;
    }
    case 'push_sub_off': {
      // 用户在首页关闭通知: 清掉该账号所有订阅
      if (!ws._user) break;
      const a = accounts.users[ws._user];
      if (a && a.pushSubs && a.pushSubs.length) { a.pushSubs = []; saveAcc(); }
      break;
    }
    case 'logout': {
      if (ws._user && onlineUsers.get(ws._user) === ws) { onlineUsers.delete(ws._user); userRoom.delete(ws._user); }
      ws._user = null;
      send(ws, { t: 'logged_out' });
      pushFriendsAll();
      break;
    }
    case 'add_friend': {
      if (!ws._user) return send(ws, { t: 'error', msg: '请先登录' });
      const target = String(msg.user || '').trim();
      if (target === ws._user) return send(ws, { t: 'error', msg: '不能添加自己' });
      const a = accounts.users[target];
      if (!a) return send(ws, { t: 'error', msg: '没有这个账号' });
      const meAcc = accounts.users[ws._user];
      if ((meAcc.friends || []).includes(target)) return send(ws, { t: 'error', msg: '已经是好友了' });
      if ((a.requests || []).includes(ws._user) || (meAcc.requests || []).includes(target)) {
        becomeFriends(ws._user, target); // 互加直接成为好友
        return send(ws, { t: 'info', msg: `已和 ${a.name} 成为好友` });
      }
      a.requests = a.requests || [];
      if (!a.requests.includes(ws._user)) a.requests.push(ws._user);
      saveAcc();
      pushFriendsAll();
      send(ws, { t: 'info', msg: `已向 ${a.name} 发送好友请求, 对方同意后成为好友` });
      break;
    }
    case 'accept_friend': {
      if (!ws._user) return;
      const target = String(msg.user || '');
      if (accounts.users[target]) becomeFriends(ws._user, target);
      break;
    }
    case 'decline_friend': {
      if (!ws._user) return;
      const meAcc = accounts.users[ws._user];
      meAcc.requests = (meAcc.requests || []).filter(u => u !== String(msg.user || ''));
      saveAcc();
      pushFriendsAll();
      break;
    }
    case 'invite': {
      if (!ws._user) return send(ws, { t: 'error', msg: '请先登录' });
      // 房主一点邀请就立刻建房入座 (同意的人之后才加入房间)
      let myRef = ws._sid ? sidIndex.get(ws._sid) : null;
      if (myRef && rooms.get(myRef.code) && rooms.get(myRef.code).players.length >= 4)
        return send(ws, { t: 'error', msg: '房间已满(4人), 不能邀请' });
      let roomCode = myRef ? myRef.code : (userRoom.get(ws._user) || null);
      if (roomCode) {
        // 校验房间真实有效: 必须存在、未满员、且房主本人真的在座在线 (防陈旧映射)
        const r = rooms.get(roomCode);
        const valid = r && r.players.length < 4 && r.players.some(p => p.ws === ws && p.online);
        if (!valid) { roomCode = null; userRoom.delete(ws._user); }
      }
      if (!roomCode) roomCode = createRoom(ws, accounts.users[ws._user].name).code;
      const target = String(msg.user || '');
      const tws = onlineUsers.get(target);
      if (!tws || tws.readyState !== 1) {
        // 对方不在线 → 排队, 10分钟内上线自动送达 + 推一条系统通知
        const a = accounts.users[target];
        a.pendingInvites = (a.pendingInvites || []).filter(iv => Date.now() - iv.ts < 10 * 60 * 1000);
        a.pendingInvites.push({ from: ws._user, fromName: accounts.users[ws._user].name, code: roomCode, ts: Date.now() });
        if (a.pendingInvites.length > 5) a.pendingInvites = a.pendingInvites.slice(-5);
        saveAcc();
        pushUser(target, '麻将 · 房间邀请', `${accounts.users[ws._user].name} 邀请你加入房间 ${roomCode}, 点此进入`);
        if (a.wxOpenid) wxNotify(a.wxOpenid, accounts.users[ws._user].name, roomCode);
        return send(ws, { t: 'info', msg: `${a.name}暂时不在线, 邀请已保存, 对方上线会立即收到` });
      }
      send(tws, { t: 'invite', from: ws._user, fromName: accounts.users[ws._user].name, code: roomCode });
      send(ws, { t: 'info', msg: `已向 ${accounts.users[target].name} 发出邀请` });
      break;
    }
    case 'accept_invite': {
      // 被邀请的人点"加入": 加入邀请人所在的房间; 邀请人若无有效房间则现场为其建房入座
      if (!ws._user) return send(ws, { t: 'error', msg: '请先登录后再接受邀请' });
      if (ws._sid && sidIndex.get(ws._sid)) return send(ws, { t: 'error', msg: '你已在房间中, 请先退出再加入' });
      const from = String(msg.from || '');
      const fromAcc = accounts.users[from];
      const fromWs = onlineUsers.get(from);
      if (!fromAcc || !fromWs || fromWs.readyState !== 1) return send(ws, { t: 'error', msg: '邀请你的人现在不在线' });
      let targetRoom = null;
      const fromRef = fromWs._sid ? sidIndex.get(fromWs._sid) : null;
      if (fromRef) targetRoom = rooms.get(fromRef.code);
      if (!targetRoom && userRoom.get(from)) targetRoom = rooms.get(userRoom.get(from));
      // 邀请人必须真的在这个房间里在线, 否则视为无效 (防陈旧映射)
      if (targetRoom && !targetRoom.players.some(p => p.ws === fromWs && p.online)) targetRoom = null;
      if (!targetRoom) targetRoom = createRoom(fromWs, fromAcc.name);
      if (targetRoom.players.length >= 4) return send(ws, { t: 'error', msg: '对方的房间已满(4人)' });
      // 开局中也允许加入: 本局旁观, 下一局正式加入
      joinRoom(targetRoom, ws, accounts.users[ws._user].name);
      break;
    }
    case 'leave_room': {
      if (!room) return;
      const leaverName = room.players[ref.seat] ? room.players[ref.seat].name : '有人';
      // v6.6.60: 旁观者(本局没上桌)退出不算弃局, 不作废牌局
      const leaverIsSpectator = room.game && room.game.n != null && ref.seat >= room.game.n;
      const midHand = room.state === 'playing' && room.game && room.game.phase !== 'over' && !leaverIsSpectator;
      send(ws, { t: 'left_room' });
      if (midHand) {
        // 牌局中退出: 本局作废(不算钱), 房间保留, 剩下的人可以下一局继续
        // v6.6.31: 排除退出者本人 — 他已经离开, 不应再收到"本局作废"的结算弹窗
        clearTimeout(room.timers.turn);
        room.game.phase = 'over';
        room.state = 'over';
        broadcast(room, {
          t: 'result', draw: true, voidMsg: `${leaverName} 退出了, 本局作废`,
          deltas: new Array(room.game.n).fill(0),
          totalScores: (room.scores || []).slice(),
        }, ref.seat);
      }
      removePlayer(room, ref.seat); // 内部处理: 语音清理/座位前移/比分对齐/剩1人解散
      break;
    }
    case 'dissolve_room': {
      if (!room) return;
      if (!hasPower(room, ref.seat)) return send(ws, { t: 'error', msg: '只有房主或管理员能解散房间' });
      dissolveAll(room, '房主已解散房间');
      break;
    }
    case 'kick': {
      // 房主/管理员踢人: 防止有人离开没点退出, 牌局卡死; 管理员可以踢房主
      if (!room) return;
      if (!hasPower(room, ref.seat)) return send(ws, { t: 'error', msg: '只有房主或管理员能踢人' });
      const target = Number(msg.seat);
      if (!Number.isInteger(target) || target < 0 || target >= room.players.length) return;
      if (target === ref.seat) return send(ws, { t: 'error', msg: '不能踢自己' });
      const tp = room.players[target];
      if (!tp) return;
      const name = tp.name;
      const kicker = room.players[ref.seat];
      const kickerTitle = ref.seat === room.hostSeat ? '房主' : '管理员';
      // v6.6.60: 踢掉的是旁观者(本局没上桌)不作废牌局
      const targetIsSpectator = room.game && room.game.n != null && target >= room.game.n;
      if (room.state === 'playing' && room.game && room.game.phase !== 'over' && !targetIsSpectator) {
        // 牌局中踢人: 本局作废(不算钱), 房间保留, 剩下的人可以继续
        // v6.6.31: 排除被踢者本人 — 他马上会收到 kicked 消息, 不再叠加"本局作废"弹窗
        clearTimeout(room.timers.turn);
        room.game.phase = 'over';
        room.state = 'over';
        broadcast(room, {
          t: 'result', draw: true, voidMsg: `${name} 被${kickerTitle}请出了房间, 本局作废`,
          deltas: new Array(room.game.n).fill(0),
          totalScores: (room.scores || []).slice(),
        }, target);
      }
      if (tp.ws) send(tp.ws, { t: 'kicked', msg: `你被${kickerTitle} ${kicker ? kicker.name : ''} 请出了房间` });
      removePlayer(room, target); // 内部处理: 语音清理/权限交接/座位前移/比分对齐/剩1人解散
      broadcast(room, { t: 'info', msg: `${name} 被${kickerTitle}请出了房间` });
      break;
    }
    case 'apply_admin': {
      // 普通玩家申请管理员: 房主弹窗审批, 100 秒未处理自动通过
      if (!room || !ref) return;
      const p = room.players[ref.seat];
      if (!p) return;
      if (ref.seat === room.hostSeat) return send(ws, { t: 'error', msg: '你已经是房主了' });
      if (isAdmin(room, ref.seat)) return send(ws, { t: 'error', msg: '你已经是管理员了' });
      clearAdminReq(room); // 新申请覆盖旧申请
      room.adminReq = { sid: p.sid, ts: Date.now() };
      const hp = room.players[room.hostSeat];
      broadcast(room, { t: 'admin_request', seat: ref.seat, name: p.name });
      send(ws, { t: 'info', msg: hp ? `已向房主 ${hp.name} 发出管理员申请, 100秒未处理将自动通过` : '管理员申请已发出' });
      room.timers.adminReq = setTimeout(() => {
        if (rooms.has(room.code) && room.adminReq && room.adminReq.sid === p.sid) grantAdmin(room, p.sid, true);
      }, 100000);
      break;
    }
    case 'admin_reply': {
      // 房主审批管理员申请: accept=true 通过 / false 拒绝
      if (!room || !ref) return;
      if (ref.seat !== room.hostSeat) return send(ws, { t: 'error', msg: '只有房主能处理管理员申请' });
      if (!room.adminReq) return send(ws, { t: 'error', msg: '没有待处理的管理员申请' });
      const sid = room.adminReq.sid;
      const p = room.players.find(q => q.sid === sid);
      if (msg.accept) {
        grantAdmin(room, sid, false);
      } else {
        clearAdminReq(room);
        broadcast(room, { t: 'admin_request_done' });
        if (p) send(ws, { t: 'info', msg: `已拒绝 ${p.name} 的管理员申请` });
      }
      break;
    }
    case 'ping': send(ws, { t: 'pong' }); break;
    case 'set_voice': {
      if (!ref) return;
      const v = msg.voice === 'm' ? 'm' : 'f';
      const p = room && room.players[ref.seat];
      if (p) p.voice = v;
      if (ws._user && accounts.users[ws._user]) { accounts.users[ws._user].voice = v; saveAcc(); }
      if (room && room.game) syncGame(room); else if (room) syncRoom(room);
      break;
    }
    // ===== 房间语音通话信令 (WebRTC mesh, 服务器只转发) =====
    case 'voice_hello': {
      if (!room || !ref) return;
      if (!room.voice) room.voice = { seq: 0, members: {} };
      room.voice.members[ref.seat] = ++room.voice.seq;
      broadcastVoicePeers(room);
      break;
    }
    case 'voice_bye': {
      if (room && room.voice && room.voice.members[ref.seat] !== undefined) {
        delete room.voice.members[ref.seat];
        broadcastVoicePeers(room);
      }
      break;
    }
    case 'voice_offer': case 'voice_answer': case 'voice_ice': {
      if (!room || !ref) return;
      const to = Number(msg.to);
      const target = room.players[to];
      if (!target || !target.ws) return;
      send(target.ws, { t: msg.t, from: ref.seat, sdp: msg.sdp, c: msg.c });
      break;
    }
    case 'chat': {
      if (!room || !ref) return;
      const sender = room.players[ref.seat];
      if (!sender) return;
      let chat;
      if (msg.q != null) {
        // 快捷语录: 只认 0-10, 转发时带上发送者的声音设置 (接收方按此播 Man/Woman 语音)
        const q = msg.q | 0;
        if (q < 0 || q > 10) return;
        chat = { seat: ref.seat, name: sender.name, q, voice: sender.voice || 'f', ts: Date.now() };
      } else {
        const text = String(msg.text || '').trim().slice(0, 100);
        if (!text) return;
        chat = { seat: ref.seat, name: sender.name, text, ts: Date.now() };
      }
      if (!Array.isArray(room.chat)) room.chat = [];
      room.chat.push(chat);
      if (room.chat.length > 50) room.chat.splice(0, room.chat.length - 50);
      broadcast(room, { t: 'chat', ...chat });
      break;
    }
    case 'recall': {
      // 手动召回: 房间里任何人都可以提醒掉线的真人玩家回来 (推送+微信, 60秒限流)
      if (!room) return send(ws, { t: 'error', msg: '请先进房间' });
      const rSeat = Number(msg.seat);
      const rp = room.players[rSeat];
      if (!rp) return send(ws, { t: 'error', msg: '没有这个座位' });
      if (rp.bot) return send(ws, { t: 'info', msg: '机器人不用召回' });
      if (rp.online) return send(ws, { t: 'info', msg: rp.name + ' 还在线, 不用召回' });
      const rr = recallPlayer(room, rSeat, (room.state === 'playing' && room.game && room.game.phase !== 'over') ? '牌局还在进行, 大家等你' : '房间里大家在等你');
      const tips = {
        sent: `已提醒 ${rp.name} 回来(推送+微信, 10分钟内点开链接自动登录)`,
        throttle: `刚提醒过 ${rp.name}, 一分钟内不重复轰炸`,
        noaccount: `${rp.name} 没有登录账号, 没法推送提醒`,
      };
      send(ws, { t: 'info', msg: tips[rr] || '已尝试提醒' });
      break;
    }
    case 'remind': {
      // 点头像弹框里的「发消息」: 给离线玩家发提醒, 一次性 — 发过之后等TA回来才能再发 (v6.6.26)
      if (!room || !ref) return send(ws, { t: 'error', msg: '请先进房间' });
      const mSeat = Number(msg.target);
      const mp = room.players[mSeat];
      if (!mp || mSeat === ref.seat) return;
      if (mp.bot) return send(ws, { t: 'info', msg: '机器人不用提醒' });
      if (mp.online) return send(ws, { t: 'info', msg: mp.name + ' 已经在线了' });
      if (mp._remindSent) return send(ws, { t: 'info', msg: '已经给 ' + mp.name + ' 发过消息了, 等TA回来吧' });
      mp._remindSent = true;
      recallPlayer(room, mSeat, (room.state === 'playing' && room.game && room.game.phase !== 'over') ? '牌局还在进行, 大家等你回来' : '房间里大家在等你回来');
      send(ws, { t: 'info', msg: '已给 ' + mp.name + ' 发送消息(推送+微信)' });
      break;
    }
    case 'interact': {
      // 互动道具: 送花/扔鸡蛋/泼水/倒茶/爪子挠 — 广播给全桌, 每人播音效+弹提示 (v6.6.26)
      if (!room || !ref) return;
      const kinds = { flower: '送了一朵花', egg: '扔了一个鸡蛋', water: '泼了一盆水', tea: '倒了一杯茶', paw: '挠了一下' };
      const kind = String(msg.kind || '');
      if (!kinds[kind]) return;
      const tSeat = Number(msg.target);
      const tp = room.players[tSeat];
      if (!tp || tSeat === ref.seat) return;
      const now = Date.now();
      room._interactAt = room._interactAt || {};
      if (now - (room._interactAt[ref.seat + ':' + kind] || 0) < 5000) return; // 同一互动5秒限流
      room._interactAt[ref.seat + ':' + kind] = now;
      broadcast(room, { t: 'interact', from: ref.seat, fromName: (room.players[ref.seat] || {}).name || '?', target: tSeat, targetName: tp.name || '?', kind });
      break;
    }
    case 'rejoin': {
      const r = rooms.get(String(msg.code));
      if (!r) return send(ws, { t: 'error', msg: '房间已解散' });
      const seat = r.players.findIndex(p => p.sid === msg.sid);
      if (seat < 0) return send(ws, { t: 'error', msg: '座位已失效' });
      r.players[seat].ws = ws;
      r.players[seat].online = true;
      r.players[seat]._remindSent = false; // 回来了, 头像弹框里的「发消息」重新可用 (v6.6.26)
      r.players[seat].user = ws._user || r.players[seat].user || null;
      clearTimeout(r.timers.cleanup);
      ws._sid = msg.sid;
      // 已在座的人重连: 牌局进行中且自己不在本局名单里才是观战 (局间重连是正式玩家)
      const spectator = r.state !== 'lobby' && r.game && r.game.phase !== 'over' && seat >= r.game.n;
      send(ws, { t: 'welcome', code: r.code, seat, sid: msg.sid, spectator });
      if (Array.isArray(r.chat) && r.chat.length) send(ws, { t: 'chat_history', list: r.chat });
      if (ws._user) { userRoom.set(ws._user, r.code); pushFriendsAll(); }
      syncRoom(r);
      if (r.game) syncGame(r);
      break;
    }
    case 'reclaim': {
      // 多设备/换打开方式协调 (v6.6.27): 新设备登录成功后若本机没有牌局会话,
      // 按账号找回还在座的座位并接管 — 浏览器掉线后从微信里打开也能直接回到牌桌
      if (!ws._user) break;
      if (ws._sid && sidIndex.get(ws._sid)) break; // 本连接已在房间, 不用找回
      for (const r of rooms.values()) {
        const seat = r.players.findIndex(p => p.user === ws._user && !p.bot);
        if (seat < 0) continue;
        const p = r.players[seat];
        if (p.online && p.ws && p.ws.readyState === 1) {
          return send(ws, { t: 'info', msg: '你的座位正在其他设备上在线, 未接管' });
        }
        if (p.sid) sidIndex.delete(p.sid); // 旧设备sid作废
        const sid = crypto.randomBytes(12).toString('hex');
        p.sid = sid; p.ws = ws; p.online = true;
        p._remindSent = false; // 回来了, 头像弹框里的「发消息」重新可用
        sidIndex.set(sid, { code: r.code, seat });
        clearTimeout(r.timers.cleanup);
        ws._sid = sid;
        const spectator = r.state !== 'lobby' && r.game && r.game.phase !== 'over' && seat >= r.game.n;
        send(ws, { t: 'welcome', code: r.code, seat, sid, spectator });
        if (Array.isArray(r.chat) && r.chat.length) send(ws, { t: 'chat_history', list: r.chat });
        userRoom.set(ws._user, r.code); pushFriendsAll();
        syncRoom(r);
        if (r.game) syncGame(r);
        return;
      }
      break;
    }
    case 'add_bot': {
      if (!room) return;
      if (ref.seat !== room.hostSeat) return send(ws, { t: 'error', msg: '只有房主能添加机器人' });
      if (room.players.length >= 4) return send(ws, { t: 'error', msg: '房间已满(4人)' });
      // 对局中也能加: 牌墙补发13张给新AI, 座次追加在末尾(不移动他人座位)
      const gNow = room.game;
      const midGame = room.state === 'playing' && gNow && gNow.phase !== 'over';
      if (room.state !== 'lobby' && !midGame) return send(ws, { t: 'error', msg: '当前状态不能添加机器人' });
      if (midGame && gNow.wall.length < 13) return send(ws, { t: 'error', msg: '牌墙剩牌不足, 无法中途加入' });
      // 支持指定机器人并可重复添加: msg.bot 为配置下标(缺省轮换), 重名自动加编号
      let cfg = BOT_CONFIGS[Number(msg.bot) || 0] || BOT_CONFIGS[0];
      const base = cfg.name;
      let name = base, n = 2;
      const used = new Set(room.players.map(p => p.name));
      while (used.has(name)) name = base + n++;
      const bot = { ws: null, name, sid: null, seat: room.players.length, online: true, bot: true, botCfg: cfg, voice: Math.random() < 0.5 ? 'm' : 'f' };
      room.players.push(bot);
      if (midGame) {
        room.scores.push(0); // 本局从0计
        gNow.n = room.players.length;
        const h = [];
        for (let k = 0; k < 13; k++) { const id = gNow.wall.pop(); h.push({ id, wild: id === gNow.wildFace }); }
        gNow.hands.push(h);
        gNow.melds.push([]);
        gNow.rivers.push([]);
        syncRoom(room);
        syncGame(room);
        send(ws, { t: 'info', msg: `${name} 中途加入, 已补13张牌` });
      } else {
        syncRoom(room);
      }
      break;
    }
    case 'remove_bot': {
      if (!room || room.state !== 'lobby') return;
      if (ref.seat !== room.hostSeat) return send(ws, { t: 'error', msg: '只有房主能移除机器人' });
      // 支持按座位号移除指定机器人, 缺省移除最后一个
      let idx = Number.isInteger(msg.seatIdx) ? msg.seatIdx : -1;
      if (idx < 0 || !room.players[idx] || !room.players[idx].bot) {
        for (let i = room.players.length - 1; i >= 0; i--) if (room.players[i].bot) { idx = i; break; }
      }
      if (idx >= 0) removePlayer(room, idx);
      break;
    }
    case 'history': {
      if (!ws._user) return send(ws, { t: 'history', list: [] });
      const list = [];
      for (let i = gameHistory.length - 1; i >= 0 && list.length < 300; i--) {
        const r = gameHistory[i];
        const pi = r.players.findIndex(p => p.user === ws._user);
        if (pi < 0) continue;
        const mine = r.players[pi];
        list.push({
          ts: r.ts, code: r.code, draw: !!r.draw, isDealer: pi === r.dealer,
          delta: mine.delta, desc: mine.desc,
          // 详情: 和谁玩的、谁胡了、各家输赢、我的牌
          players: r.players.map(p => ({ name: p.name, bot: !!p.bot, delta: p.delta, desc: p.desc })),
          winnerName: (r.winner != null && r.players[r.winner]) ? r.players[r.winner].name : null,
          calc: r.calc || null,               // {daHu, conds, text} 算钱明细
          myHand: mine.hand || null,          // 我胡牌/流局时的手牌
          myMelds: mine.melds || null,        // 我的副露
        });
      }
      send(ws, { t: 'history', list });
      break;
    }
    case 'start': {
      if (!room) return;
      if (room.state !== 'lobby') return;
      if (ref.seat !== room.hostSeat) return send(ws, { t: 'error', msg: '只有房主能开始' });
      if (room.players.length < 2) return send(ws, { t: 'error', msg: '至少 2 人才能开始' });
      room.state = 'playing';
      room.scores = new Array(room.players.length).fill(0);
      startGame(room);
      break;
    }
    case 'next_round': {
      if (!room || room.state !== 'over') return;
      nextRound(room);
      break;
    }
    case 'discard': {
      if (!room || !room.game) return;
      const g = room.game;
      if (g.phase !== 'discard' || g.turn !== ref.seat) return;
      doDiscard(room, ref.seat, Number(msg.idx));
      break;
    }
    case 'action': {
      if (!room || !room.game) return;
      const g0 = room.game;
      // 自摸胡: 出牌阶段轮到自己
      if (g0.phase === 'discard' && g0.turn === ref.seat && msg.act === 'hu') {
        if (!checkSelfHu(g0, ref.seat)) return send(ws, { t: 'error', msg: '还不能胡' });
        const hand = g0.hands[ref.seat];
        const huTile = g0.lastDraw || hand[hand.length - 1];
        doHu(room, ref.seat, huTile.id, true, -1);
        return;
      }
      if (g0.phase !== 'claim') return;
      const g = room.game;
      const claims = g.claims;
      if (!claims.need.has(ref.seat) || claims.got.has(ref.seat)) return;
      const act = msg.act;
      const opts = claims.optionsBySeat[ref.seat];
      if (act === 'hu' && opts.hu) claims.got.set(ref.seat, 'hu');
      else if (act === 'peng' && opts.peng) claims.got.set(ref.seat, 'peng');
      else if (act === 'chi' && opts.chi.length) {
        const tiles = Array.isArray(msg.tiles) ? msg.tiles.map(Number) : opts.chi[0];
        const valid = opts.chi.some(o => o[0] === tiles[0] && o[1] === tiles[1]);
        if (!valid) return send(ws, { t: 'error', msg: '无效吃牌组合' });
        claims.got.set(ref.seat, 'chi');
        claims.got.set('_chiTiles_' + ref.seat, tiles);
      } else if (act === 'pass') claims.got.set(ref.seat, 'pass');
      else return send(ws, { t: 'error', msg: '无效操作' });
      // 所有在线且需要的人都表态了 → 结算 (不设超时, 永远等人)
      syncGame(room);
      settleIfAllResponded(room);
      break;
    }
    default: break;
  }
}

server.listen(PORT, "127.0.0.1", () => console.log(`麻将服务器已启动: http://127.0.0.1:${PORT} (经 nginx 对外提供 HTTPS)`));
