# 部署到 GitHub Pages

这个目录是纯静态站点，可直接发布。

## 一、首次发布

1. 新建仓库（例如 `volleyball-schedule`），把 **本目录里的全部内容** 推到 `main` 分支根目录：
   ```
   git init
   git add .
   git commit -m "deploy: 赛程站点"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git push -u origin main
   ```
2. 仓库 → Settings → Pages：
   - Source 选 **Deploy from a branch**
   - Branch 选 **main**，目录选 **/ (root)**，保存
3. 等 1 分钟左右，访问：
   - 赛程：`https://<用户名>.github.io/<仓库名>/`
   - 管理：`https://<用户名>.github.io/<仓库名>/admin.html`

## 二、管理页怎么改数据

Pages 上没有 Node 后端，管理页改成直接用 GitHub API 提交
`data/*.json`，所以第一次打开管理页要先配置：

1. 打开管理页，点左上角「数据源：…」
2. 写入方式选 **GitHub 仓库**
3. 填用户名、仓库名、分支（main）、JSON 目录（data）
4. Token 填一枚 **Fine-grained token**，只勾这个仓库的
   **Contents: Read and write**
   （位置：GitHub → Settings → Developer settings → Personal access tokens）
5. 保存并重载，之后改比分点「保存」就会提交到仓库

保存后 Pages 会重新发布，通常 1 分钟内生效。

> Token 只保存在你这台电脑的 localStorage 里，不会写进仓库。
> 不要在公用电脑上保存，用完可以在弹窗里清空。

## 三、数据文件位置

```
data/site.json        公告、页脚、状态词、界面文案
data/tournament.json  赛事名称 / 副标题
data/teams.json       队伍名
data/matches.json     全部比赛（比分、时间、场地）
data/bracket.json     淘汰树轮次
```
