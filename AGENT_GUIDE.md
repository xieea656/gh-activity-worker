# gh-activity-worker 部署引导（给 AI Agent 看）

## 你的角色

你是一个引导博客作者在博客里嵌入 GitHub 活动卡片的 AI Agent。用户把这份指南贴给你，你要引导他完成部署。

**这份指南是给 Agent 看的，不是给人看的。** 人看的教程在博客文章里。

## 已完成的工作

- **仓库**：https://github.com/xieea656/gh-activity-worker
- 这个仓库已经做好了所有代码，用户只需要 fork + 配置 + 嵌入博客
- **Agent 不需要写任何代码** —— 仓库里的代码已经能跑，Agent 只需要配置和嵌入

## Agent 的前置条件

Agent 需要以下工具才能全自动执行：

- `gh` CLI（GitHub CLI）：fork 仓库、配置 secrets
- `wrangler` CLI（Cloudflare）：配置 Worker、KV、Cron
- git：修改博客仓库
- shell 执行能力

如果 Agent **没有 shell 执行能力**（比如只是 ChatGPT 网页版），告诉用户参考博客文章手动操作，链接：https://blog.xieea.top/使用cloudfare-workers给博客添加一个GitHub热力图（或用户的实际博客 URL）。

## 你需要问用户的信息

Agent 开始前，**一次问完**以下信息（不要一个一个问）：

1. **GitHub 用户名**（小写，比如 `xieea656`）
2. **你想用哪个方案？**
   - 方案 A：Cloudflare Cron Trigger（推荐，触发精确）
   - 方案 B：GitHub Actions 定时（不需要 Cloudflare，但免费用户定时延迟）
3. **你的博客框架**（fuwari / Hexo / Hugo / WordPress / 其他）
4. **你的博客仓库路径**（本地路径，比如 `~/coding/my-blog`）
5. **你的博客域名**（比如 `blog.example.com`）
6. **你的 Cloudflare API token**（方案 A 需要）
7. **你的 GitHub Personal Access Token**（两个方案都需要）

### 引导用户获取 token

如果用户没有 token，引导他获取：

**GitHub Personal Access Token**：
1. 打开 https://github.com/settings/tokens
2. 选择 "Classic"（不用 fine-grained，权限模型更简单）
3. 起一个名字，比如 `gh-activity-widget`
4. 勾选 `read:user`（方案 B 还需要 `repo` 或 `contents:write`）
5. 设置过期时间（建议 1 年，默认 30 天太短）
6. 点 "Generate token"
7. **立刻复制 token**，页面刷新后看不到

**Cloudflare API token**（方案 A）：
1. 登录 Cloudflare Dashboard
2. 右上角头像 → "My Profile" → "API Tokens"
3. 点 "Create Token"
4. 选 "Edit Workers Scripts" 模板
5. 设置过期时间（建议 1 年）
6. 点 "Continue to summary" → "Save and Done"
7. 复制 token

## 方案选择决策树

```
用户想用哪个方案？
├── 不知道 / 都可以 → 推荐方案 A
├── 已经有 Cloudflare 账号 → 方案 A
├── 不想用 Cloudflare → 方案 B
└── 已经在用 GitHub Actions → 方案 B
```

### 方案 A：Cloudflare Cron Trigger（推荐）

- 定时在 Cloudflare 端，Cron Trigger 触发 Worker
- 触发时间精确（分钟级）
- **优点**：不用维护 workflow、触发精确、Worker 直接返回数据、全球 CDN 边缘执行
- **缺点**：Cloudflare 免费版有请求数限制（100K/天）、需要在 Cloudflare 创建多个资源
- Agent 需要：Cloudflare API token + GitHub token

### 方案 B：GitHub Actions 定时

- 定时在 GitHub 端，Actions workflow 触发
- **免费用户定时任务不保证执行时间**（GitHub 官方说 "may delay execution"，实际有 24 小时以上的延迟报告）
- **优点**：不需要 Cloudflare、GitHub 免费额度够用（2000 分钟/月）、workflow 可以版本控制
- **缺点**：定时延迟、需要维护 workflow 文件、GitHub Pages 缓存
- Agent 需要：GitHub token（需要 `read:user` + `contents:write` 权限）

**建议**：如果用户已经在用 Cloudflare（比如有博客托管在 Cloudflare Pages），选方案 A。否则选方案 B。

## 方案 A：Cloudflare Cron Trigger

### Agent 执行步骤

1. **Fork 仓库**
   ```bash
   gh repo fork xieea656/gh-activity-worker --clone
   ```

