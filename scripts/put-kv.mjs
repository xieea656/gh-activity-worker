#!/usr/bin/env node
/**
 * 把采集产物写进 Cloudflare KV（走 REST API，不依赖 wrangler）。
 *
 * 端点：PUT https://api.cloudflare.com/client/v4/accounts/{account}/storage/kv/
 *        namespaces/{namespace}/values/{key}
 * key 由 shared/schema2.ts 的 kvKey(owner) 生成 —— 采集端与 Worker 必须用同一个函数。
 *
 * 凭证只从环境变量读，只写进请求头：
 *   CLOUDFLARE_API_TOKEN    必需（权限：Account Workers Scripts Edit + KV Storage Edit）
 *   CLOUDFLARE_ACCOUNT_ID   必需
 *   KV_NAMESPACE_ID         必需
 * 绝不出现在命令行参数、日志、报错信息或产物里。
 *
 * 用法（需要 Node 22.6+，--experimental-strip-types 用来 import 合约做写入前校验）：
 *   node --experimental-strip-types scripts/put-kv.mjs < payload.json      # 从 stdin 读
 *   node --experimental-strip-types scripts/put-kv.mjs --file payload.json # 从文件读
 *   node --experimental-strip-types scripts/put-kv.mjs --file p.json --dry-run
 *
 * --dry-run：只打印将写的 key 与字节数，不实际写入（也不检查凭证是否齐全，方便本地演练）。
 * 写坏数据前会先用 parseHeatmapPayload 过一遍：宁可失败，也别让半截结构进 KV。
 */
import { readFile } from "node:fs/promises";
import { WINDOW_DAYS, kvKey, parseHeatmapPayload } from "../shared/schema2.ts";

const ARGV = process.argv.slice(2);
const FLAG = (name) => ARGV.includes(name);
const ARG = (name) => {
	const i = ARGV.indexOf(name);
	return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : undefined;
};

const DRY_RUN = FLAG("--dry-run");
const FILE = ARG("--file");

// ---------- 凭证（只读，永不回显）----------
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const NAMESPACE_ID = process.env.KV_NAMESPACE_ID ?? "";

/** 任何日志/报错都要过这一关：抹掉凭证字面量与常见的 secret 形态 */
function redact(text) {
	let out = String(text ?? "");
	for (const secret of [API_TOKEN, ACCOUNT_ID, NAMESPACE_ID]) {
		if (secret) out = out.split(secret).join("[redacted]");
	}
	return out
		.replace(/(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|cfpat_|sk_live_|sk_test_|xox[bap]-)[A-Za-z0-9_\-]{10,}/g, "$1[redacted]")
		.replace(/\bBearer\s+[A-Za-z0-9._\-]{16,}/gi, "Bearer [redacted]")
		.replace(/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9._\-]{10,}/g, "[redacted-jwt]");
}

