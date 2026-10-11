import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// 组件里的 Roboto 是硬编码字族，iframe 是独立文档、拿不到博客的字体，所以自带。
// 只引这三档，其余字重按 CSS 栈回落到系统字体。
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'

import './index.css'
import App from './App.tsx'
import { handleParentMessage, initTheme, postHeight } from './lib/theme.ts'

/* ------------------------------------------------------------------ */
/* 首屏主题：只从 URL 参数取，不等 postMessage，避免"先亮后暗"闪一下       */
/* ------------------------------------------------------------------ */
initTheme(window.location.search, { dev: import.meta.env.DEV })

/* ------------------------------------------------------------------ */
/* iframe ↔ 博客 入站：{ type:"hm-theme", dark, hue }                   */
/* origin 白名单校验在 handleParentMessage 里做                          */
/* ------------------------------------------------------------------ */
window.addEventListener('message', handleParentMessage)

/* ------------------------------------------------------------------ */
/* iframe ↔ 博客 出站：{ type:"hm-height", height }                     */
/* ResizeObserver + 100ms 去抖；面板 layout 动画有中间态，所以连续上报，  */
/* 最终值稳定不抖                                                        */
/* ------------------------------------------------------------------ */
const HEIGHT_DEBOUNCE_MS = 100

const reportHeight = (): void => {
	postHeight(document.body.getBoundingClientRect().height)
}

let heightTimer: number | undefined
const scheduleHeightReport = (): void => {
	window.clearTimeout(heightTimer)
	heightTimer = window.setTimeout(reportHeight, HEIGHT_DEBOUNCE_MS)
}

const resizeObserver = new ResizeObserver(scheduleHeightReport)
resizeObserver.observe(document.body)

// 首屏先报一次，不等 ResizeObserver 的首帧回调
reportHeight()
// 字体晚到会把行高撑大一点，等字体就绪后再报一次
if (document.fonts?.ready) {
	void document.fonts.ready.then(reportHeight).catch(() => {})
}
window.addEventListener('load', reportHeight)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
