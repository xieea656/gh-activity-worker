import { handleHeatmap, emptyPayload, respond, computeWindow } from "./heatmap.ts";
import { collect } from "./collect.ts";

/**
 * 一个 Worker 三个入口：
 *   1) GET /api/heatmap → 读 KV 返回热力图 JSON（KV 空/坏时发 1 个 GraphQL 请求兜底）
 *   2) scheduled        → Cron Trigger 每天一次，重新取数写 KV
 *   3) 其余请求         → 直接交给 Workers Static Assets，Worker 不参与、不消耗配额
 */
export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/api/heatmap") {
			try {
				return await handleHeatmap(request, env);
			} catch (error) {
				// 理论上不可达：handleHeatmap 内部已捕获所有已知失败路径。
				// 再兜一层，保证任何情况下返回 200 而不是 500 ——
				// 这个接口挂在博客首页 iframe 里，500 会变成整块空白。
				console.error(`handleHeatmap 未预期异常：${error instanceof Error ? error.stack : String(error)}`);
				return respond(
					emptyPayload(
						(env.HEATMAP_OWNER ?? "unknown").toLowerCase(),
						computeWindow(),
						"内部异常，已降级为不可用响应",
					),
				);
			}
		}

		if (url.pathname.startsWith("/api/")) {
			return new Response(JSON.stringify({ error: "not found" }), {
				status: 404,
				headers: { "content-type": "application/json; charset=utf-8" },
			});
		}

		return new Response(null, { status: 404 });
	},

	/**
	 * 定时采集。用 waitUntil 而不是 await：采集失败不该把这次调度记成失败调用，
	 * 而且页面读数据走的是另一个 fetch 请求，两者互不阻塞。
	 */
	async scheduled(controller, env) {
		controller.waitUntil(
			collect(env).then((result) => {
				if (result.ok) {
					console.log(
						`[collect] owner=${result.owner} 贡献墙 ${result.calendarDays} 天有活动 / ` +
							`提交 ${result.commitTotal} 次 / ${result.repos} 个仓库 / 共 ${result.calls} 个请求 → 已写入 KV`,
					);
				} else {
					console.warn(`[collect] 未写入 KV：${result.error}`);
				}
			}),
		);
	},
} satisfies ExportedHandler<Env>;
