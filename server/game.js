'use strict';
/**
 * 家规麻将引擎
 * 牌: 万/饼/条 1-9 各4张 + 东南西北中发白 各4张 (136张)
 * 规则要点:
 *  - 儿牌: 开局翻开一张牌(移出牌墙), 剩余的同 id 牌都是万能牌
 *  - 第四张变儿: 当某张牌的 4 张全归一名玩家(手牌+亮牌)时, 第 4 张变万能牌
 *  - 胡牌必须: 4组(顺/刻)+1对; 有真幺九; 已开门(有吃/碰);
 *    至少一个刻子(除非将对子是中发白)
 *  - 万能牌可当任何牌, 但不能充当幺九
 *  - 大胡: 全刻子+一对, 无顺子
 *  - 只有吃(限上家)和碰, 没有杠
 */

// ===== 牌定义 =====
// id 0-8:一万..九万  9-17:一饼..九饼  18-26:一条..九条  27-33:东南西北中发白
const SUIT_NAMES = ['万', '饼', '条'];
const HONOR_NAMES = ['东', '南', '西', '北', '中', '发', '白'];
const NUM_CHARS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const TILE_TYPES = 34;
const WALL_COUNT = 136;

function tileName(id) {
  if (id < 27) return NUM_CHARS[id % 9] + SUIT_NAMES[(id / 9) | 0];
  return HONOR_NAMES[id - 27];
}
/** 混儿 = 翻开牌的下一张: 数牌同花色循环(九万→一万), 风牌东南西北循环, 中发白循环 */
function nextOf(id) {
  if (id < 27) return (id % 9 === 8) ? id - 8 : id + 1;
  if (id < 31) return 27 + (id - 27 + 1) % 4;
  return 31 + (id - 31 + 1) % 3;
}
function tileSuit(id) { return id < 27 ? (id / 9) | 0 : 3; }
function isYaojiu(id) { return id >= 27 || id % 9 === 0 || id % 9 === 8; }