// ---------- 读入 payload ----------
async function readPayload() {
	if (FILE) return readFile(FILE, "utf8");
	if (process.stdin.isTTY) {
		console.error("用法：node scripts/put-kv.mjs [--file <path>] [--dry-run] < payload.json");
		process.exit(2);
	}
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

const log = (message) => console.error(redact(message));

try {
	const raw = (await readPayload()).trim();
	if (!raw) {
		log("输入为空，退出（不会写入 KV）");
		process.exit(1);
	}

	let payload;
	try {
		payload = JSON.parse(raw);
	} catch (error) {
		log(`JSON 解析失败，退出（不会写入 KV）：${error.message}`);
		process.exit(1);
	}

	// 写入前用合约校验。parseHeatmapPayload 不检查 window.days，这里补一刀，
	// 避免旧结构（schema1 没有 days 字段）混进 KV 却通过了校验。
	const checked = parseHeatmapPayload(payload);
	if (!checked.ok) {
		log(`载荷未通过合约校验，退出（不会写入 KV）：${checked.errors.join("；")}`);
		process.exit(1);
	}
	if (!Number.isInteger(payload.window?.days) || payload.window.days !== WINDOW_DAYS) {
		log(`window.days 期望 ${WINDOW_DAYS}，实际 ${String(payload.window?.days)}，退出（不会写入 KV）`);
		process.exit(1);
	}

	const key = kvKey(payload.owner);
	const body = JSON.stringify(payload);
	const bytes = Buffer.byteLength(body, "utf8");

	log(`KV key=${key}`);
	log(`字节数=${bytes}  schema=${payload.schema}  window=${payload.window.from}..${payload.window.to}（${payload.window.days} 天）`);
	log(
		`内容摘要：calendar.available=${payload.calendar?.available} commits.total=${payload.commits?.total} repos=${payload.commits?.repos?.length ?? 0} warnings=${payload.warnings?.length ?? 0}`,
	);

	if (DRY_RUN) {
		log(`--dry-run：不实际写入。凭证状态：${API_TOKEN ? "token=已配置" : "token=缺失"} / ${ACCOUNT_ID ? "account=已配置" : "account=缺失"} / ${NAMESPACE_ID ? "namespace=已配置" : "namespace=缺失"}`);
		log(`  真正写入时会请求 PUT .../storage/kv/namespaces/{ns}/values/${encodeURIComponent(key)}`);
		process.exit(0);
	}

	const missing = [];
	if (!API_TOKEN) missing.push("CLOUDFLARE_API_TOKEN");
	if (!ACCOUNT_ID) missing.push("CLOUDFLARE_ACCOUNT_ID");
	if (!NAMESPACE_ID) missing.push("KV_NAMESPACE_ID");
	if (missing.length) {
		log(`缺少环境变量：${missing.join(", ")}。退出（不会写入 KV）`);
		process.exit(1);
	}

	const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ACCOUNT_ID)}/storage/kv/namespaces/${encodeURIComponent(NAMESPACE_ID)}/values`;
	const headers = { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json;charset=UTF-8" };

	// ---------- 单调性守卫：不许用「更差」的产物覆盖「更好」的已有产物 ----------
	//
	// 为什么必须有这道：CI 的 github.token 通常没有 read:user，贡献墙那一路会走降级分支，
	// collect 依然**退出 0** 并产出一份 calendar.available=false 的载荷。采集脚本、合约校验、
	// check-contract --payload 全都会放行它，于是 workflow 用一份「只有仓库提交」的数据
	// 覆盖掉生产里那份完整的贡献墙 —— 界面当场少一块，而没有任何一步报错。
	//
	// 规则很窄：只有当「已有=有贡献墙、新产物=没有贡献墙」时才拒绝。
	//   - 已有 KV 为空（首次写入）→ 放行，否则降级产物永远写不进去；
	//   - 两边都降级、或从降级恢复到完整 → 都放行，不阻碍正常刷新；
	//   - --force 可绕过（人工恢复、或明确知道自己在拿降级数据换）。
	if (!FLAG("--force")) {
		let existing = null;
		try {
			const cur = await fetch(`${base}/${encodeURIComponent(key)}`, { headers: { authorization: `Bearer ${API_TOKEN}` } });
			if (cur.ok) {
				const j = JSON.parse((await cur.text()) ?? "{}");
				existing = parseHeatmapPayload(j).ok ? j : null;
			}
		} catch {
			// 读不到现状就当不存在处理，不因为这个卡住写入。
			existing = null;
		}
		if (existing && existing.calendar?.available === true && payload.calendar?.available !== true) {
			log(`拒绝写入：KV 里已有贡献墙可用（total=${existing.calendar.total}），新产物标记为 unavailable —— 这通常是采集端拿不到贡献墙权限的降级结果。`);
			log(`  覆盖它等于用缺数据的产物换掉好数据，已拦下。如需强行覆盖请显式加 --force。`);
			process.exit(1);
		}
	}

	const url = new URL(`${base}/${encodeURIComponent(key)}`);

	let res;
	try {
		res = await fetch(url, {
			method: "PUT",
			headers: {
				authorization: `Bearer ${API_TOKEN}`,
				"content-type": "application/json;charset=UTF-8",
			},
			body,
		});
	} catch (error) {
		log(`请求 Cloudflare 失败：${error?.message ?? error}`);
		process.exit(1);
	}

	const text = (await res.text()).slice(0, 2000);
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = null;
	}
	const detail = parsed ? `${parsed.success === false ? "失败" : "返回"}：${parsed.errors?.map((e) => e.message).join("；") || parsed.message || text.slice(0, 300)}` : text.slice(0, 300);

	if (!res.ok) {
		log(`写入失败（HTTP ${res.status}）：${detail}`);
		process.exit(1);
	}
	log(`已写入 KV：key=${key}（HTTP ${res.status}）`);
} catch (error) {
	log(`未预期的失败：${error?.stack ?? error?.message ?? error}`);
	process.exit(1);
}
