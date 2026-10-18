/* ============================================================
   数据存储层
   ------------------------------------------------------------
   管理页读写 data/*.json 的两条路，页面代码不用关心走哪条：

     local   本地 node server.js 的 /api/data/<name>
     github  直接提交到 GitHub 仓库里的 <dir>/<name>.json
             （部署到 GitHub Pages 之后就是这条路）

   GitHub 模式需要一枚有 repo 权限的 PAT；token 只存在本机
   localStorage，不会写进代码，也不会发给除 api.github.com 以外的地方。
   ============================================================ */
window.SCHED_STORE = (function () {
    'use strict';

    var KEY = 'sched.store.config';

    var cfg = readCfg();
    var mode = 'local';
    var shaCache = {};

    /* ---------------- 配置 ---------------- */

    function readCfg() {
        try {
            var raw = localStorage.getItem(KEY);
            return raw ? (JSON.parse(raw) || {}) : {};
        } catch (e) {
            return {};
        }
    }

    function config() {
        return {
            mode: cfg.mode || 'auto',
            owner: cfg.owner || '',
            repo: cfg.repo || '',
            branch: cfg.branch || 'main',
            dir: cfg.dir || 'data',
            token: cfg.token || ''
        };
    }

    function saveConfig(next) {
        cfg = next || {};
        shaCache = {};
        try {
            localStorage.setItem(KEY, JSON.stringify(cfg));
        } catch (e) {
            throw new Error('无法写入 localStorage（浏览器是否禁用了本地存储？）');
        }
    }

    function ghReady() {
        return !!(cfg.owner && cfg.repo && cfg.token);
    }

    /* ---------------- 模式探测 ---------------- */

    function detect() {
        if (cfg.mode === 'github') {
            if (!ghReady()) return Promise.reject(new Error('还没填 GitHub 仓库信息'));
            mode = 'github';
            return Promise.resolve(mode);
        }

        if (cfg.mode === 'local') {
            mode = 'local';
            return Promise.resolve(mode);
        }

        /* auto：本地有 server.js 就用本地，否则用 GitHub */
        if (location.protocol === 'file:') {
            mode = 'local';
            return Promise.resolve(mode);
        }

        return fetch('/api/files', { cache: 'no-store' })
            .then(function (r) { return r.ok ? 'local' : 'github'; })
            .catch(function () { return 'github'; })
            .then(function (m) {
                mode = m;
                /* 静态托管（Pages）上没得选，只能走 GitHub，
                   没配置就先拦住，别拿空仓库去撞 API */
                if (mode === 'github' && !ghReady()) {
                    throw new Error('还没填 GitHub 仓库信息');
                }
                return mode;
            });
    }

    /* ---------------- base64（UTF-8 安全） ---------------- */

    function b64encode(text) {
        var bytes = new TextEncoder().encode(text);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }

    function b64decode(b64) {
        var bin = atob(String(b64 || '').replace(/\s/g, ''));
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    }

    /* ---------------- GitHub Contents API ---------------- */

    function repoPath(name) {
        var dir = String(cfg.dir || 'data').replace(/^\/+|\/+$/g, '');
        return (dir ? dir + '/' : '') + name + '.json';
    }

    function apiUrl(path) {
        return 'https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + path;
    }

    function ghHeaders() {
        return {
            'Authorization': 'Bearer ' + cfg.token,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
    }

    function ghError(status, what) {
        if (status === 401) return new Error('GitHub token 无效或已过期，请重新填');
        if (status === 403) return new Error('GitHub 拒绝访问（token 权限不足或触发了限流）');
        if (status === 404) return new Error('仓库 / 分支 / 文件不存在：' + cfg.owner + '/' + cfg.repo);
        if (status === 409) return new Error('文件刚被别人改过，刷新后重试');
        return new Error('GitHub ' + what + '失败（HTTP ' + status + '）');
    }

    function ghRead(name) {
        var url = apiUrl(repoPath(name)) +
                  '?ref=' + encodeURIComponent(cfg.branch || 'main');

        return fetch(url, { headers: ghHeaders(), cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw ghError(r.status, '读取');
                return r.json();
            })
            .then(function (j) {
                shaCache[name] = j.sha;
                return b64decode(j.content);
            });
    }

    function ghWrite(name, text, retried) {
        var path = repoPath(name);
        var body = {
            message: 'data: 更新 ' + name + '.json',
            content: b64encode(text),
            branch: cfg.branch || 'main'
        };
        if (shaCache[name]) body.sha = shaCache[name];

        return fetch(apiUrl(path), {
            method: 'PUT',
            headers: ghHeaders(),
            body: JSON.stringify(body)
        }).then(function (r) {
            if (r.status === 409 && !retried) {
                /* 别人刚提交过：重新取一次 sha 再来 */
                return ghRead(name).then(function () { return ghWrite(name, text, true); });
            }
            if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) {
                throw new Error(ghError(r.status, '提交').message + (j.message ? '：' + j.message : ''));
            });
            return r.json();
        }).then(function (j) {
            if (j && j.content && j.content.sha) shaCache[name] = j.content.sha;
        });
    }

    /* ---------------- 对外的读写 ---------------- */

    function read(name) {
        if (mode === 'github') return ghRead(name);

        return fetch('/api/data/' + name, { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error(name + '.json 读取失败（HTTP ' + r.status + '）');
            return r.text();
        });
    }

    function write(name, text) {
        if (mode === 'github') return ghWrite(name, text, false);

        return fetch('/api/data/' + name, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: text
        }).then(function (r) {
            return r.json();
        }).then(function (res) {
            if (!res.ok) throw new Error(name + '.json：' + res.error);
        });
    }

    return {
        detect: detect,
        read: read,
        write: write,
        config: config,
        saveConfig: saveConfig,
        mode: function () { return mode; },
        ready: ghReady
    };
})();