function fullDeck() {
  const d = [];
  for (let id = 0; id < TILE_TYPES; id++) for (let c = 0; c < 4; c++) d.push(id);
  return d;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 手牌元素: {id:number, wild:boolean}
// 亮牌: {type:'peng'|'chi', tiles:[id,id,id]}
function countRealYao(hand, melds) {
  let ok = false;
  for (const t of hand) if (!t.wild && isYaojiu(t.id)) { ok = true; break; }
  if (!ok) for (const m of melds) {
    for (const id of m.tiles) if (isYaojiu(id)) { ok = true; break; }
    if (ok) break;
  }
  return ok;
}

/**
 * 判定能否胡牌
 * @param hand  手牌数组 (含刚摸/刚要的那张), 元素 {id, wild}
 * @param melds 已亮出的吃碰
 * @param daHu  true=按大胡判定(全刻子无顺子)
 * @returns {hu:boolean, why:string}
 */
function canHu(hand, melds, daHu = false) {
  const counts = new Array(TILE_TYPES).fill(0);
  let wilds = 0;
  for (const t of hand) {
    if (t.wild) { wilds++; continue; }
    counts[t.id]++;
  }
  // 大胡不能有吃的亮牌
  if (daHu) for (const m of melds) if (m.type === 'chi') return { hu: false, why: '大胡不能有顺子(吃)' };
  // 必须有真幺九
  if (!countRealYao(hand, melds)) return { hu: false, why: '缺少幺九' };
  // 必须开门
  if (melds.length === 0) return { hu: false, why: '没有开门(缺吃碰)' };
  const needSets = 4 - melds.length;
  if (needSets < 0) return { hu: false, why: '亮牌过多' };
  const meldPengs = melds.filter(m => m.type === 'peng').length;

  // suit bits: 1=万 2=饼 4=条, 只统计真实牌(手牌非混 + 吃碰亮牌), 混儿不能顶替缺门
  let baseSuits = 0;
  for (const t of hand) if (!t.wild) baseSuits |= (1 << tileSuit(t.id));
  for (const m of melds) for (const id of m.tiles) baseSuits |= (1 << tileSuit(id));

  // 三门齐: 万/饼/条必须三门都有真实牌 (v6.6.13 修复: 之前只算不查, 缺门也能胡)
  const SUIT_OK = 0b111; // 万饼条齐
  if ((baseSuits & SUIT_OK) !== SUIT_OK) return { hu: false, why: '缺门(三门不齐)' };

  // 试图在 id=i 处组成一个块; real: 用真实牌数; 返回 true 表示递归成功
  function dfs(i, setsLeft, pairLeft, w, suits, ke, shun, pairZFB) {
    if (i > 33) {
      return setsLeft === 0 && pairLeft === 0 && w === 0
        && (ke + meldPengs >= 1 || pairZFB)
        && (!daHu || !shun);
    }
    const suit3 = i < 27 ? (i / 9) | 0 : 3;
    const c = counts[i];

    if (c === 0) {
      // 跳过该 id
      if (dfs(i + 1, setsLeft, pairLeft, w, suits, ke, shun, pairZFB)) return true;
      // 纯万能牌块
      if (pairLeft && w >= 2) {
        if (dfs2(i, setsLeft, 0, w - 2, suits, ke, shun, pairZFB || i >= 31)) return true;
      }
      if (setsLeft && w >= 3) {
        if (dfs2(i, setsLeft - 1, pairLeft, w - 3, suits, ke + 1, shun, pairZFB)) return true;
        if (suit3 < 3 && i % 9 <= 6) {
          if (dfs2(i, setsLeft - 1, pairLeft, w - 3, suits, ke, true, pairZFB)) return true;
        }
      }
      return false;
    }

    // 该 id 有真实牌: 枚举包含它的块
    // 对子
    if (pairLeft) {
      if (c >= 2) { // 2真
        counts[i] -= 2;
        if (dfs(i, setsLeft, 0, w, suits | (1 << suit3), ke, shun, pairZFB || i >= 31)) { counts[i] += 2; return true; }
        counts[i] += 2;
      }
      if (c >= 1 && w >= 1) { // 1真1万
        counts[i] -= 1; w -= 1;
        if (dfs(i, setsLeft, 0, w, suits | (1 << suit3), ke, shun, pairZFB || i >= 31)) { counts[i] += 1; w += 1; return true; }
        counts[i] += 1; w += 1;
      }
    }
    // 刻子
    if (setsLeft) {
      if (c >= 3) {
        counts[i] -= 3;
        if (dfs(i, setsLeft - 1, pairLeft, w, suits | (1 << suit3), ke + 1, shun, pairZFB)) { counts[i] += 3; return true; }
        counts[i] += 3;
      }
      if (c === 2 && w >= 1) {
        counts[i] -= 2; w -= 1;
        if (dfs(i, setsLeft - 1, pairLeft, w, suits | (1 << suit3), ke + 1, shun, pairZFB)) { counts[i] += 2; w += 1; return true; }
        counts[i] += 2; w += 1;
      }
      if (c === 1 && w >= 2) {
        counts[i] -= 1; w -= 2;
        if (dfs(i, setsLeft - 1, pairLeft, w, suits | (1 << suit3), ke + 1, shun, pairZFB)) { counts[i] += 1; w += 2; return true; }
        counts[i] += 1; w += 2;
      }
      // 顺子 (仅数牌)
      if (suit3 < 3 && i % 9 <= 6) {
        const s = (1 << suit3) | (1 << ((i + 1) / 9 | 0)) | (1 << ((i + 2) / 9 | 0));
        for (let take = 1; take <= Math.min(c, 3); take++) {
          const needMid = take, needEnd = take; // take 张 i, take 张 i+1, take 张 i+2
          if (take > c) break;
          const r1 = take;
          const r2 = Math.min(counts[i + 1], needMid);
          const r3 = Math.min(counts[i + 2], needEnd);
          const wNeed = (needMid - r2) + (needEnd - r3);
          if (r1 > c || w < wNeed) continue;
          counts[i] -= r1; counts[i + 1] -= r2; counts[i + 2] -= r3; w -= wNeed;
          if (dfs(i, setsLeft - 1, pairLeft, w, suits | s, ke, true, pairZFB)) {
            counts[i] += r1; counts[i + 1] += r2; counts[i + 2] += r3; w += wNeed;
            return true;
          }
          counts[i] += r1; counts[i + 1] += r2; counts[i + 2] += r3; w += wNeed;
        }
      }
    }
    return false;
  }

  // dfs 的包装: 处理 w<0 非法时的恢复
  function dfs2(i, setsLeft, pairLeft, w, suits, ke, shun, pairZFB) {
    if (w < 0) return false;
    return dfs(i, setsLeft, pairLeft, w, suits, ke, shun, pairZFB);
  }

  const ok = dfs(0, needSets, 1, wilds, baseSuits, 0, false, false);
  return ok ? { hu: true, why: daHu ? '大胡' : '平胡' } : { hu: false, why: '牌型不满足' };
}

/** 自动判定胡牌类型: 先看大胡, 再看平胡 */
function checkWin(hand, melds) {
  const da = canHu(hand, melds, true);
  if (da.hu) return { hu: true, daHu: true, why: '大胡' };
  const norm = canHu(hand, melds, false);
  if (norm.hu) return { hu: true, daHu: false, why: '平胡' };
  return { hu: false, daHu: false, why: norm.why };
}

/** 穷胡: 手牌+亮牌中没有任何万能牌 */
function isQiong(hand, melds) {
  for (const t of hand) if (t.wild) return false;
  return true;
}

/**
 * 算钱 (单位: 块) —— 家规(v6.6.58): 平胡全是乘2, 大胡全是加5, 任何因素(穷/自摸/点炮/庄)都服从:
 *   平胡: 基础 1 元, 穷胡×2, 自摸×2, 点炮者×2, 庄家因素×2
 *   大胡: 基础 15 元, 穷胡+5, 自摸+5, 点炮者+5, 庄家因素+5
 *   庄家因素作用于每一笔支付 (胡牌者是庄→所有人对该因素生效; 付钱者是庄→该笔生效)
 * @param opts {daHu, qiong, zhuang(胡牌者是庄), selfDraw, dianpaoIdx, dealerIdx}
 * @returns {deltas:number[], desc}
 */
function settle(winnerIdx, seatCount, { daHu, qiong, zhuang, selfDraw, dianpaoIdx, dealerIdx }) {
  const deltas = new Array(seatCount).fill(0);
  let total = 0;
  for (let i = 0; i < seatCount; i++) {
    if (i === winnerIdx) continue;
    let amt;
    if (!daHu) {
      amt = 1;
      if (qiong) amt *= 2;
      if (selfDraw) amt *= 2;
      else if (i === dianpaoIdx) amt *= 2;
    } else {
      amt = 15;
      if (qiong) amt += 5;
      if (selfDraw) amt += 5;
      else if (i === dianpaoIdx) amt += 5;
    }
    if (zhuang) amt = daHu ? amt + 5 : amt * 2;                               // 家规(v6.6.58): 平胡庄×2, 大胡庄+5
    if (dealerIdx != null && i === dealerIdx) amt = daHu ? amt + 5 : amt * 2; // 付钱的是庄家同理
    deltas[i] = -amt;
    total += amt;
  }
  deltas[winnerIdx] = total;
  return { deltas, base: null, desc: buildDesc({ daHu, qiong, zhuang, selfDraw }) };
}

function buildDesc(f) {
  const conds = [];
  if (f.zhuang) conds.push('庄家');
  if (f.qiong) conds.push('穷胡');
  if (f.selfDraw) conds.push('自摸');
  const parts = [f.daHu ? '大胡 15元' : '平胡 1元'];
  if (f.qiong) parts.push(f.daHu ? '穷+5' : '穷×2');
  if (f.selfDraw) parts.push(f.daHu ? '自摸+5' : '自摸×2');
  else parts.push(f.daHu ? '点炮+5' : '点炮者×2');
  if (f.zhuang) parts.push(f.daHu ? '庄+5' : '庄×2');
  return { daHu: f.daHu, conds, text: parts.join(' ') };
}

module.exports = {
  TILE_TYPES, WALL_COUNT,
  tileName, tileSuit, isYaojiu, nextOf, fullDeck, shuffle,
  canHu, checkWin, isQiong, settle,
};
