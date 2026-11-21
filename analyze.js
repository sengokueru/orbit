'use strict';

// Private helpers stay inside the closure; only the three public functions are global.
var parseLineTalk, analyzeLineTalk, organizeMemo;
(function () {
  const DAY = 86400000, GAP = 6 * 3600000;
  const str = v => typeof v === 'string' ? v : '';
  const round = v => Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  const pad = n => String(n).padStart(2, '0');
  const ymd = at => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const norm = s => str(s).normalize('NFKC');
  const unique = a => Array.from(new Set(a));
  const median = a => {
    if (!a.length) return null;
    const b = a.slice().sort((x, y) => x - y), i = b.length >> 1;
    return round(b.length % 2 ? b[i] : (b[i - 1] + b[i]) / 2);
  };
  function kind(text) {
    const s = text.trim();
    if (/^(?:.*が)?(?:メッセージの)?送信を取り消しました[。.]?$/.test(s)) return 'unsend';
    if (/^(?:☎|通話時間|不在着信|キャンセルした通話|通話に応答がありません|通話をキャンセル|\[通話\])/.test(s)) return 'call';
    const media = { 'スタンプ': 'sticker', '写真': 'photo', '画像': 'photo', '動画': 'video', 'ビデオ': 'video', 'ボイスメッセージ': 'voice', '音声メッセージ': 'voice', 'ファイル': 'file' };
    const m = s.match(/^\[([^\]]{1,20})\]$/);
    if (m && media[m[1]]) return media[m[1]];
    // 端末によっては [ ] なしで「スタンプ」「写真」とだけ書かれる（2026-11-21 本物の履歴で確認）
    if (media[s]) return media[s];
    if (/^\[(?:アルバム|ノート)\]|^.{0,100}が(?:参加|退会|退出)しました[。.]?$|^.{0,100}(?:アルバム|ノート)を(?:作成|共有|更新|削除)しました[。.]?$/.test(s)) return 'system';
    return 'text';
  }
  // 空白区切りの形では「Mika 美香」のような空白入りの表示名が「Mika」と本文「美香 …」に割れる
  // （2026-11-21 本物の履歴で確認）。題名の名前と一致するもの、または同じ最初の語のあとに
  // ほぼ毎回（9割以上・3件以上）同じ語が続くものは、名前の続きとみなして本文から外す。
  function fixSpacedNames(list, partner) {
    const groups = new Map();
    for (const m of list) { if (!groups.has(m.from)) groups.set(m.from, []); groups.get(m.from).push(m); }
    for (const [first, ms] of groups) {
      let name = first;
      const known = partner && partner.startsWith(first + ' ') && ms.every(m => (first + ' ' + m.text).startsWith(partner + ' ') || first + ' ' + m.text === partner) ? partner : '';
      if (known) name = known;
      else if (ms.length >= 3) {
        for (let k = 0; k < 3; k++) {
          const next = ms.map(m => (m.text.slice(name.length - first.length).replace(/^ +/, '').match(/^(\S+) +\S/) || [])[1] || '');
          const top = next.filter(Boolean).sort().reduce((a, w, i, arr) => { const n = arr.filter(x => x === w).length; return n > a.n ? { w, n } : a; }, { w: '', n: 0 });
          if (!top.w || top.n < ms.length * 0.9) break;
          name += ' ' + top.w;
        }
      }
      if (name === first) continue;
      const more = name.slice(first.length + 1); // 名前の続き（例「美香」）
      for (const m of ms) {
        const rest = m.text.slice(more.length);
        if (m.text.startsWith(more) && /^ +/.test(rest)) { m.from = name; m.text = rest.replace(/^ +/, ''); m.kind = kind(m.text); }
      }
    }
  }
  const WD_EN = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\.?';
  const DATE_YMD = new RegExp('^(\\d{4})[/.\\-](\\d{1,2})[/.\\-](\\d{1,2})(?:\\s*(?:[（(][^)）]*[)）]|[日月火水木金土]曜日?|,?\\s*' + WD_EN + '))?$', 'i');
  const DATE_JA = /^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(?:[（(][^)）]*[)）]|[日月火水木金土]曜日?)?$/;
  const DATE_US = new RegExp('^' + WD_EN + ',?\\s+(\\d{1,2})/(\\d{1,2})/(\\d{4})$', 'i');
  function dateLine(line) {
    let m = line.match(DATE_YMD) || line.match(DATE_JA);
    if (m) return [+m[1], +m[2], +m[3]];
    m = line.match(DATE_US);
    return m ? [+m[3], +m[1], +m[2]] : null;
  }
  parseLineTalk = function (text) {
    const result = { partner: '', messages: [], senders: [], error: '' };
    let date = null, current = null, body = [], quoted = false;
    const spaced = []; // 空白区切りの形で読んだ発言（名前の途中の空白を後で直す）
    let firstLine = true;
    const finish = () => {
      if (!current) return;
      let s = body.join('\n');
      if (quoted && s.endsWith('"')) s = s.slice(1, -1).replace(/""/g, '"');
      current.text = s;
      current.kind = kind(s);
      result.messages.push(current);
      current = null; body = []; quoted = false;
    };
    for (const raw of str(text).replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)) {
      const line = raw.trim();
      // 1行目の題名。「[LINE] 」が付かない版もある
      const title = line.match(/^\[LINE\]\s*(.*?)とのトーク(?:履歴)?$/) || line.match(/^\[LINE\]\s*Chat history with\s+(.+)$/i) || (firstLine && line.match(/^(.+?)とのトーク(?:履歴)?$/));
      if (line) firstLine = false;
      if (title) { result.partner = title[1].trim(); continue; }
      if (/^(?:保存日時|Saved on)\s*[:：]/i.test(line)) continue;
      const dm = dateLine(line);
      if (dm) {
        finish();
        const [y, m, d] = dm, dt = new Date(y, m - 1, d);
        date = dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? [y, m - 1, d] : null;
        continue;
      }
      const tm = raw.match(/^\s*(午前|午後|AM|PM)?\s*(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*(AM|PM))?(\t| +)(.*)$/i);
      if (tm) {
        finish();
        let h = +tm[2]; const mi = +tm[3], ap = (tm[1] || tm[4] || '').toUpperCase();
        if (!date || mi > 59 || (ap ? h < 1 || h > 12 : h > 23)) continue;
        if (ap) h = h % 12 + (ap === '午後' || ap === 'PM' ? 12 : 0);
        const tail = tm[6], tab = tail.indexOf('\t');
        let from = '', s = tail;
        if (tab >= 0) { from = tail.slice(0, tab).trim(); s = tail.slice(tab + 1); }
        else if (tm[5] !== '\t') {
          const old = tail.match(/^(\S+) +(.*)$/);
          if (old && kind(tail) === 'text') { from = old[1]; s = old[2]; }
        }
        // A timestamp without a sender is only valid for a recognizable notification.
        if (!from && kind(s) === 'text') continue;
        current = { at: new Date(...date, h, mi).getTime(), from, text: '', kind: '' };
        if (from && tab < 0) spaced.push(current);
        body = [s]; quoted = s.startsWith('"');
      } else if (current && line) body.push(raw);
    }
    finish();
    fixSpacedNames(spaced, result.partner);
    const counts = new Map();
    for (const m of result.messages) if (m.from && m.kind !== 'system' && m.kind !== 'unsend') counts.set(m.from, (counts.get(m.from) || 0) + 1);
    result.senders = Array.from(counts, ([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
    if (!result.messages.length) result.error = 'LINEのトーク履歴ではありません（日時と発言を確認してください）';
    return result;
  };

  const drinks = ['シャンパン', 'テキーラ', '焼酎', '日本酒', 'ワイン', 'ビール', 'ハイボール', 'カクテル', 'ウイスキー', 'ウィスキー', '梅酒', 'レモンサワー', 'サワー', 'ジン', 'ウォッカ', 'ブランデー'];
  const stop = new Set(['今日', '明日', '昨日', '今度', '今週', '来週', '今月', '来月', '自分', '本当', '大丈夫', '了解', '返信', '連絡', '時間', '予定', '誕生日', '仕事', '好き', '苦手', '嫌い', 'スタンプ', '写真', '動画', 'ボイスメッセージ']);
  function birthday(s) {
    // Date must be in the same clause, within 20 characters of 誕生日.
    const near = s.match(/誕生日[^、。\n!?]{0,20}/g) || [];
    const before = s.match(/\d{1,2}(?:月|[/.-])\d{1,2}日?[^、。\n!?]{0,10}誕生日/g) || [];
    for (const part of near.concat(before)) {
      const m = part.match(/(?:^|\D)(\d{1,2})(?:月|[/.-])(\d{1,2})(?:日|\b)/);
      if (!m) continue;
      const mo = +m[1], d = +m[2], dt = new Date(2000, mo - 1, d);
      if (dt.getMonth() === mo - 1 && dt.getDate() === d) return `${pad(mo)}-${pad(d)}`;
    }
    return '';
  }
  function preferences(s) {
    const likes = [], ng = [];
    // Bounded noun candidates keep regex work linear even on a long unbroken line.
    const re = /([一-龯々ァ-ヶーA-Za-z0-9ぁ-ん]{1,32}?)(?:が|は|に)?(好き|大好き|ハマってる|ハマっている|嫌い|苦手)(じゃない|ではない|ではなく|じゃなく|ではありません|じゃありません|ではなかった|じゃなかった)?/g;
    for (const m of s.matchAll(re)) {
      if (m[3]) continue;
      let w = m[1].replace(/^(?:私は|わたしは|僕は|俺は|趣味は|好物は)/, '').replace(/(?:が|は|に|大)$/, '');
      if (w && !stop.has(w)) (m[2] === '嫌い' || m[2] === '苦手' ? ng : likes).push(w);
    }
    return { likes: unique(likes), ng: unique(ng) };
  }
  function extract(text) {
    const s = norm(text), p = preferences(s);
    return { bday: birthday(s), likes: p.likes, ng: p.ng,
      drinks: drinks.filter(w => s.includes(w) && !p.ng.some(n => n.includes(w)) && !(w === 'サワー' && s.includes('レモンサワー'))) };
  }
  function plan(s, includeDateOnly = false) {
    // Talk replies may omit the action (「来週の土曜！」). Memo extraction stays stricter.
    const dateOnly = includeDateOnly && /(?:来週|今週|明日|明後日|[月火水木金土日]曜|\d{1,2}日|\d{1,2}[/.\-]\d{1,2})/.test(s);
    const action = /(?:来週|今週|明日|明後日|今度|次|\d{1,2}日|[月火水木金土日]曜)/.test(s) && /(?:行く|いく|来る|くる|会[うおえ]|会い|同伴|来店|寄る)/.test(s);
    return (dateOnly || action) && !/誕生日/.test(s) && !/(?:行かない|いかない|来ない|こない|会わない|行けない|来れない|無理|キャンセル)/.test(s);
  }
  organizeMemo = function (text) {
    const out = { bday: '', drinks: [], likes: [], job: '', ng: [], next: '', call: '', area: '', rest: '' }, rest = [];
    for (const raw of str(text).split(/[、,。\n;；]+/)) {
      const s = norm(raw).trim(); if (!s) continue;
      const e = extract(s); let used = !!(e.bday || e.drinks.length || e.likes.length || e.ng.length);
      if (e.bday) out.bday = e.bday;
      for (const k of ['drinks', 'likes', 'ng']) for (const value of e[k]) out[k].push(value);
      const job = s.match(/^(?:仕事|職業|お仕事)(?:は|[:：])\s*(.+)$/);
      const area = s.match(/^(?:住まい|住所|地元|最寄り|エリア|住んでる場所)(?:は|[:：])\s*(.+)$/) || s.match(/^(.{1,60}?)に住んで(?:いる|る)$/);
      const call = s.match(/^(.{1,30}?(?:ちゃん|くん|君|さん))(?:って|と)呼ぶ$/) || s.match(/^(?:呼び方|あだ名)(?:は|[:：])\s*(.{1,30})$/);
      if (job) { out.job = job[1]; used = true; }
      if (area) { out.area = area[1]; used = true; }
      if (call) { out.call = call[1]; used = true; }
      if (plan(s)) { out.next = s.replace(/^次(?:は|回は)/, ''); used = true; }
      if (!used) rest.push(raw.trim());
    }
    for (const k of ['drinks', 'likes', 'ng']) out[k] = unique(out[k]);
    out.rest = rest.join('、');
    return out;
  };

  function turnsOf(messages) {
    const turns = [];
    for (const m of messages) {
      let t = turns[turns.length - 1];
      // Six-hour silence starts a new conversation, including unanswered follow-ups.
      if (!t || t.from !== m.from || m.at - t.end >= GAP) {
        t = { from: m.from, start: m.at, end: m.at, len: 0, q: false }; turns.push(t);
      }
      t.end = m.at;
      if (m.kind === 'text') { t.len += Array.from(m.text).length; t.q = t.q || /[?？]|(?:どう|いつ|どこ|何時|何日|なに|何を|誰|どれ|どっち)|(?:かな|ですか|ますか)[。！!\s]*$/.test(m.text); }
    }
    return turns;
  }
  function metrics(messages, me, now) {
    const turns = turnsOf(messages), mine = turns.filter(t => t.from === me), theirs = turns.filter(t => t.from !== me);
    const replies = [], myReplies = [], hours = new Map();
    let eligible = 0, answered = 0, starts = 0, theirStarts = 0;
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i], prev = turns[i - 1], next = turns[i + 1];
      if (!prev || t.start - prev.end >= GAP) { starts++; if (t.from !== me) theirStarts++; }
      if (t.from === me) {
        // Do not penalize a still-open 24h reply window. An observed reply is eligible immediately.
        const reply = next && next.from !== me && next.start - t.end <= DAY;
        if (reply || now - t.end >= DAY) { eligible++; if (reply) answered++; }
      }
      if (prev && prev.from !== t.from) {
        const min = (t.start - prev.end) / 60000;
        (t.from === me ? myReplies : replies).push(min);
        if (t.from !== me) {
          const h = new Date(t.start).getHours(); if (!hours.has(h)) hours.set(h, []); hours.get(h).push(min);
        }
      }
    }
    const ratio = (a, b) => b ? round(a / b) : null;
    const mean = a => a.length ? a.reduce((n, t) => n + t.len, 0) / a.length : 0;
    const replyRate = ratio(answered, eligible), replyMin = median(replies), myReplyMin = median(myReplies);
    const initRate = ratio(theirStarts, starts), lenRatio = mine.length && theirs.length ? ratio(mean(theirs), mean(mine)) : null;
    const qRate = ratio(theirs.filter(t => t.q).length, theirs.length);
    const lastPartner = messages.filter(m => m.from !== me).pop();
    const age = lastPartner ? Math.max(0, (now - lastPartner.at) / DAY) : null;
    // Heuristic, not an inferred feeling: specified 30/20/20/10/10/10 weights.
    // Missing components contribute zero, without redistributing their weight.
    const clamp = v => v === null ? null : Math.max(0, Math.min(1, v));
    const parts = [
      { k: '返信率', p: replyRate, v: replyRate === null ? '—' : `${Math.round(replyRate * 100)}%` },
      { k: '返信の速さ', p: replyMin === null ? null : clamp(1 - Math.log(Math.max(10, replyMin) / 10) / Math.log(144)), v: replyMin === null ? '—' : `${replyMin}分` },
      { k: '相手から開始', p: initRate === null ? null : clamp(initRate * 2), v: initRate === null ? '—' : `${Math.round(initRate * 100)}%` },
      { k: '文字数の比', p: clamp(lenRatio), v: lenRatio === null ? '—' : `${lenRatio}倍` },
      { k: '質問', p: qRate, v: qRate === null ? '—' : `${Math.round(qRate * 100)}%` },
      { k: '最近の発言', p: age === null ? null : clamp((30 - age) / 27), v: age === null ? '—' : `${Math.floor(age)}日前` }
    ];
    const score = messages.length ? Math.round(parts.reduce((s, p, i) => s + (p.p || 0) * [30, 20, 20, 10, 10, 10][i], 0)) : null;
    parts.forEach(p => { p.p = round(p.p); });
    const bestHours = Array.from(hours, ([h, a]) => ({ h, n: a.length, median: median(a) }))
      .sort((a, b) => (b.n / (1 + b.median / 60)) - (a.n / (1 + a.median / 60)) || a.h - b.h).slice(0, 2).map(x => x.h);
    return { turns, replyRate, replyMin, myReplyMin, initRate, lenRatio, qRate, score, parts, bestHours };
  }
  analyzeLineTalk = function (parsed, me, now) {
    me = str(me);
    const valid = Array.isArray(parsed && parsed.messages) ? parsed.messages.filter(m => m && Number.isFinite(m.at) && Number.isFinite(new Date(m.at).getTime()) && typeof m.from === 'string' && m.from && typeof m.text === 'string' && !['system', 'unsend'].includes(m.kind)) : [];
    const counts = new Map();
    for (const m of valid) if (m.from !== me) counts.set(m.from, (counts.get(m.from) || 0) + 1);
    const partner = Array.from(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const messages = valid.filter(m => m.from === me || m.from === partner).map(m => ({ ...m, kind: m.kind || 'text' })).sort((a, b) => a.at - b.at);
    // Invalid/missing now falls back to the export's last timestamp: deterministic and pure.
    now = Number.isFinite(now) && Number.isFinite(new Date(now).getTime()) ? now : (messages[messages.length - 1]?.at || 0);
    const stats = metrics(messages, me, now), last = messages[messages.length - 1];
    const theirText = messages.filter(m => m.from === partner && m.kind === 'text');
    const e = extract(theirText.map(m => m.text).join('\n'));
    const topics = new Map(), calls = new Map();
    for (const m of theirText) {
      const text = norm(m.text);
      // Consume each full run before filtering, so a rejected word cannot backtrack
      // into a shorter fragment (e.g. 話楽しい → 話楽 / 話).
      for (const hit of text.matchAll(/[ァ-ヶー]+|[一-龯々]+/g)) {
        const w = hit[0], kanji = /^[一-龯々]/.test(w), next = text[hit.index + w.length] || '';
        if (w.length < 2 || w.length > (kanji ? 16 : 32) || stop.has(w)) continue;
        if (kanji && /[ぁ-ん]/.test(next) && !/[のがはをにでともへや]/.test(next)) continue;
        topics.set(w, (topics.get(w) || 0) + 1);
      }
    }
    for (const m of messages) if (m.from === me && m.kind === 'text') for (const hit of m.text.matchAll(/([ぁ-んァ-ヶ一-龯々A-Za-z]{1,12}?(?:ちゃん|くん|さん))/g)) calls.set(hit[1], (calls.get(hit[1]) || 0) + 1);
    const rankedTopics = Array.from(topics, ([w, n]) => ({ w, n })).sort((a, b) => b.n - a.n).slice(0, 8);
    const cutoff = now - 30 * DAY, old = messages.filter(m => m.at < cutoff), recentPeriod = messages.filter(m => m.at >= cutoff);
    // Compare each period at its own end so the old period is not penalized merely for age.
    const a = metrics(old, me, cutoff), b = old.length ? metrics(recentPeriod, me, now) : stats;
    const trend = a.turns.length < 10 || b.turns.length < 10 ? null : b.score - a.score >= 8 ? 'up' : b.score - a.score <= -8 ? 'down' : 'flat';
    let myStreak = 0;
    for (let i = stats.turns.length - 1; i >= 0 && stats.turns[i].from === me; i--) myStreak++;
    const unanswered = !!last && last.from === partner;
    const tips = [];
    if (unanswered) { const lt = theirText[theirText.length - 1]; tips.push(lt && lt.at >= last.at - 6 * 3600000 ? `相手の『${lt.text.slice(0, 40)}』にまだ返していない` : `相手の最後の${last.text.slice(0, 20)}にまだ返していない`); }
    if (myStreak >= 3) tips.push('続けて送らない。相手の返事を待つ');
    if (stats.initRate !== null && stats.initRate < 0.2) tips.push('相手が答えやすい質問で終える');
    if (stats.bestHours.length) tips.push(`返事が早いのは${stats.bestHours[0]}時台。その時間に送る`);
    if (rankedTopics.length) tips.push(`よく出る話題：${rankedTopics[0].w}`);
    const { turns, ...publicStats } = stats;
    const firstDay = messages.length ? new Date(messages[0].at) : null, lastDay = last ? new Date(last.at) : null;
    return { me, partner, from: firstDay ? ymd(firstDay.getTime()) : '', to: last ? ymd(last.at) : '',
      days: firstDay ? Math.round((Date.UTC(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate()) - Date.UTC(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate())) / DAY) + 1 : null,
      count: { me: messages.filter(m => m.from === me).length, partner: messages.filter(m => m.from === partner).length },
      ...publicStats, lastFrom: last ? (last.from === me ? 'me' : 'partner') : null, lastAt: last ? last.at : null,
      unanswered, lastPartnerText: theirText[theirText.length - 1]?.text || '', myStreak,
      label: stats.score === null ? '' : stats.score >= 70 ? '脈あり' : stats.score >= 45 ? 'ふつう' : 'うすい', trend,
      topics: rankedTopics, ...e, call: Array.from(calls).sort((a, b) => b[1] - a[1])[0]?.[0] || '',
      plans: theirText.filter(m => plan(norm(m.text), true)).slice(-3).map(m => m.text), tips: tips.slice(0, 3),
      recent: messages.slice(-20).map(m => ({ at: m.at, me: m.from === me, text: Array.from(m.text).slice(0, 200).join('') })) };
  };
}());
