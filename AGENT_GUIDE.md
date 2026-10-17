# gh-activity-worker 部署引导（给 AI Agent 看）

## 不用重复造轮子

- **模板仓库**：https://github.com/xieea656/gh-activity-worker
- Worker 代码、React 前端、采集脚本都已经写好，fork 后直接配置就能用
- **Agent 不需要写任何应用代码**

## Agent 的前置条件

- `gh` CLI（GitHub CLI）：fork 仓库、配置 secrets
- `wrangler` CLI（Cloudflare）：配置 Worker、KV、Cron（方案 2 需要）
- git：修改博客仓库
- shell 执行能力

## 你需要问用户的信息

**一次问完**以下信息（不要一个一个问）：

1. **GitHub 用户名**（小写，比如 `xieea656`）
2. **你想用哪个方案？**
   - 方案 1：GitHub Actions 定时（推荐，采集逻辑离线跑，不受 Cloudflare 限制）
   - 方案 2：Cloudflare Cron Trigger（数据生成在 Worker 内部，触发精确）
3. **你的博客框架**（fuwari / Hexo / Hugo / WordPress / 其他）
4. **你的博客仓库路径**（本地路径，比如 `~/coding/my-blog`）
5. **你的博客域名**（比如 `blog.example.com`）
6. **你的 Cloudflare API token**（两个方案都需要）
7. **你的 Cloudflare Account ID**（两个方案都需要）

### 引导用户获取 Cloudflare 凭证

**Cloudflare API token**（两个方案）：
1. 登录 Cloudflare Dashboard
2. 右上角头像 → "My Profile" → "API Tokens"
3. 点 "Create Token"
4. 选 "Edit Workers Scripts" 模板
5. 设置过期时间（建议 1 年）
6. 点 "Continue to summary" → "Save and Done"
7. 复制 token

**Cloudflare Account ID**：
1. 登录 Cloudflare Dashboard
2. 右上角头像 → "My Profile"
3. 页面底部有 "Account ID"，复制它

## 方案选择决策树

```
用户想用哪个方案？
├── 不知道 / 都可以 → 推荐方案 1
├── 想要效果好（采集逻辑不受限制） → 方案 1
├── 想要触发精确（分钟级） → 方案 2
└── 已经在用 GitHub Actions → 方案 1
```

### 方案 1：GitHub Actions 定时（推荐）

- **数据生成在 GitHub Actions runner 里**：`scripts/collect.mjs` 用 Actions 自带的 `GITHUB_TOKEN` 临时身份拉 GitHub API → `scripts/put-kv.mjs` 用 Cloudflare API 写 KV
- Cron 在 GitHub Actions schedule 里（`.github/workflows/collect.yml`）
- 部署也在 GitHub Actions 里（`.github/workflows/deploy.yml`）
- Worker 只负责读 KV 返回数据，不负责定时采集
- **优点**：采集逻辑离线跑，不受 Cloudflare 免费版请求数限制；GitHub Actions 自带 `GITHUB_TOKEN` 临时身份，**不需要申请 GitHub PAT**；GitHub Actions 免费额度够用（2000 分钟/月）
- **缺点**：**GitHub Actions 免费用户定时任务不保证执行时间**（官方说 "may delay execution"，实际有 24 小时以上的延迟报告）
- 需要：Cloudflare API token + Account ID + KV Namespace ID

### 方案 2：Cloudflare Cron Trigger

- **数据生成在 Cloudflare Worker 里**：Worker 的 `scheduled()` 入口直接用 `GITHUB_TOKEN` secret 拉 GitHub API，写 KV
- Cron 在 wrangler.jsonc 的 `crons` 里
- 不需要 GitHub Actions
- **优点**：触发时间精确（分钟级）；数据生成和 KV 写都在同平台
- **缺点**：Cloudflare 免费版单次调用上限是 50 个外部子请求 + 10ms CPU，采集逻辑受限
- 需要：Cloudflare API token + Account ID + **GitHub Personal Access Token**（配到 Cloudflare Worker Secrets 里）

### 方案 2 需要 GitHub PAT

如果用户选方案 2，引导他获取 GitHub Personal Access Token：
1. 打开 https://github.com/settings/tokens
2. 选择 "Classic"
3. 起一个名字，比如 `gh-activity-widget`
4. 勾选 `read:user`
5. 设置过期时间（建议 1 年）
6. 点 "Generate token"
7. **立刻复制 token**，页面刷新后看不到

## 方案 1：GitHub Actions 定时

### Agent 执行步骤

1. **Fork 仓库**
   ```bash
   gh repo fork xieea656/gh-activity-worker --clone
   ```

2. **修改 workflow 里的占位符**
   
   打开 `.github/workflows/deploy.yml`，替换：
   - `<YOUR_WIDGET_DOMAIN>` → 用户的 widget 域名（比如 `widgets.example.com`）
   - `<YOUR_WORKERS_DEV_SUBDOMAIN>` → 用户的 workers.dev 子域（从 Cloudflare 面板获取，可选）
   
   打开 `.github/workflows/collect.yml`，默认值已经改成 `${{ github.actor }}`，不需要改。

