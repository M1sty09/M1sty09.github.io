/* ============================================================
   排球赛程 · 渲染逻辑
   ------------------------------------------------------------
   数据与前端彻底分离，前端不含任何赛事内容：
     data/site.json        站点配置 + 界面文案（公告、页脚、状态词…）
     data/tournament.json  赛事名称 / 副标题
     data/teams.json       队伍（id、名称、颜色）
     data/matches.json     全部比赛（含轮次、对阵、比分）—— 改比分只动这个
     data/bracket.json     淘汰树的轮次定义（名字 + 顺序，不含比赛）
   对阵的三种写法：队伍 id / "$m09"（m09 的胜者）/ "$m13L"（m13 的负者，铜牌赛用）/ null（轮空）
   改数据 = 只改 data/ 下的 JSON，本页面代码不用动。
   ============================================================ */
(function () {
    'use strict';

    /* 站点配置：data/site.json 加载后写入，未加载时沿用这里的兜底值 */
    var SITE = {};

    /* 以下三组是内置兜底，site.json 里存在同名字段时以 JSON 为准 */
    var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    var STATUS_TEXT = {
        upcoming: '未开始',
        finished: '已结束'
    };
    var VIEW_LABELS = { bracket: '淘汰树', list: '分组赛' };
    var VALID_THEMES = ['boom'];
    var ANIMATED_THEMES = ['boom'];

    /* 开场动画关键时间点（与 css/intro.css 保持一致） */
    var INTRO_SETTLE = 1050;   /* 排球落定，界面开始被涟漪推开 */
    var INTRO_FADE = 2150;     /* 涟漪散尽，动画层淡出 */
    var INTRO_END = 2560;      /* 收尾，交还交互态 */

    var el = {
        name: document.getElementById('tournamentName'),
        notice: document.getElementById('noticeBar'),
        noticeText: document.getElementById('noticeText'),
        main: document.getElementById('schedule'),
        footer: document.getElementById('footerNote'),
        intro: document.getElementById('intro'),
        viewSwitch: document.getElementById('viewSwitch'),
        body: document.body
    };

    var state = { data: null, view: 'bracket', roundFilter: 'all' };
    var refreshTimer = null;

    /* ---------------- 工具函数 ---------------- */

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function pad(n) { return n < 10 ? '0' + n : String(n); }

    function indexTeams(teams) {
        var map = {};
        (teams || []).forEach(function (t) { map[t.id] = t; });
        return map;
    }

    /** 由每局小分算出大比分 */
    function calcSets(sets) {
        var home = 0, away = 0;
        (sets || []).forEach(function (s) {
            if (s.home > s.away) home++; else away++;
        });
        return { home: home, away: away };
    }

    /**
     * 只有一侧为空 = 轮空，另一侧不战而胜、直接晋级，不用填比分。
     * 两侧都空或两侧都填了就不算轮空，返回 null。
     */
    function byeSide(m) {
        var h = (m.home == null), a = (m.away == null);
        if (h === a) return null;
        return h ? 'away' : 'home';
    }

    /** 大比分：管理页手填的 m.score 优先，没有再从逐局小比分算（兼容旧数据） */
    function bigScore(m) {
        if (m.score && (m.score.home != null || m.score.away != null)) {
            return { home: +m.score.home || 0, away: +m.score.away || 0 };
        }
        return calcSets(m.sets || []);
    }

    /**
     * 谁晋级：轮空自动；其余以管理页手选的 m.winner 为准；
     * 没手选过（旧数据）才按大比分高低推。
     */
    function winSideOf(m) {
        var bye = byeSide(m);
        if (bye) return bye;
        if (m.winner === 'home' || m.winner === 'away') return m.winner;

        var s = bigScore(m);
        if (statusOf(m) === 'finished' && s.home !== s.away) {
            return s.home > s.away ? 'home' : 'away';
        }
        return null;
    }

    /** 有没有填过比分数据（备注不算）：大比分或任一局有分都算 */
    function hasResult(m) {
        var s = m.score;
        if (s && (+s.home > 0 || +s.away > 0)) return true;
        return (m.sets || []).some(function (x) {
            return +x.home > 0 || +x.away > 0;
        });
    }

    /** 状态：有比分数据 = 已结束，没填 = 未开始（后台不再给状态选项） */
    function statusOf(m) {
        return hasResult(m) ? 'finished' : 'upcoming';
    }

    /* 赛程表要按 id 找比赛，才能把 "$m09" 翻成队名 */
    var MATCH_BY_ID = {};

    /* 每支队伍来自第几号位：把「胜者 · m09」翻译成「3-4位胜者」的关键。
       取值口径 = 该队所在的首轮比赛的 pos（1 号位 / 2 号位 …）。
       号位表在每次渲染前重算，跟着 data/matches.json 走。 */
    var SEED_OF_TEAM = {};

    function buildSeedMap(matches) {
        SEED_OF_TEAM = {};

        var first = null;
        (matches || []).forEach(function (m) {
            if (m.round == null) return;
            if (first == null || m.round < first) first = m.round;
        });

        (matches || []).forEach(function (m) {
            if (m.round !== first || m.pos == null) return;
            ['home', 'away'].forEach(function (k) {
                var v = m[k];
                if (v != null && String(v).charAt(0) !== '$') SEED_OF_TEAM[String(v)] = m.pos;
            });
        });
    }

    /** 递归取一个席位背后所有叶子队所在的号位 */
    function seatsOf(raw, depth) {
        if (raw == null) return [];
        raw = String(raw);

        if (raw.charAt(0) !== '$') {
            var s = SEED_OF_TEAM[raw];
            return s ? [s] : [];
        }
        if ((depth || 0) > 4) return [];

        var id = raw.slice(1).replace(/L$/, '');
        var src = MATCH_BY_ID[id];
        if (!src) return [];

        return seatsOf(src.home, (depth || 0) + 1).concat(seatsOf(src.away, (depth || 0) + 1));
    }

    /**
     * 还没打出来的席位怎么写人才看得懂：
     *   "$m10"（3、4 号位之间的胜者） → 「3-4位胜者」
     *   "$m13L"（1–4 号位之间的负者） → 「1-4位负者」
     * 号位算不出来时才退回「待定」。
     */
    function seatLabel(raw, wantLoser) {
        var seeds = seatsOf(raw, 0);
        if (!seeds.length) return txt('tbd', '待定');

        var lo = Math.min.apply(null, seeds);
        var hi = Math.max.apply(null, seeds);
        var pos = (lo === hi) ? (lo + txt('seatUnit', '位')) : (lo + '-' + hi + txt('seatUnit', '位'));

        return pos + (wantLoser ? txt('loserOf', '负者') : txt('winnerOf', '胜者'));
    }

    /**
     * 一个席位可能直接写队伍 id，也可能写
     *   "$m09"  → m09 的胜者        "$m13L" → m13 的负者（铜牌赛）
     * 已经决出就显示队名，没决出就写来源号位（「3-4位胜者」）。
     */
    function seatName(raw, teams, depth) {
        if (raw == null) return txt('bye', '轮空');
        raw = String(raw);

        if (raw.charAt(0) !== '$') {
            var t = teams[raw];
            return (t && (t.name || t.short)) || raw;
        }
        if ((depth || 0) > 4) return txt('tbd', '待定');

        var lose = raw.charAt(raw.length - 1) === 'L';
        var id = lose ? raw.slice(1, -1) : raw.slice(1);
        var src = MATCH_BY_ID[id];
        var side = src ? winSideOf(src) : null;

        if (!side) return seatLabel(raw, lose);
        return seatName(src[lose ? (side === 'home' ? 'away' : 'home') : side],
                        teams, (depth || 0) + 1);
    }

    function parseDate(str) {
        var p = String(str).split('-');
        if (p.length !== 3) return { text: str, week: '' };
        var m = +p[1], d = +p[2];
        var dt = new Date(+p[0], m - 1, d);
        return { text: m + '月' + d + '日', week: isNaN(dt) ? '' : WEEKDAYS[dt.getDay()] };
    }

    function byTime(a, b) {
        return String(a.time || '').localeCompare(String(b.time || ''));
    }

    /* ---------------- 数据加载 ---------------- */

    function fetchJSON(url) {
        var sep = url.indexOf('?') === -1 ? '?' : '&';
        return fetch(url + sep + 't=' + Date.now(), { cache: 'no-store' }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        });
    }

    /* 赛程数据的四个文件，改数据只动这些 JSON */
    var DATA_FILES = [
        { key: 'tournament', file: 'tournament.json' },
        { key: 'teams',      file: 'teams.json' },
        { key: 'matches',    file: 'matches.json' },
        { key: 'bracket',    file: 'bracket.json' }
    ];

    /* site.json 的 dataUrl 填了远程根地址（如 COS 目录）时，赛程数据改从远程取 */
    function dataPath(file) {
        var base = SITE.dataUrl ? String(SITE.dataUrl).replace(/\/+$/, '') : 'data';
        return base + '/' + file;
    }

    /* 站点配置先到：页面标题、公告、页脚、状态词、刷新间隔都由它决定 */
    function loadSite() {
        return fetchJSON('data/site.json').catch(function () {
            console.warn('data/site.json 未加载，改用内置默认配置。');
            return {};
        }).then(applySite);
    }

    function applySite(site) {
        SITE = site || {};

        if (SITE.statusText) STATUS_TEXT = SITE.statusText;
        if (SITE.weekdays && SITE.weekdays.length === 7) WEEKDAYS = SITE.weekdays;
        if (SITE.views) VIEW_LABELS = SITE.views;

        document.title = SITE.pageTitle || '排球赛程';
        el.footer.textContent = SITE.footerNote || '';

        applyViewLabels();
        renderNotice();

        if (!state.data) {
            el.main.innerHTML = '<div class="state-hint">' + esc(txt('loading')) + '</div>';
        }
        scheduleAutoRefresh();
    }

    /* 界面文案统一走 site.json 的 text 段，取不到再用内置值 */
    function txt(key, fallback) {
        var t = SITE.text || {};
        return t[key] || fallback || '';
    }

    function applyViewLabels() {
        if (!el.viewSwitch) return;
        Array.prototype.forEach.call(
            el.viewSwitch.querySelectorAll('.view-btn'),
            function (b) {
                var label = VIEW_LABELS[b.getAttribute('data-view')];
                if (label) b.textContent = label;
            }
        );
    }

    function loadData() {
        setLoading(true);

        return Promise.all(DATA_FILES.map(function (f) {
            return fetchJSON(dataPath(f.file));
        })).then(function (parts) {
            var data = {};
            parts.forEach(function (value, i) { data[DATA_FILES[i].key] = value; });
            setLoading(false);
            render(data);
        }).catch(function (err) {
            setLoading(false);
            showError(txt('noData') + '（' + err.message + '）');
        });
    }

    /* ---------------- 渲染 ---------------- */

    function render(data) {
        state.data = data;

        var t = data.tournament || {};
        el.name.textContent = t.name || '排球赛程';

        document.title = (t.name || SITE.pageTitle || '排球赛程') +
                         (t.subtitle ? ' · ' + t.subtitle : '');
        el.footer.textContent = SITE.footerNote || '';

        var teams = indexTeams(data.teams);

        /* 有淘汰树数据时默认展示树；没有则退回日期列表 */
        var hasBracket = !!(data.bracket && (data.bracket.rounds || []).length) &&
                         (data.matches || []).some(function (m) { return m.round != null; });
        if (!hasBracket) state.view = 'list';
        renderViewSwitch(hasBracket);

        if (state.view === 'bracket') {
            renderBracket(data, teams);
        } else {
            BRACKET = null;
            renderTimeline(data.matches || [], teams, data);
        }
    }

    /* 分组赛：不按小组切块，全部比赛只按「日期 + 时间」排成一条时间轴 */
    function renderTimeline(matches, teams, data) {
        MATCH_BY_ID = {};
        matches.forEach(function (m) { MATCH_BY_ID[m.id] = m; });
        buildSeedMap(matches);

        var all = sortByTime(matches);
        var list = (state.roundFilter === 'all')
            ? all
            : all.filter(function (m) { return String(m.round) === String(state.roundFilter); });

        el.main.innerHTML = '';

        el.main.appendChild(buildRoundFilter(data || {}, all));

        if (!list.length) {
            var empty = document.createElement('div');
            empty.className = 'state-hint';
            empty.textContent = txt('empty', '暂无比赛安排。');
            el.main.appendChild(empty);
            return;
        }

        var wrap = document.createElement('div');
        wrap.className = 'timeline';

        list.forEach(function (m, i) {
            wrap.appendChild(buildMatch(m, teams, i));
        });

        el.main.appendChild(wrap);
    }

    /** 赛程表第一行：按轮次筛选（全部 / 16 强 / 八强 / …） */
    function buildRoundFilter(data, matches) {
        var defs = (data.bracket && data.bracket.rounds) || [];

        var nos = [];
        matches.forEach(function (m) {
            if (m.round != null && nos.indexOf(m.round) === -1) nos.push(m.round);
        });
        nos.sort(function (a, b) { return a - b; });

        var opts = [{ v: 'all', t: txt('filterAll', '全部') }];
        nos.forEach(function (n, i) {
            opts.push({ v: String(n), t: (defs[i] && defs[i].name) || ('第 ' + n + ' 轮') });
        });

        var bar = document.createElement('div');
        bar.className = 'round-filter';

        opts.forEach(function (o) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'filter-chip' + (String(state.roundFilter) === o.v ? ' is-active' : '');
            b.textContent = o.t;
            b.addEventListener('click', function () {
                if (state.roundFilter === o.v) return;
                state.roundFilter = o.v;
                if (state.data) render(state.data);
            });
            bar.appendChild(b);
        });

        return bar;
    }

    /* 日期文案：没有日期就退回「待定」 */
    function fmtDay(date) {
        return date ? parseDate(date).text : '待定';
    }

    function sortByTime(matches) {
        return matches.slice().sort(function (a, b) {
            var da = String(a.date || ''), db = String(b.date || '');
            if (da !== db) return da < db ? -1 : 1;
            return byTime(a, b);
        });
    }

    /* ---------------- 视图切换（淘汰树 / 分组赛） ---------------- */

    function renderViewSwitch(show) {
        if (!el.viewSwitch) return;
        el.viewSwitch.hidden = !show;
        var btns = el.viewSwitch.querySelectorAll('.view-btn');
        Array.prototype.forEach.call(btns, function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-view') === state.view);
        });
    }

    function bindViewSwitch() {
        if (!el.viewSwitch) return;
        el.viewSwitch.addEventListener('click', function (e) {
            var btn = e.target && e.target.closest ? e.target.closest('.view-btn') : null;
            if (!btn) return;
            var v = btn.getAttribute('data-view');
            if (!v || v === state.view) return;
            state.view = v;
            if (state.data) render(state.data);
        });
    }

    /* ---------------- 淘汰树：数据解析 ---------------- */

    var BRACKET = null;

    /**
     * 构建树的解析上下文。
     * 比赛全部来自 data.matches（带 round 字段的才进树），
     * data.bracket 只提供轮次的名字与顺序。
     * 一个席位的四种写法：
     *   队伍 id    直接指定
     *   "$m09"     m09 的胜者，未决出则为待定
     *   "$m13L"    m13 的负者（铜牌赛用）
     *   null       轮空，另一侧不战而胜
     */
    function buildBracketCtx(data, teams) {
        var bk = data.bracket || {};
        var list = (data.matches || []).filter(function (m) {
            return m.round != null;
        });
        var roundsDef = bk.rounds || [];

        var byId = {};
        list.forEach(function (m) { byId[m.id] = m; });

        /* 号位表与跨比赛查镖都是「按 id 找比赛」，这里同步一份给 seatLabel 用 */
        MATCH_BY_ID = byId;
        buildSeedMap(list);

        var roundNos = [];
        list.forEach(function (m) {
            if (roundNos.indexOf(m.round) === -1) roundNos.push(m.round);
        });
        roundNos.sort(function (a, b) { return a - b; });

        var rounds = roundNos.map(function (n, i) {
            var def = roundsDef[i];
            return { n: n, name: (def && def.name) || ('第 ' + n + ' 轮') };
        });

        var byRound = {};
        rounds.forEach(function (r) { byRound[r.n] = []; });
        list.forEach(function (m) {
            if (byRound[m.round]) byRound[m.round].push(m);
        });
        rounds.forEach(function (r) {
            byRound[r.n].sort(function (a, b) { return (a.pos || 0) - (b.pos || 0); });
        });

        var resolveCache = {};

        function nameOf(id) {
            if (!id) return '待定';
            var t = teams[id];
            return (t && (t.name || t.short)) || String(id);
        }

        function planOf(raw) {
            if (raw == null) return { kind: 'bye', raw: raw, team: null };
            raw = String(raw);
            if (raw.charAt(0) === '$') {
                /* "$m13" 取胜者，尾部多一个 L 取负者（铜牌赛） */
                var ref = raw.slice(1);
                var wantLoser = ref.charAt(ref.length - 1) === 'L';
                var srcId = wantLoser ? ref.slice(0, -1) : ref;
                return { kind: 'ref', raw: raw, team: resolveOf(srcId, wantLoser) };
            }
            return { kind: 'team', raw: raw, team: raw };
        }

        /* 没打出来的席位不写「待定」，写它落在哪几个号位上：「3-4位胜者」 */
        function descOf(raw) {
            if (raw == null) return txt('bye', '轮空');
            var lose = String(raw).charAt(String(raw).length - 1) === 'L';
            return seatLabel(raw, lose);
        }

        /* 取某场比赛的胜者 / 负者；未决出则为 null */
        function resolveOf(id, wantLoser) {
            var key = id + (wantLoser ? ':L' : ':W');
            if (Object.prototype.hasOwnProperty.call(resolveCache, key)) return resolveCache[key];
            /* 先占位，避免数据里出现互相引用时无限递归 */
            resolveCache[key] = null;
            var m = byId[id];
            if (!m) return null;
            var r = evalMatch(m);
            resolveCache[key] = wantLoser ? r.loser : r.winner;
            return resolveCache[key];
        }

        function winnerOf(id) { return resolveOf(id, false); }

        function evalMatch(m) {
            var isBye = (m.home == null) || (m.away == null);
            var bothEmpty = (m.home == null) && (m.away == null);
            var hp = planOf(m.home);
            var ap = planOf(m.away);
            var st = statusOf(m);
            var sets = m.sets || [];
            var score = bigScore(m);
            var side = winSideOf(m);          /* 手选的晋级方 */

            var decided = false, winner = null, loser = null;

            if (bothEmpty) {
                decided = false;
            } else if (isBye) {
                var alive = (m.home == null) ? ap.team : hp.team;
                decided = !!alive;
                winner = alive || null;
            } else if (side && hp.team && ap.team) {
                decided = true;
                winner = side === 'home' ? hp.team : ap.team;
                loser = side === 'home' ? ap.team : hp.team;
            }

            return {
                isBye: isBye,
                bothEmpty: bothEmpty,
                hp: hp, ap: ap,
                status: st,
                score: score,
                hasScore: (m.score != null) || sets.length > 0,
                decided: decided,
                winner: winner,
                loser: loser,
                tbd: !isBye && (!hp.team || !ap.team)
            };
        }

        return {
            rounds: rounds, list: list, byRound: byRound, byId: byId,
            eval: evalMatch, nameOf: nameOf, descOf: descOf
        };
    }

    /** 上一轮 pos 2p-1 与 2p 汇入下一轮 pos p */
    function buildChildrenMap(ctx) {
        var map = {};
        ctx.rounds.forEach(function (r, ri) {
            if (ri === 0) return;
            var prev = ctx.byRound[ctx.rounds[ri - 1].n] || [];
            var cur = ctx.byRound[r.n] || [];
            cur.forEach(function (pm, i) {
                var a = prev[i * 2], b = prev[i * 2 + 1];
                if (a) (map[pm.id] = map[pm.id] || []).push(a.id);
                if (b) (map[pm.id] = map[pm.id] || []).push(b.id);
            });
        });
        return map;
    }

    /* ---------------- 淘汰树：DOM ---------------- */

    function buildBracketCard(m, info, ctx) {
        var card = document.createElement('article');
        card.className = 'bk-card';
        card.setAttribute('data-status', info.status);
        if (info.tbd) card.setAttribute('data-tbd', '1');

        function row(key) {
            var plan = key === 'home' ? info.hp : info.ap;
            var id = plan.team;

            /* 轮空：这一侧连「待定」都不写，
               但仍渲染同样的结构与不换行空格，高度才和普通对阵行一致 */
            if (!id && info.isBye) {
                return '<div class="bk-row bk-row--void">' +
                           '<span class="bk-name">&nbsp;</span>' +
                           '<span class="bk-sc">&nbsp;</span>' +
                       '</div>';
            }

            var outcome;
            if (!id) outcome = 'tbd';
            else if (info.decided) outcome = (id === info.winner) ? 'win' : 'lose';
            else outcome = 'none';

            var sc = '-';
            if (info.hasScore && id) {
                sc = String(key === 'home' ? info.score.home : info.score.away);
            }

            /* 晋级的队伍（含轮空直接晋级的）涂一层黄色荧光笔 */
            var nm = id
                ? (outcome === 'win' ? '<span class="hl">' + esc(ctx.nameOf(id)) + '</span>'
                                     : esc(ctx.nameOf(id)))
                : esc(ctx.descOf(plan.raw));


            return '<div class="bk-row" data-outcome="' + outcome + '">' +
                       '<span class="bk-name">' + nm + '</span>' +
                       '<span class="bk-sc">' + sc + '</span>' +
                   '</div>';
        }

        card.innerHTML =
            '<div class="bk-card-hd">' +
                '<span class="bk-time">' + esc(m.time || '待定') + '</span>' +
                (m.court ? '<span class="bk-court">' + esc(m.court) + '</span>' : '') +
            '</div>' +
            row('home') + row('away');

        return card;
    }

    /**
     * 竖向模块化排布：每一轮是一条横向「模块带」，自上而下推进，决赛在最底部居中。
     * 每轮按 pos 对半切成上半区 / 下半区两个等宽模块：
     *   16 强  [上半区 b1~b4] [下半区 b5~b8]
    *    八强   [b9 b10]       [b11 b12]
     *   四强   [b13]          [b14]
     *   决赛           [b15]
     * 模块等宽是关键：两边都是 space-around 均分，父节点会自动落在两个子节点正中。
     */
    function buildBandPlan(ctx) {
        var rounds = ctx.rounds;
        var bands = [];

        rounds.forEach(function (r, i) {
            var all = ctx.byRound[r.n] || [];

            if (i === rounds.length - 1) {
                bands.push({ round: r, isFinal: true, mods: [{ side: 'C', matches: all }] });
                return;
            }

            var mid = Math.ceil(all.length / 2);
            bands.push({
                round: r,
                isFinal: false,
                mods: [
                    { side: 'L', matches: all.slice(0, mid) },
                    { side: 'R', matches: all.slice(mid) }
                ]
            });
        });

        return bands;
    }

    function renderBracket(data, teams) {
        var ctx = buildBracketCtx(data, teams);
        BRACKET = { ctx: ctx, board: null, svg: null, childrenOf: null };

        el.main.innerHTML = '';

        var wrap = document.createElement('div');
        wrap.className = 'bk-wrap';

        var board = document.createElement('div');
        board.className = 'bk-board';

        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'bk-links');

        buildBandPlan(ctx).forEach(function (band) {
            var sec = document.createElement('section');
            sec.className = 'bk-round';
            sec.setAttribute('data-round', band.round.n);
            if (band.isFinal) sec.setAttribute('data-final', '1');

            /* 轮次标题只留决赛（黑底黄字那枚），
               其余三轮靠号位标签与中轴虚线表达，不再堆文字 */
            if (band.isFinal) {
                var h = document.createElement('h3');
                h.className = 'bk-round-title';
                h.textContent = band.round.name;
                sec.appendChild(h);
            }

            var mods = document.createElement('div');
            mods.className = 'bk-mods';

            band.mods.forEach(function (mod) {
                var modEl = document.createElement('div');
                modEl.className = 'bk-mod';
                modEl.setAttribute('data-side', mod.side);

                /* 首轮标出号位区间，交代上下半区的来源 */
                if (!band.isFinal && band.round === ctx.rounds[0]) {
                    var tag = document.createElement('span');
                    tag.className = 'bk-mod-tag';
                    tag.textContent = (mod.side === 'L')
                        ? '上半区 · 1–8 号位'
                        : '下半区 · 9–16 号位';
                    modEl.appendChild(tag);
                }

                var col = document.createElement('div');
                col.className = 'bk-col';

                mod.matches.forEach(function (m) {
                    var info = ctx.eval(m);
                    var node = buildBracketCard(m, info, ctx);
                    node.setAttribute('data-node-id', m.id);
                    node.setAttribute('data-round', band.round.n);
                    node.setAttribute('data-side', mod.side);

                    var slot = document.createElement('div');
                    slot.className = 'bk-slot';
                    slot.appendChild(node);
                    col.appendChild(slot);
                });

                modEl.appendChild(col);
                mods.appendChild(modEl);
            });

            sec.appendChild(mods);
            board.appendChild(sec);
        });

        board.appendChild(svg);
        wrap.appendChild(board);

        el.main.appendChild(wrap);

        BRACKET.board = board;
        BRACKET.svg = svg;
        BRACKET.childrenOf = buildChildrenMap(ctx);

        watchBoard(board);
    }

    /* ---------------- 淘汰树：连接线 ---------------- */

    function watchBoard(board) {
        drawLinks();

        /* 某些环境（如 JSDOM）没有 rAF，这里必须容错：
           一旦抛错会被 loadData 的 catch 捕获，整页变成「数据解析失败」 */
        if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(drawLinks);
        } else {
            setTimeout(drawLinks, 0);
        }

        if (window.ResizeObserver) {
            new ResizeObserver(function () { drawLinks(); }).observe(board);
        } else {
            window.addEventListener('resize', drawLinks);
        }
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(drawLinks).catch(function () {});
        }
        /* 入场 transform 结束后坐标才稳定，动画收尾时再测一次 */
        setTimeout(drawLinks, INTRO_END + 80);
    }

    function drawLinks() {
        if (!BRACKET || !BRACKET.board || !BRACKET.svg) return;

        var board = BRACKET.board, svg = BRACKET.svg, ctx = BRACKET.ctx;
        if (!board.offsetWidth || !board.offsetHeight) return;

        var base = board.getBoundingClientRect();
        svg.setAttribute('viewBox', '0 0 ' + board.offsetWidth + ' ' + board.offsetHeight);

        while (svg.firstChild) svg.removeChild(svg.firstChild);

        function add(attrs) {
            var e = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
            svg.appendChild(e);
        }

        function boxOf(id) {
            var node = board.querySelector('[data-node-id="' + id + '"]');
            if (!node) return null;
            var r = node.getBoundingClientRect();
            if (!r.width && !r.height) return null;
            return {
                left: r.left - base.left,
                right: r.right - base.left,
                top: r.top - base.top,
                bottom: r.bottom - base.top,
                cx: r.left - base.left + r.width / 2,
                cy: r.top - base.top + r.height / 2
            };
        }

        function n(v) { return Math.round(v * 10) / 10; }

        /** 竖向下行：垂直 → 斜切 45° → 水平并入汇合点 */
        function chamferDown(x1, y1, xm, ym) {
            if (Math.abs(xm - x1) < 1) return 'M' + n(x1) + ' ' + n(y1) + ' L' + n(xm) + ' ' + n(ym);
            var avail = Math.abs(ym - y1);
            var c = Math.min(18, avail - 2, Math.abs(xm - x1));
            if (c < 2 || avail < 4) {
                return 'M' + n(x1) + ' ' + n(y1) + ' L' + n(x1) + ' ' + n(ym) + ' L' + n(xm) + ' ' + n(ym);
            }
            var hdir = xm > x1 ? 1 : -1;
            return 'M' + n(x1) + ' ' + n(y1) +
                   ' L' + n(x1) + ' ' + n(ym - c) +
                   ' L' + n(xm - hdir * c) + ' ' + n(ym) +
                   ' L' + n(xm) + ' ' + n(ym);
        }

        /** 竖向 Z 字：垂直下行 → 斜切 → 垂直（轮空直连用） */
        function zDown(x1, y1, xm, ym) {
            if (Math.abs(xm - x1) < 1) return 'M' + n(x1) + ' ' + n(y1) + ' L' + n(xm) + ' ' + n(ym);
            var avail = Math.abs(ym - y1);
            var run = Math.min(Math.abs(xm - x1), avail * 0.6);
            if (run < 2) return 'M' + n(x1) + ' ' + n(y1) + ' L' + n(xm) + ' ' + n(ym);
            var flat = (avail - run) / 2;
            return 'M' + n(x1) + ' ' + n(y1) +
                   ' L' + n(x1) + ' ' + n(y1 + flat) +
                   ' L' + n(xm) + ' ' + n(y1 + flat + run) +
                   ' L' + n(xm) + ' ' + n(ym);
        }

        /** 节点：菱形 / 平行四边形，不用圆点 */
        /** 拐弯节点统一用菱形 */
        function markPath(mx, my) {
            var s = 7.5;
            return 'M' + n(mx) + ' ' + n(my - s) +
                   ' L' + n(mx + s) + ' ' + n(my) +
                   ' L' + n(mx) + ' ' + n(my + s) +
                   ' L' + n(mx - s) + ' ' + n(my) + ' Z';
        }

        Object.keys(BRACKET.childrenOf).forEach(function (pid) {
            var pairs = [];
            (BRACKET.childrenOf[pid] || []).forEach(function (cid) {
                var b = boxOf(cid);
                if (b) pairs.push({ id: cid, box: b });
            });

            var target = boxOf(pid);
            if (!target || !pairs.length) return;

            /* 竖向：父节点在下方，从子节点底边向下汇入 */
            var yStart = Math.max.apply(null, pairs.map(function (p) { return p.box.bottom; }));
            var targetEdge = target.top;
            var availTotal = targetEdge - yStart;
            if (availTotal < 16) return;

            /* 汇合点：纵向取子节点底边与父节点顶边的中点，横向取两个子节点的中点 */
            var ym = yStart + availTotal * 0.5;
            var xs = pairs.map(function (p) { return p.box.cx; });
            var xm = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
            var tx = target.cx;

            var parentInfo = ctx.eval(ctx.byId[pid]);
            var cls = parentInfo.decided ? 'bk-link--won' : 'bk-link--open';

            /* 轮空与正常比赛走同一条线：同样的斜切走法、同样的粗细与已/未决出样式 */
            pairs.forEach(function (p) {
                add({
                    d: chamferDown(p.box.cx, p.box.bottom, xm, ym),
                    'class': 'bk-link ' + cls
                });
            });

            /* 汇合 → 父节点：已决出的再叠一条细黄线，做出「斩」出去的收锋 */
            var dOut = Math.abs(tx - xm) < 1
                ? ('M' + n(xm) + ' ' + n(ym) + ' L' + n(tx) + ' ' + n(targetEdge))
                : zDown(xm, ym, tx, targetEdge);

            add({ d: dOut, 'class': 'bk-link ' + cls });
            if (parentInfo.decided) {
                add({ d: dOut, 'class': 'bk-link bk-link--cut' });
            }

            add({
                d: markPath(xm, ym),
                'class': 'bk-mark ' + (parentInfo.decided ? 'bk-mark--a' : 'bk-mark--b')
            });
        });
    }

    function buildMatch(m, teams, index) {
        var st = statusOf(m);
        var bye = byeSide(m);                 /* 'home' | 'away' | null：轮空时活着的那一侧 */
        var sets = m.sets || [];
        var score = bigScore(m);
        var side = winSideOf(m);              /* 管理页手选的晋级方 */

        function nameOfSide(key) {
            return seatName(m[key], teams);
        }

        /* 轮空直接晋级：不用填比分，活着的那一侧就是胜者 */
        var homeWin = side === 'home';
        var awayWin = side === 'away';
        var showScore = !bye && ((m.score != null) || sets.length > 0);
        var badge = bye ? txt('byeAdvance', '直接晋级') : (STATUS_TEXT[st] || st);

        var art = document.createElement('article');
        art.className = 'match';
        art.setAttribute('data-status', st);
        if (bye) art.setAttribute('data-bye', bye);
        if (typeof index === 'number') {
            art.style.setProperty('--i', index);
        }

        art.innerHTML =
            '<div class="match-top">' +
                '<span class="match-date">' + esc(fmtDay(m.date)) + '</span>' +
                '<span class="match-week">' + esc(parseDate(m.date).week) + '</span>' +
                '<span class="match-time">' + esc(m.time || '待定') + '</span>' +
                (m.court ? '<span class="match-court">' + esc(m.court) + '</span>' : '') +
            '</div>' +

            '<div class="match-body">' +
                '<div class="team home' + (homeWin ? ' is-winner' : '') +
                     (m.home == null ? ' is-bye' : '') + '">' +
                    '<span class="team-name' + (homeWin ? ' hl' : '') + '">' +
                        esc(nameOfSide('home')) + '</span>' +
                '</div>' +
                '<div class="score">' +
                    '<span class="score-num home' + (homeWin ? ' is-winner' : '') + '">' +
                        (showScore ? score.home : '-') + '</span>' +
                    '<span class="score-sep"><i></i><i></i></span>' +
                    '<span class="score-num away' + (awayWin ? ' is-winner' : '') + '">' +
                        (showScore ? score.away : '-') + '</span>' +
                '</div>' +
                '<div class="team away' + (awayWin ? ' is-winner' : '') +
                     (m.away == null ? ' is-bye' : '') + '">' +
                    '<span class="team-name' + (awayWin ? ' hl' : '') + '">' +
                        esc(nameOfSide('away')) + '</span>' +
                '</div>' +
            '</div>' +

            buildSets(m) +

            '<div class="match-status">' +
                '<span class="status-badge">' + esc(badge) + '</span>' +
            '</div>' +

            (m.note ? '<div class="match-note">' + esc(m.note) + '</div>' : '');

        return art;
    }

    /* 每局小分。没有局分也输出这一行（空的），
       这样未开始 / 轮空的卡片和已结束的卡片一样高 */
    function buildSets(m) {
        var sets = m.sets || [];

        var html = sets.map(function (s) {
            return '<span class="set' + (s.home > s.away ? ' is-win' : '') + '">' +
                   s.home + '-' + s.away + '</span>';
        }).join('');

        return '<div class="match-sets' + (sets.length ? '' : ' is-empty') + '">' +
                   '<div class="sets">' + html + '</div>' +
               '</div>';
    }

    /* ---------------- 状态显示 ---------------- */

    function setLoading(on) {
        document.body.classList.toggle('is-loading', on);
    }

    function showError(msg) {
        el.main.innerHTML = '<div class="state-hint is-error">' + esc(msg) + '</div>';
    }

    /* ---------------- 主题切换 ---------------- */

    function isAnimated(name) {
        return ANIMATED_THEMES.indexOf(name) !== -1;
    }

    function prefersReducedMotion() {
        return !!(window.matchMedia &&
                  window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function applyTheme(name, withIntro) {
        if (VALID_THEMES.indexOf(name) === -1) name = 'boom';
        el.body.setAttribute('data-theme', name);

        if (withIntro !== false && isAnimated(name) && !prefersReducedMotion()) {
            playIntro();
        } else {
            settleNow();
        }
    }

    function initTheme() {
        applyTheme('boom', true);
    }

    /* ---------------- 开场动画控制 ---------------- */

    var introTimers = [];

    function clearIntroTimers() {
        introTimers.forEach(function (t) { clearTimeout(t); });
        introTimers = [];
    }

    /** 排球飘入 → 落定「啪」 → 涟漪把界面逐层推开 */
    function playIntro() {
        if (!el.intro) { settleNow(); return; }

        clearIntroTimers();
        el.body.classList.remove('is-settled', 'is-loaded');
        el.body.classList.add('is-intro');
        el.intro.hidden = false;
        el.intro.classList.remove('is-done');

        introTimers.push(setTimeout(function () {
            el.body.classList.remove('is-intro');
            el.body.classList.add('is-loaded');
        }, INTRO_SETTLE));

        introTimers.push(setTimeout(function () {
            el.intro.classList.add('is-done');
        }, INTRO_FADE));

        introTimers.push(setTimeout(function () {
            el.intro.hidden = true;
            el.body.classList.remove('is-loaded');
            el.body.classList.add('is-settled');
        }, INTRO_END));
    }

    /** 跳过动画，直接定格到首页 */
    function settleNow() {
        clearIntroTimers();
        if (el.intro) {
            el.intro.classList.add('is-done');
            el.intro.hidden = true;
        }
        el.body.classList.remove('is-intro', 'is-loaded');
        el.body.classList.add('is-settled');
    }

    /* ---------------- 公告栏 ---------------- */

    function renderNotice() {
        var text = String(SITE.notice || '').trim();
        if (!text) {
            el.notice.hidden = true;
            return;
        }
        el.noticeText.textContent = text;
        el.notice.hidden = false;
    }

    /* ---------------- 头部高度同步 ---------------- */
    /* 头部在窄屏下会换行变高，动态测量后写进 CSS 变量，保证日期标题吸顶位置正确 */
    function syncHeaderHeight() {
        var header = document.querySelector('.site-header');
        if (!header) return;

        var apply = function () {
            document.documentElement.style.setProperty(
                '--header-h', header.offsetHeight + 'px'
            );
        };

        apply();
        if (window.ResizeObserver) {
            new ResizeObserver(apply).observe(header);
        } else {
            window.addEventListener('resize', apply);
        }
    }

    /* ---------------- 自动刷新 ---------------- */

    function scheduleAutoRefresh() {
        if (refreshTimer) clearInterval(refreshTimer);
        var sec = Number(SITE.autoRefresh) || 0;
        if (sec > 0) refreshTimer = setInterval(loadData, sec * 1000);
    }

    /* ---------------- 启动 ---------------- */

    function init() {
        initTheme();
        bindViewSwitch();

        if (el.intro) {
            el.intro.addEventListener('click', settleNow);
        }

        syncHeaderHeight();

        /* 先取站点配置（标题 / 公告 / 文案），再取赛程数据 */
        loadSite().then(loadData);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
