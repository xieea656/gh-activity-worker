#!/usr/bin/env node
/**
 * 由 PARENT_ORIGIN 生成 public/_headers。
 *
 * PARENT_ORIGIN 是"允许嵌这个卡片的博客地址"，形如 https://blog.example.com。
 * 它同时管两件相关的事：
 *   1) 这里的 frame-ancestors —— 谁能把卡片嵌进 iframe（本站唯一的安全边界）
 *   2) 前端 src/lib/theme.ts 里的 postMessage 白名单（构建时注入同一个值）
 *
 * 留空 = frame-ancestors *，谁都能嵌。想收紧就把自己的博客地址填上。
 *
 * 用法：
 *   PARENT_ORIGIN="https://blog.example.com" node scripts/gen-headers.mjs
 * npm run build 会自动先跑这一步。
 */
import { writeFile } from "node:fs/promises";

const raw = (process.env.PARENT_ORIGIN ?? "").trim().replace(/\/+$/, "");
const LOOKS_LIKE_ORIGIN = /^https:\/\/[a-z0-9][a-z0-9.-]*(:\d{1,5})?$/i;
const origin = LOOKS_LIKE_ORIGIN.test(raw) ? raw : "";

if (raw && !origin) {
	// 只告警不失败：构建不该因为一个可选变量挂掉
	console.error(`PARENT_ORIGIN 格式不对（应为 https://blog.example.com），按未配置处理：${raw}`);
}

const frameAncestors = origin || "*";
const body = `# Workers 静态资源响应头。
# 这个文件由 scripts/gen-headers.mjs 生成，别手改 —— 改 PARENT_ORIGIN 环境变量。
# 只作用于「由资源系统直接返回」的响应（展示站的 HTML/JS/CSS）；
# /api/* 由 Worker 代码自己设头（run_worker_first 只接管 /api/*），两者互不干扰。
# 依据 https://developers.cloudflare.com/workers/configuration/static-assets/headers/

/*
  # 只有配进去的源能把我嵌进去。这是 iframe 方案的唯一访问控制面。
  # frame-ancestors * 表示任何站点都能嵌 —— 能用就尽量收紧成你自己的博客地址。
  Content-Security-Policy: frame-ancestors ${frameAncestors}
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  # 小部件不是内容页，别进索引
  X-Robots-Tag: noindex, nofollow

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;

await writeFile(new URL("../public/_headers", import.meta.url), body, "utf8");
console.log(`public/_headers 已生成：Content-Security-Policy: frame-ancestors ${frameAncestors}`);