2. **创建 Cloudflare KV 命名空间**
   ```bash
   wrangler kv namespace create heatmap-kv
   ```
   输出类似：
   ```
   Successfully created namespace heatmap-kv
   Namespace ID: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
   **记下这个 ID**，下一步要用。

3. **修改 wrangler.jsonc**
   
   打开仓库根目录的 `wrangler.jsonc`，做以下修改：
   
   ```jsonc
   {
     "kv_namespaces": [
       {
         "binding": "HEATMAP_KV",
         "id": "刚才输出的 namespace ID"
       }
     ],
     "vars": {
       "HEATMAP_OWNER": "用户的 GitHub 用户名",
       "PARENT_ORIGIN": "用户的博客域名"
     }
   }
   ```
   
   **注意**：
   - `GITHUB_TOKEN` 是 secret，**不能**写进 `vars`，用步骤 5 配置
   - `HEATMAP_OWNER` 是 variable，可以写进 `vars`
   - `PARENT_ORIGIN` 是 variable，可以写进 `vars`
   - `kv_namespaces` 的 `binding` 必须保持 `HEATMAP_KV`（代码里写死了）
   - `crons` 已经在 wrangler.jsonc 里配好了（`"17 3 * * *"`），不需要改

4. **配置 wrangler**
   ```bash
   wrangler login
   ```
   或者用 API token：
   ```bash
   CLOUDFLARE_API_TOKEN="<用户的 Cloudflare token>" wrangler whoami
   ```

5. **部署 Worker**
   ```bash
   wrangler deploy
   ```

6. **配置 GitHub token（secret）**
   ```bash
   wrangler secret put GITHUB_TOKEN
   ```
   提示输入 token 值时，粘贴用户的 GitHub token。

7. **确认 Cron Trigger**
   ```bash
   wrangler cron triggers list
   ```
   应该看到 `17 3 * * *`。如果没有，说明部署失败了，重新检查 wrangler.jsonc。

### 方案 A 易错点

- **Cron 时间是 UTC，不是本地时间** —— `17 3 * * *` 是 UTC 03:17，北京时间 11:17
- **`GITHUB_TOKEN` 是 secret，不是 variable** —— 写进 wrangler.jsonc 的 `vars` 里会报错
- **`HEATMAP_OWNER` 是 variable，不是 secret** —— 可以写进 wrangler.jsonc 的 `vars`
- **KV 绑定名 `HEATMAP_KV` 不能改** —— 代码里写死了这个绑定名
- **`PARENT_ORIGIN` 要收紧成用户自己的博客域名** —— 否则任何站点都能嵌入这个 widget
- **`wrangler.jsonc` 是 JSONC 格式** —— 支持注释，修改时保留注释格式
- **Cloudflare 免费版 Cron 触发频率有限制** —— 如果用户改了 cron 表达式，确保不会超过免费版限制

### 验证方案 A

```bash
# 打开 Worker URL，看有没有返回 JSON
curl "https://<worker-url>/api/heatmap?owner=<username>"
```

返回应该是 JSON 格式，包含 `window`、`calendar`、`commits` 等字段。

## 方案 B：GitHub Actions 定时

### Agent 执行步骤

1. **Fork 仓库**
   ```bash
   gh repo fork xieea656/gh-activity-worker --clone
   ```

2. **添加 workflow 文件**
   
   在 `.github/workflows/collect.yml` 里写入：
   
   ```yaml
   name: 采集 GitHub 活动
   
   on:
     schedule:
       - cron: "17 3 * * *"
     workflow_dispatch:
   
   permissions:
     contents: write
     id-token: write
   
   jobs:
     collect:
       runs-on: ubuntu-latest
       timeout-minutes: 20
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: "22"
         - name: 采集
           env:
             COLLECT_OWNER: ${{ github.actor }}
             GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
           run: |
             node scripts/collect.mjs --owner "${COLLECT_OWNER}" --token "${GITHUB_TOKEN}"
   ```
   
   **注意**：这个 workflow 是简化版。完整的实现参考原始仓库 `gh-widgets` 的 `.github/workflows/collect.yml`。

3. **配置 GitHub Actions secret**
   ```bash
   gh secret set GITHUB_TOKEN --body "<用户的 GitHub token>"
   ```
   
   token 需要 `read:user` 和 `contents:write` 权限。

4. **推送 workflow**
   ```bash
   git add .
   git commit -m "添加 GitHub Actions 采集 workflow"
   git push
   ```

5. **手动触发一次（验证）**
   ```bash
   gh workflow run collect.yml
   ```
   
   等 2-5 分钟，看 workflow 是否成功。

### 方案 B 易错点

- **GitHub Actions 免费用户定时任务不保证执行时间** —— 官方说 "may delay execution"，实际有 24 小时以上的延迟报告
- **`GITHUB_TOKEN` 在 workflow 里默认是只读的** —— 要写入数据需要 `permissions: contents: write`
- **`user` 不是合法的 `permissions` 键** —— Actions 的 `permissions` 是固定枚举（actions / attestations / checks / contents / deployments / discussions / id-token / issues / pages / pull-requests / repository-projects / security-events / statuses），写一个枚举外的键整条 workflow 会在**校验阶段**就被拒，作业根本不会开始跑
- **GitHub Pages 缓存问题** —— 数据更新了但博客不显示，强制刷新浏览器试试
- **workflow 的 `on.schedule` 语法是 5 位 Unix cron** —— 和方案 A 一样，UTC 时间
- **方案 B 没有 KV** —— 数据写到 GitHub Pages 的静态文件，访问速度比方案 A 慢

### 验证方案 B

```bash
# 查看 workflow 运行状态
gh run list --workflow collect.yml --limit 5

