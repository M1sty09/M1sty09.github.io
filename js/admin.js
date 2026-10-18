/* ============================================================
   数据管理页逻辑
   ------------------------------------------------------------
   只做四件事：改公告、填大比分、选晋级、填小比分（局分）+ 备注。
   大比分和晋级一律手填 / 手选，不从局分反推；轮空的那侧自动晋级，整张卡只读、不用填。
   状态不再给选项：有比分数据就是已结束，没填就是未开始（和前台同一套规则）。
   队伍、赛程、时间场地都是固定的，这里一律只读显示。
   改动先进内存，点「保存」或 Ctrl+S 才写入 data/*.json
   ============================================================ */
(function () {
    'use strict';

    var STORE = window.SCHED_STORE;

    var FILES = ['site', 'tournament', 'teams', 'matches', 'bracket'];

    var DATA = {};      /* 五个 JSON 的内容（队伍、赛程只读，但显示名字要用） */
    var DIRTY = {};     /* 哪些文件被改过 */

    /* ---------------- 小工具 ---------------- */

    function $(id) { return document.getElementById(id); }

    function h(tag, attrs, kids) {
        var e = document.createElement(tag);
        attrs = attrs || {};
        Object.keys(attrs).forEach(function (k) {
            var v = attrs[k];
            if (v == null || v === false) return;
            if (k === 'class') e.className = v;
            else if (k === 'text') e.textContent = v;
            else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
            else e.setAttribute(k, v);
        });
        (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
        return e;
    }

    function textInput(value, oninput, opts) {
        opts = opts || {};
        var e = h('input', {
            type: opts.type || 'text',
            value: value == null ? '' : value,
            placeholder: opts.ph || ''
        });
        e.addEventListener('input', function () { oninput(e.value); });
        return e;
    }

    function numInput(value, oninput) {
        var e = h('input', {
            type: 'number',
            value: value == null ? '' : value,
            min: 0,
            step: 1
        });
        e.addEventListener('input', function () { oninput(parseInt(e.value, 10) || 0); });
        return e;
    }

    /* 状态用一排按钮选，比下拉框直观 */
    function seg(options, value, onchange) {
        var box = h('div', { class: 'seg' });
        options.forEach(function (o) {
            var b = h('button', {
                class: 'seg-btn' + (String(o.v) === String(value) ? ' is-active' : ''),
                text: o.t,
                'data-v': o.v
            });
            b.addEventListener('click', function () { onchange(o.v); });
            box.appendChild(b);
        });
        return box;
    }

    function toast(msg, kind) {
        var t = h('div', { class: 'toast ' + (kind || ''), text: msg });
        $('toasts').appendChild(t);
        setTimeout(function () {
            t.classList.add('out');
            setTimeout(function () { t.remove(); }, 260);
        }, kind === 'err' ? 5200 : 3200);
    }

    /* ---------------- 数据读写 ---------------- */

    function touch(file) {
        DIRTY[file] = true;
        updateDirty();
    }

    function updateDirty() {
        var names = Object.keys(DIRTY).filter(function (k) { return DIRTY[k]; });
        var el = $('dirty');
        el.textContent = names.length ? ('● ' + names.length + ' 个文件待保存') : '全部已保存';
        el.className = 'dirty' + (names.length ? '' : ' is-clean');
        $('saveBtn').disabled = !names.length;
    }

    function loadAll() {
        return STORE.detect().then(function () {
            applyStoreBadge();
            return Promise.all(FILES.map(function (f) {
                return STORE.read(f).then(function (t) { DATA[f] = JSON.parse(t); });
            }));
        }).then(function () {
            DIRTY = {};
            updateDirty();
            render();
        }).catch(function (e) {
            applyStoreBadge();
            var box = h('div', { class: 'wrap' });
            var empty = h('div', { class: 'empty', text: '数据加载失败：' + e.message });

            if (/还没填 GitHub/.test(e.message)) {
                var link = h('a', { href: '#', class: 'link', text: '配置 GitHub 仓库 →' });
                link.addEventListener('click', function (ev) {
                    ev.preventDefault();
                    openStoreDialog();
                });
                empty.appendChild(document.createTextNode('　'));
                empty.appendChild(link);
            }

            box.appendChild(empty);
            $('view').innerHTML = '';
            $('view').appendChild(box);
        });
    }

    function saveAll() {
        var names = Object.keys(DIRTY).filter(function (k) { return DIRTY[k]; });
        if (!names.length) return;

        $('saveBtn').disabled = true;
        var done = [];

        var chain = Promise.resolve();
        names.forEach(function (n) {
            chain = chain.then(function () {
                return STORE.write(n, JSON.stringify(DATA[n], null, 4) + '\n')
                    .then(function () {
                        DIRTY[n] = false;
                        done.push(n + '.json');
                    });
            });
        });

        chain.then(function () {
            updateDirty();
            if (STORE.mode() === 'github') {
                toast('已提交到 GitHub：' + done.join('、') +
                      '。Pages 通常 1 分钟内自动更新', 'ok');
            } else {
                toast('已保存 ' + done.join('、') + '，前台刷新即可看到', 'ok');
            }
        }).catch(function (e) {
            updateDirty();
            toast('保存失败：' + e.message, 'err');
        });
    }

    /* ---------------- 只读计算 ---------------- */

    /**
     * 有没有填过比分数据（备注不算）：大比分或任一局有分都算。
     * 前台据此判定「已结束 / 未开始」，后台不再给状态选项。
     */
    function hasResult(m) {
        var s = m.score;
        if (s && (+s.home > 0 || +s.away > 0)) return true;
        return (m.sets || []).some(function (x) {
            return +x.home > 0 || +x.away > 0;
        });
    }

    function matchById(id) {
        return (DATA.matches || []).filter(function (m) { return m.id === id; })[0];
    }

    function teamName(id) {
        var t = (DATA.teams || []).filter(function (x) { return x.id === id; })[0];
        return t ? t.name : (id || '待定');
    }

    /* 一个席位的名字：队伍 / 轮空 / 某场的胜者或负者 */
    function sideLabel(raw) {
        if (raw == null) return '轮空';
        var s = String(raw);
        if (s.charAt(0) !== '$') return teamName(s);

        var ref = s.slice(1);
        var wantLoser = ref.charAt(ref.length - 1) === 'L';
        var srcId = wantLoser ? ref.slice(0, -1) : ref;
        var m = matchById(srcId);
        var who = m ? (wantLoser ? loserName(m) : winnerName(m)) : '';
        return (wantLoser ? '负者 · ' : '胜者 · ') + (who || srcId);
    }

    /**
     * 只有一侧为空 = 轮空，另一侧不战而胜、直接晋级，不用填比分。
     * 两侧都空或都填了就不算轮空，返回 null。
     */
    function byeSide(m) {
        var h = (m.home == null), a = (m.away == null);
        if (h === a) return null;
        return h ? 'away' : 'home';
    }

    /* 轮空时直接晋级的那一方（队名） */
    function byeWinner(m) {
        var s = byeSide(m);
        return s ? sideLabel(s === 'home' ? m.home : m.away) : '';
    }

    /* 谁晋级：轮空自动，其余一律以人工选的 m.winner 为准，不看局分 */
    function winSide(m) {
        var bye = byeSide(m);
        if (bye) return bye;
        return (m.winner === 'home' || m.winner === 'away') ? m.winner : null;
    }

    /* 谁晋级完全由人工指定，不从局分推算 */
    function winnerName(m) {
        var s = winSide(m);
        return s ? sideLabel(s === 'home' ? m.home : m.away) : '';
    }

    function loserName(m) {
        var s = winSide(m);
        return s ? sideLabel(s === 'home' ? m.away : m.home) : '';
    }

    function roundName(n) {
        var def = ((DATA.bracket || {}).rounds || [])[n - 1];
        return def ? def.name : ('第 ' + n + ' 轮');
    }

    function dateLabel(d) {
        if (!d) return '待定';
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
        if (!m) return String(d);
        var wd = ((DATA.site || {}).weekdays || [])[new Date(+m[1], +m[2] - 1, +m[3]).getDay()];
        return (+m[2]) + '月' + (+m[3]) + '日' + (wd ? ' ' + wd : '');
    }

    /* ---------------- 比分（主界面） ---------------- */

    function matchCard(m, refresh) {
        var bye = byeSide(m);                 /* 轮空：另一侧直接晋级 */
        var card = h('div', {
            class: 'card' + (hasResult(m) ? ' is-finished' : ' is-upcoming') + (bye ? ' is-bye' : '')
        });

        /* 第一行：什么时候打（只读） + 状态（由比分数据推出来，只读） */
        card.appendChild(h('div', { class: 'card-top' }, [
            h('div', { class: 'meta' }, [
                h('b', { text: dateLabel(m.date) + (m.time ? '  ' + m.time : '') }),
                /* 轮空没有场地，只写场次号 */
                h('span', {
                    class: 'tag-use',
                    text: bye ? m.id : ((m.court || '场地待定') + ' · ' + m.id)
                })
            ]),
            h('span', { class: 'spacer' }),
            h('span', {
                class: 'state-tag is-' + (hasResult(m) ? 'finished' : 'upcoming'),
                text: hasResult(m) ? '已结束' : '未开始'
            })
        ]));

        /* 第二行：谁打谁（只读） + 大比分（手填；轮空不用填） */
        card.appendChild(h('div', { class: 'vs' }, [
            h('span', {
                class: 'side home' + (m.home == null ? ' is-bye' : ''),
                text: sideLabel(m.home)
            }),
            bye ? h('div', { class: 'score' }, [h('small', { text: '轮空' })])
                : bigScoreEditor(m, card),
            h('span', {
                class: 'side away' + (m.away == null ? ' is-bye' : ''),
                text: sideLabel(m.away)
            })
        ]));

        /* 轮空：整张卡只读，一个输入框都不给 */
        if (bye) {
            card.appendChild(h('div', { class: 'bye-tip' }, [
                h('b', { text: '轮空 · 直接晋级' }),
                h('span', { text: byeWinner(m) + ' 无需比赛，自动进入下一轮，这里不用填任何东西' })
            ]));
            return card;
        }

        /* 晋级（手选） + 小比分（手填） */
        card.appendChild(winnerEditor(m, refresh));
        card.appendChild(setEditor(m, card, refresh));

        /* 最后：备注 */
        var note = textInput(m.note, function (v) { m.note = v; touch('matches'); },
                             { ph: '可不填，例如「因雨顺延」' });
        note.style.width = '100%';
        card.appendChild(h('label', { class: 'note-field' }, [
            h('span', { text: '备注' }), note
        ]));

        return card;
    }

    /* 状态标签跟着数据走：就地改字和配色，不整卡重建，输入焦点不丢 */
    function syncState(card, m) {
        var on = hasResult(m);
        var tag = card.querySelector('.state-tag');
        if (tag) {
            tag.textContent = on ? '已结束' : '未开始';
            tag.className = 'state-tag is-' + (on ? 'finished' : 'upcoming');
        }
        card.classList.toggle('is-finished', on);
        card.classList.toggle('is-upcoming', !on);
    }

    /* 大比分：两个输入框手填，不推算 */
    function bigScoreEditor(m, card) {
        var s = m.score || { home: 0, away: 0 };

        function put(key) {
            return numInput(s[key], function (v) {
                m.score = m.score || { home: 0, away: 0 };
                m.score[key] = v;
                touch('matches');
                syncState(card, m);
            });
        }

        return h('div', { class: 'score' }, [
            h('div', { class: 'score-edit' }, [
                put('home'),
                h('span', { class: 'colon', text: ':' }),
                put('away')
            ]),
            h('small', { text: '大比分' })
        ]);
    }

    /* 晋级：三个按钮手选（未定 / 主队 / 客队），不推算 */
    function winnerEditor(m, refresh) {
        var opts = [
            { v: '', t: '未定' },
            { v: 'home', t: sideLabel(m.home) },
            { v: 'away', t: sideLabel(m.away) }
        ];

        return h('label', { class: 'winner-field' }, [
            h('span', { text: '晋级' }),
            seg(opts, m.winner || '', function (v) {
                if (v) m.winner = v;
                else delete m.winner;
                touch('matches');
                refresh();
            })
        ]);
    }

    /* 小比分：逐局手填，只记数字，不反推大比分和晋级 */
    function setEditor(m, card, refresh) {
        var wrap = h('div', { class: 'sets' });

        (m.sets || []).forEach(function (s, i) {
            wrap.appendChild(h('div', { class: 'set' }, [
                h('span', { class: 'idx', text: '第' + (i + 1) + '局' }),
                numInput(s.home, function (v) {
                    s.home = v; touch('matches'); syncState(card, m);
                }),
                h('span', { class: 'colon', text: ':' }),
                numInput(s.away, function (v) {
                    s.away = v; touch('matches'); syncState(card, m);
                })
            ]));
        });

        wrap.appendChild(h('button', {
            class: 'btn small ghost', text: '＋ 加一局',
            onclick: function () {
                (m.sets = m.sets || []).push({ home: 0, away: 0 });
                touch('matches');
                refresh();
            }
        }));

        if ((m.sets || []).length) {
            wrap.appendChild(h('button', {
                class: 'btn small ghost', text: '清空比分',
                onclick: function () {
                    m.sets = [];
                    delete m.score;
                    touch('matches');
                    refresh();
                }
            }));
        }

        return wrap;
    }

    function renderMatches() {
        var wrap = h('section', { class: 'sec' });
        var list = DATA.matches || [];

        wrap.appendChild(h('div', { class: 'section-head' }, [
            h('h2', { text: '比赛比分' }),
            h('p', { text: '只填比分、状态、备注 · 改完点右上角「保存」（Ctrl+S）' })
        ]));

        /* 按轮次分组，一轮一栏，栏与栏之间一条实线 */
        var byRound = {};
        list.forEach(function (m) {
            var k = m.round == null ? 0 : m.round;
            (byRound[k] = byRound[k] || []).push(m);
        });

        var listBox = h('div');
        Object.keys(byRound).sort(function (a, b) { return a - b; }).forEach(function (k) {
            var ms = byRound[k].slice().sort(function (a, b) {
                return (a.pos || 0) - (b.pos || 0);
            });

            var box = h('div', { class: 'round' });
            box.appendChild(h('div', { class: 'round-head' }, [
                h('h3', { text: k === '0' || k === 0 ? '其它' : roundName(+k) })
            ]));

            var grid = h('div', { class: 'bracket-grid' });
            ms.forEach(function (m) {
                grid.appendChild(matchCard(m, refresh));
            });
            box.appendChild(grid);
            listBox.appendChild(box);
        });
        wrap.appendChild(listBox);

        return wrap;
    }

    /* ---------------- 公告 ---------------- */

    function renderNotice() {
        var site = DATA.site || {};
        var wrap = h('section', { class: 'sec' });

        wrap.appendChild(h('div', { class: 'section-head' }, [
            h('h2', { text: '公告' }),
            h('p', { text: '显示在首页顶部 · 留空则前台不显示这一块' })
        ]));

        var block = h('div', { class: 'block' });
        var area = h('textarea', { value: site.notice || '', placeholder: '例如：因雨，今日下午比赛顺延至明天同一时间' });
        area.addEventListener('input', function () { site.notice = area.value; touch('site'); });

        block.appendChild(h('label', { class: 'field' }, [
            h('span', { text: '公告正文' }), area
        ]));
        block.appendChild(h('div', { class: 'toolbar' }, [
            h('button', {
                class: 'btn small ghost', text: '清空公告',
                onclick: function () {
                    site.notice = '';
                    area.value = '';
                    touch('site');
                }
            }),
            h('span', { class: 'tag-use', text: '改完记得点右上角「保存」' })
        ]));
        wrap.appendChild(block);

        return wrap;
    }

    /* ---------------- 渲染调度 ---------------- */

    function render() {
        var view = $('view');
        var top = view.scrollTop;
        view.innerHTML = '';

        var page = h('div', { class: 'wrap' });
        page.appendChild(renderNotice());
        page.appendChild(renderMatches());

        view.appendChild(page);
        view.scrollTop = top;

        $('hint').textContent = '共 ' + (DATA.matches || []).length + ' 场';
    }

    function refresh() { render(); }

    /* ---------------- 数据源：本地文件 / GitHub 仓库 ---------------- */

    function applyStoreBadge() {
        var btn = $('storeBtn');
        if (!btn) return;
        var gh = STORE.mode() === 'github';
        btn.textContent = gh ? '数据源：GitHub 仓库' : '数据源：本地文件';
        btn.classList.toggle('is-github', gh);
    }

    function syncStoreFields() {
        $('storeGh').hidden = ($('storeMode').value === 'local');
    }

    function openStoreDialog() {
        var c = STORE.config();
        $('storeMode').value = c.mode;
        $('storeOwner').value = c.owner;
        $('storeRepo').value = c.repo;
        $('storeBranch').value = c.branch;
        $('storeDir').value = c.dir;
        $('storeToken').value = c.token;
        syncStoreFields();
        $('storeModal').hidden = false;
        $('storeOwner').focus();
    }

    function closeStoreDialog() {
        $('storeModal').hidden = true;
    }

    function submitStore() {
        var next = {
            mode: $('storeMode').value,
            owner: $('storeOwner').value.trim(),
            repo: $('storeRepo').value.trim(),
            branch: $('storeBranch').value.trim() || 'main',
            dir: $('storeDir').value.trim() || 'data',
            token: $('storeToken').value.trim()
        };

        if (next.mode !== 'local' && !(next.owner && next.repo && next.token)) {
            toast('GitHub 模式要填 owner、repo 和 PAT', 'err');
            return;
        }

        try {
            STORE.saveConfig(next);
        } catch (e) {
            toast(e.message, 'err');
            return;
        }

        closeStoreDialog();
        DIRTY = {};
        updateDirty();
        toast('数据源已切换，正在重新加载…', 'ok');
        loadAll();
    }

    function bind() {
        $('saveBtn').addEventListener('click', saveAll);
        $('storeBtn').addEventListener('click', openStoreDialog);
        $('storeCancel').addEventListener('click', closeStoreDialog);
        $('storeSave').addEventListener('click', submitStore);
        $('storeMode').addEventListener('change', syncStoreFields);
        $('storeModal').addEventListener('click', function (e) {
            if (e.target === $('storeModal')) closeStoreDialog();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !$('storeModal').hidden) closeStoreDialog();
        });
        $('reloadBtn').addEventListener('click', function () {
            var n = Object.keys(DIRTY).filter(function (k) { return DIRTY[k]; }).length;
            if (n && !confirm('放弃 ' + n + ' 个文件的改动？')) return;
            loadAll();
        });
        document.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                saveAll();
            }
        });

        window.addEventListener('beforeunload', function (e) {
            var n = Object.keys(DIRTY).filter(function (k) { return DIRTY[k]; }).length;
            if (!n) return;
            e.preventDefault();
            e.returnValue = '';
        });
    }

    bind();
    loadAll();
})();