3. **创建 Cloudflare KV 命名空间**
   ```bash
   wrangler kv namespace create heatmap-kv
   ```
   输出类似：
   ```
   Successfully created namespace heatmap-kv
   Namespace ID: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
   **记下这个 ID**，下一步要用。

4. **配置 GitHub Actions secrets**
   ```bash
   gh secret set CLOUDFLARE_API_TOKEN --body "<用户的 Cloudflare token>"
   gh secret set CLOUDFLARE_ACCOUNT_ID --body "<用户的 Cloudflare Account ID>"
   gh secret set KV_NAMESPACE_ID --body "<刚才输出的 KV Namespace ID>"
   ```

5. **推送**
   ```bash
   git add .
   git commit -m "配置 GitHub Actions 定时采集"
   git push
   ```

6. **触发采集 workflow（手动验证）**
   ```bash
   gh workflow run collect.yml
   ```
   
   等 2-5 分钟，看 workflow 是否成功：
   ```bash
   gh run list --workflow collect.yml --limit 5
   ```

7. **触发部署 workflow（手动部署）**
   ```bash
   gh workflow run deploy.yml
   ```
   
   等 3-5 分钟，看部署是否成功。

### 方案 1 易错点

- **GitHub Actions 免费用户定时任务不保证执行时间** —— 官方说 "may delay execution"，实际有 24 小时以上的延迟报告
- **`user` 不是合法的 `permissions` 键** —— Actions 的 `permissions` 是固定枚举（actions / attestations / checks / contents / deployments / discussions / id-token / issues / pages / pull-requests / repository-projects / security-events / statuses），写一个枚举外的键整条 workflow 会在**校验阶段**就被拒，作业根本不会开始跑
- **`CLOUDFLARE_API_TOKEN` 需要 `Account Workers Scripts Edit` 和 `KV Storage Edit` 权限** —— 用 "Edit Workers Scripts" 模板创建的 token 默认有这些权限
- **KV Namespace ID 从 `wrangler kv namespace create` 的输出里复制** —— 不要从 Cloudflare 面板的 URL 里复制
- **workflow 里的 `${{ github.actor }}` 自动取当前用户名** —— 不需要手动改，除非用户想采集别人的数据
- **`deploy.yml` 里的域名断言** —— 如果用户的 widget 域名和 workflow 里写的不一致，部署会失败。确保 `<YOUR_WIDGET_DOMAIN>` 替换正确。

### 验证方案 1

```bash
gh run list --workflow collect.yml --limit 5
gh run list --workflow deploy.yml --limit 5
curl "https://<widget-domain>/api/heatmap?owner=<username>"
```

返回应该是 JSON 格式，包含 `window`、`calendar`、`commits` 等字段。

## 方案 2：Cloudflare Cron Trigger

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
   - `GITHUB_TOKEN` 是 secret，**不能**写进 `vars`，用步骤 6 配置
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

### 方案 2 易错点

- **Cron 时间是 UTC，不是本地时间** —— `17 3 * * *` 是 UTC 03:17，北京时间 11:17
- **`GITHUB_TOKEN` 是 secret，不是 variable** —— 写进 wrangler.jsonc 的 `vars` 里会报错
- **`HEATMAP_OWNER` 是 variable，不是 secret** —— 可以写进 wrangler.jsonc 的 `vars`
- **KV 绑定名 `HEATMAP_KV` 不能改** —— 代码里写死了这个绑定名
- **`PARENT_ORIGIN` 要收紧成用户自己的博客域名** —— 否则任何站点都能嵌入这个 widget
- **`wrangler.jsonc` 是 JSONC 格式** —— 支持注释，修改时保留注释格式
- **Cloudflare 免费版单次调用上限是 50 个外部子请求 + 10ms CPU** —— 采集逻辑受限，如果用户的仓库很多（>20），采集可能超时

### 验证方案 2

```bash
curl "https://<widget-domain>/api/heatmap?owner=<username>"
```

返回应该是 JSON 格式，包含 `window`、`calendar`、`commits` 等字段。

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

1. **Worker URL**：打开 `https://<widget-domain>/api/heatmap?owner=<username>`，看有没有返回 JSON
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
| 方案 1 数据不更新 | GitHub Actions 免费用户定时延迟 | 手动触发 `gh workflow run collect.yml` |
| 方案 1 部署失败 | `deploy.yml` 里的域名断言失败 | 确保 `<YOUR_WIDGET_DOMAIN>` 替换成用户的实际 widget 域名 |
| 方案 2 部署失败 | KV Namespace ID 填错 | 重新运行 `wrangler kv namespace create`，复制正确的 ID |
| 方案 2 采集失败 | Cloudflare 免费版单次调用限制 | 减少仓库数量，或者选方案 1 |
| 博客里卡片不显示 | 嵌入代码里的域名没换 | 确认 `data-base` 和 `WIDGET_ORIGIN` 换成了用户的 widget 域名 |
| 主题不同步 | 博客切主题时没有改 `<html>` 的 `class` 或 `--hue` | 确认博客的主题切换机制 |