# 手动触发
gh workflow run collect.yml
```

## 嵌入博客

两个方案都需要把 widget 嵌入博客。根据用户的博客框架选择对应的代码。

### fuwari（Astro）

新建 `src/components/Heatmap.astro`，内容参考仓库 README 的"嵌入博客"章节完整版。

在 `src/pages/[...page].astro` 里引用：
```astro
---
import Heatmap from "../components/Heatmap.astro";
---
{Astro.page.currentPage === 1 && <Heatmap class="mb-3 onload-animation" />}
```

### Hexo / Hugo / 其他框架

把精简版 HTML + JS 贴到首页模板。参考仓库 README 的"嵌入博客"章节精简版。

### 两个版本都要改的地方

1. `data-base` 和 `WIDGET_ORIGIN` 换成用户的 widget 域名
2. 外层 `<div>` 的样式换成用户博客的卡片样式
3. `PLACEHOLDER_HEIGHT` 保留 `130px`
4. 确保博客切主题时改的是 `<html>` 的 `class`（加 `dark`）和 `style`（写 `--hue`）

### 推送博客仓库

```bash
cd "<用户的博客仓库路径>"
git add .
git commit -m "添加 GitHub 活动热力图"
git push
```

## 验证部署成功

1. **Worker URL**：打开 `https://<worker-url>/api/heatmap?owner=<username>`，看有没有返回 JSON
2. **博客首页**：打开博客首页，看卡片有没有显示
3. **主题切换**：切博客明暗主题，看卡片颜色有没有跟着变
4. **数据更新**：等下一个 Cron 周期（或者手动触发），看数据有没有更新

## 易错点速查

| 现象 | 可能原因 | 解决方案 |
|---|---|---|
| 卡片显示空态 | `HEATMAP_OWNER` 填错 | 确认填的是 GitHub 用户名（小写） |
| 卡片显示 "unauthorized" | GitHub token 过期或权限不够 | 重新生成 token，确保有 `read:user` 权限 |
| 卡片在错误的时间刷新 | Cron 时间是 UTC | 改成用户期望的 UTC 时间 |
| 卡片在任何网站都能被嵌入 | `PARENT_ORIGIN` 没收紧 | 改成用户的博客域名 |
| 方案 B 数据不更新 | GitHub Actions 免费用户定时延迟 | 手动触发 workflow，或者升级到付费 |
| 方案 B 数据更新但博客不显示 | GitHub Pages 缓存 | 强制刷新浏览器 |
| 博客里卡片不显示 | 嵌入代码里的域名没换 | 确认 `data-base` 和 `WIDGET_ORIGIN` 换成了用户的 widget 域名 |
| 主题不同步 | 博客切主题时没有改 `<html>` 的 `class` 或 `--hue` | 确认博客的主题切换机制 |
| `wrangler deploy` 报错 "no such namespace" | KV namespace ID 填错 | 重新运行 `wrangler kv namespace create`，复制正确的 ID |
| `wrangler deploy` 报错 "invalid permissions key" | workflow 里 `permissions` 写了枚举外的键 | 检查 `permissions` 字段，只保留合法的键 |
| GitHub Actions workflow 不运行 | 免费用户定时延迟 | 手动触发 `gh workflow run`，或者检查 workflow 语法 |
