/**
 * 猎聘招聘者端 (LPT) 工具函数
 */

import { Page } from 'puppeteer-core';
import { sleep, AuthExpiredError, RELOGIN_HINT, isAuthExpiredResponse } from './utils.js';
import { randomUUID } from 'crypto';

export const LIEPIN_LPT_API = 'https://api-lpt.liepin.com';

/**
 * 触发猎聘风控（验证码 / 频率限制 / 反爬虫挑战）时抛出。
 * 上层遇到此错误应立即停止重试，等待或让用户在浏览器中手动完成验证，
 * 连续换方案试探只会加重风控。
 */
export class RiskControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskControlError';
  }
}

const RISK_CONTROL_PATTERN = /验证码|安全验证|请完成验证|操作(过于)?频繁|访问异常|存在风险|风控/;

export { AuthExpiredError, RELOGIN_HINT, isAuthExpiredResponse } from './utils.js';

/**
 * 猎聘安全中心的拦截页：账号被判「行为异常」后，页面导航会被 302 到
 * `safe.liepin.com/page/liepin/captchaPage_PC?...&backurl=<原地址>`，要人工点图形验证。
 * 实测（2026-09-16）：此时 jobmanage.list 等接口仍 flag=1，但 resume-view 之类业务接口
 * 只回 `{"flag":0}`——所以「login 成功」不等于「业务可用」（issue #21 问题三）。
 */
const RISK_PAGE_URL_PATTERN = /safe\.liepin\.com|captchaPage/i;

export function isRiskPageUrl(url: string): boolean {
  return RISK_PAGE_URL_PATTERN.test(url);
}

export const RISK_PAGE_HINT =
  '猎聘安全中心已把账号判为「行为异常」，业务接口会被静默拦截。' +
  '请勿重试：运行 `liepin login`，在弹出的浏览器窗口里完成图形验证后再继续。';

const PAGE_BLANKED_HINT =
  '猎聘安全脚本可能主动清空了页面。' +
  '请直接重跑命令；若反复复现，`liepin quit` 后重跑，' +
  '或在 CLI 拉起的浏览器窗口里手动打开 lpt.liepin.com 完成一次安全验证。';

/** 能 send CDP 命令的最小会话契约（puppeteer 主会话或 mock） */
interface CdpMinimalClient {
  send(method: string): Promise<unknown>;
}

/**
 * 取 puppeteer 页面主会话。走 CdpFrame 的 client getter，是公开访问器；
 * 拿不到（mock page、未来 puppeteer 结构变化）返回 null，调用方退化为普通行为。
 */
function mainSessionClient(page: Page): CdpMinimalClient | null {
  try {
    const frame = page.mainFrame() as unknown as { client?: CdpMinimalClient };
    const client = frame?.client;
    return client && typeof client.send === 'function' ? client : null;
  } catch {
    return null;
  }
}

/** 步骤日志开关(排障用):LIEPIN_DEBUG_STEPS=true 时向 stderr 输出各步骤耗时,后端日志可捕获 */
const DEBUG_STEPS = process.env.LIEPIN_DEBUG_STEPS === 'true';

/** 打印排障步骤日志(仅在 LIEPIN_DEBUG_STEPS=true 时生效) */
export function stepLog(message: string): void {
  if (DEBUG_STEPS) console.error(`[liepin-step] ${message}`);
}

/**
 * 给任意 Promise 包一层超时。
 *
 * CDP 协议调用(puppeteer 默认协议超时很长)与页面内 fetch/evaluate 均不会自行限时,
 * 目标页无响应(如被弹窗/冻结阻塞)时会静默挂满超时上限(2026-09-26 实测:后端
 * chatlist 两次耗尽 3 分钟命令超时被强杀且无任何输出)。凡可能挂起的调用一律套此函数,
 * 快速失败并给出可诊断的错误。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms): 页面/CDP 无响应`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 后台页签安全的 waitForSelector。
 *
 * puppeteer 的 waitForSelector 默认用 rAF 轮询，而 Chrome 会挂起不可见页签的
 * requestAnimationFrame：用户打开任意其他页签后，等待永不完成，直到底层 CDP
 * 调用挂满 60s 协议超时（2026-09-27 实测：greet 全链路报 Runtime.callFunctionOn
 * timed out，候选人只收到预设招呼语、收不到自定义话术）。Runtime.evaluate 不受
 * 渲染帧影响，这里改为 Node 侧定时 + 单次 evaluate 查询。
 */
export async function waitForSelectorSafe(
  page: Page,
  selector: string,
  opts: { timeout?: number; intervalMs?: number } = {},
): Promise<void> {
  const { timeout = 15_000, intervalMs = 250 } = opts;
  const startedAt = Date.now();
  let lastError: string | null = null;
  while (Date.now() - startedAt < timeout) {
    try {
      const found = await withTimeout(
        page.evaluate((sel: string) => Boolean(document.querySelector(sel)), selector),
        5_000,
        '等待元素 evaluate',
      );
      if (found) {
        stepLog(`waitForSelectorSafe 命中 ${selector}（用时 ${Date.now() - startedAt}ms）`);
        return;
      }
    } catch (e: any) {
      lastError = String(e?.message || e);
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `等待元素超时（${timeout}ms）: ${selector}` + (lastError ? `；最后一次查询错误: ${lastError}` : ''),
  );
}

/**
 * 后台页签安全的点击。
 *
 * puppeteer 的 page.click 依赖页面内 IntersectionObserver
 * （scrollIntoViewIfNeeded → isIntersectingViewport），不可见页签下回调同样
 * 永不触发、挂满协议超时。改为 evaluate 内 scrollIntoView + el.click()：
 * 布局同步计算、事件同步派发，与页签可见性无关。元素 disabled 时点击无效果，
 * 调用方应先用 waitForSelectorSafe 等就绪。
 */
export async function clickSafe(page: Page, selector: string): Promise<void> {
  const clicked = await withTimeout(
    page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.click();
      return true;
    }, selector),
    10_000,
    '点击 evaluate',
  );
  if (!clicked) {
    throw new Error(`点击失败：页面中不存在元素 ${selector}`);
  }
  stepLog(`clickSafe 已点击 ${selector}`);
}

/**
 * 在 puppeteer 主会话上开关 Runtime 域。开关是按会话生效的，
 * 断开连接后自然消失，不会给浏览器留下残留状态。
 */
export async function setPageRuntime(page: Page, enabled: boolean): Promise<void> {
  try {
    const client = mainSessionClient(page);
    if (!client) return;
    await withTimeout(client.send(enabled ? 'Runtime.enable' : 'Runtime.disable'), 10_000, '切换 Runtime 域');
  } catch {
    /* 主会话不可用/无响应时静默跳过，退化为普通导航 */
  }
}

/**
 * 规避猎聘「加载期 CDP 检测」的导航。
 *
 * 实测（2026-08-19，Chrome 151）：猎聘安全脚本只在页面加载瞬间检查该页签的
 * CDP 会话是否启用着 Runtime 域，启用则把页面清成 about:blank——这就是
 * issue #17 的根因（自管浏览器实例同样 100% 复现，与挂没挂日常浏览器无关）。
 * 而加载完成后再 Runtime.enable / evaluate 完全不触发。
 * 所以 goto 前先 Runtime.disable，加载完成后立刻 enable 回来。
 */
export async function safeGoto(page: Page, url: string): Promise<void> {
  const startedAt = Date.now();
  await setPageRuntime(page, false);
  try {
    // 显式 30s 导航超时:puppeteer 默认导航超时为 30s,这里写死保证语义不随版本/全局设置漂移
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
  } finally {
    await setPageRuntime(page, true);
  }
  stepLog(`goto ${url} 用时 ${Date.now() - startedAt}ms`);
}

/**
 * 页面被猎聘安全脚本清空（跳到 about:blank）后，任何"已拿到的数据"都不可信、
 * 后续请求也必然失败，必须立即以可判别的异常终止（见 issue #17）。
 */
export function assertPageNotBlanked(page: Page, when: string): void {
  const url = page.url();
  if (url === 'about:blank' || url.startsWith('chrome-error://')) {
    throw new RiskControlError(`${when}时页面已被清空（当前 ${url}）。${PAGE_BLANKED_HINT}`);
  }
}

/**
 * 除「页面被清空」外，还把「被 302 到安全中心验证页」视为不可继续：此时所有 LPT 接口
 * 都是跨域 fetch，必然失败，继续等只会白等（issue #21 问题四）。
 * `login` 例外——那里人就该停在验证页上过滑块，所以它只用 assertPageNotBlanked。
 */
export function assertLptPageAlive(page: Page, when: string): void {
  assertPageNotBlanked(page, when);
  if (isRiskPageUrl(page.url())) {
    throw new RiskControlError(`${when}时页面被跳转到猎聘安全验证页（当前 ${page.url()}）。${RISK_PAGE_HINT}`);
  }
}

/** evaluate 执行中页面被导航走时，puppeteer 抛的是上下文销毁类错误 */
const CONTEXT_DESTROYED_PATTERN = /Execution context was destroyed|Cannot find context|Target closed|Session closed/i;

/** LPT API 请求 */
export async function lptFetch(page: Page, url: string, opts: { body?: string; clientId?: string } = {}): Promise<any> {
  const { body = null, clientId = '40156' } = opts;
  const traceId = randomUUID();

  assertLptPageAlive(page, '发起请求');

  let result: any;
  const startedAt = Date.now();
  try {
    // 页面内 fetch 无超时保护:目标页无响应时会永久挂起,统一 30s 快速失败
    result = await withTimeout(page.evaluate(async (fetchUrl: string, fetchBody: string | null, fetchClientId: string, fetchTraceId: string) => {
    try {
      const xsrf = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('XSRF-TOKEN='));
      const token = xsrf ? xsrf.split('=').slice(1).join('') : '';
      
      const headers: Record<string, string> = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-client-type': 'web',
        'x-requested-with': 'XMLHttpRequest',
        'x-xsrf-token': token,
        'x-fscp-version': '1.1',
        'x-fscp-std-info': `{"client_id": "${fetchClientId}"}`,
        'x-fscp-fe-version': '',
        'x-fscp-trace-id': fetchTraceId,
        'x-fscp-bi-stat': JSON.stringify({ location: window.location.href }),
      };

      const resp = await fetch(fetchUrl, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: fetchBody,
      });
      
      const text = await resp.text();
      return { ok: resp.ok, status: resp.status, text };
    } catch (e: any) {
      return { ok: false, status: 0, text: '', error: String(e?.message || e) };
    }
  }, url, body, clientId, traceId), 30_000, 'lptFetch 页内请求');
  } catch (e: any) {
    if (CONTEXT_DESTROYED_PATTERN.test(String(e?.message || e))) {
      assertLptPageAlive(page, '请求执行');
      throw new RiskControlError(`请求执行中页面发生了导航（${String(e?.message || e)}）。${PAGE_BLANKED_HINT}`);
    }
    throw e;
  }
  stepLog(`lptFetch ${url} 页内请求用时 ${Date.now() - startedAt}ms`);

  // 数据回来了但页面随即被清空：不能当成功返回，否则错误会被推迟到下一条命令（issue #17）
  assertLptPageAlive(page, '请求完成');

  const res = result as any;

  if (res.error) {
    throw new Error(`LPT 请求失败: ${res.error}`);
  }
  // 401/403 基本就是登录态没了，直接给重登指引，别让调用方去猜（须先于通用 !ok 分支）
  if (res.status === 401 || res.status === 403) {
    throw new AuthExpiredError(`猎聘登录态已失效（HTTP ${res.status}）。${RELOGIN_HINT}`);
  }
  if (!res.ok) {
    throw new Error(`LPT HTTP 错误: ${res.status}`);
  }
  if (res.text.trim().startsWith('<')) {
    throw new RiskControlError('LPT 返回了 HTML（可能是反爬虫挑战），请在浏览器中重新登录或完成验证后再试');
  }

  let data: any;
  try {
    data = JSON.parse(res.text);
  } catch (e) {
    throw new Error(`LPT JSON 解析失败: ${res.text.slice(0, 200)}`);
  }

  if (data?.flag !== 1) {
    const msg = String(data?.msg || data?.message || '');
    if (RISK_CONTROL_PATTERN.test(msg)) {
      throw new RiskControlError(`触发猎聘风控：${msg}。请停止自动化操作，在浏览器中手动完成验证后再继续`);
    }
    // -1401 / -1701 等登录态失效码：重试无意义，直接指引重登
    if (isAuthExpiredResponse(data)) {
      throw new AuthExpiredError(
        `猎聘登录态已失效（flag=${data?.flag}${msg ? `，${msg}` : ''}）。${RELOGIN_HINT}`,
      );
    }
    // 光秃秃的 {"flag":0}（无 msg 无 data）是风控拦业务接口的形态，不是简历权益/权限问题；
    // 当成一般错误会把使用者带去查「简历点余额」并反复重试，反而加重风控（issue #21 问题三）
    if (data?.flag === 0 && !msg && (data.data === undefined || data.data === null)) {
      throw new RiskControlError(
        `接口只返回了 {"flag":0}（无任何说明），这是猎聘风控拦截业务接口的典型形态。${RISK_PAGE_HINT}`,
      );
    }
  }

  return data;
}

/** 导航到 LPT 页面 */
export async function navigateToLpt(page: Page, path: string = '/recommend', waitSeconds: number = 3): Promise<void> {
  const url = `https://lpt.liepin.com${path}`;
  await safeGoto(page, url);
  await sleep(waitSeconds * 1000);
  assertLptPageAlive(page, '导航');
}

/** 读取 imId */
export async function readLptImId(page: Page): Promise<string> {
  const result = await withTimeout(page.evaluate(() => {
    // Try cookie first
    const m = document.cookie.match(/imId_2=([^;]+)/i);
    if (m) return m[1];
    
    // Try localStorage
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.toLowerCase().includes('imid')) {
          const v = localStorage.getItem(k);
          if (v) return v;
        }
        const v = localStorage.getItem(k) || '';
        if (v.includes('imId')) {
          const m2 = v.match(/"imId":"([^"]+)"/);
          if (m2) return m2[1];
        }
      }
    } catch (_) {}
    return '';
  }), 30_000, 'readLptImId');

  return result || '';
}

export interface LptResumeInfo {
  resumeId: string;
  usercId: string;
  imId: string;
  name: string;
}

/** 用 resume_id 换候选人的 usercId / imId / 姓名（resume-view 接口） */
export async function getResumeInfo(page: Page, resumeId: string): Promise<LptResumeInfo> {
  const form = new URLSearchParams();
  form.set('pageParamVo', JSON.stringify({
    resIdEncode: resumeId,
    sfrom: 'R_SEARCH_CONDITION',
    applyId: '',
  }));

  const data = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.rresume.usere.pc.resume-view`, {
    body: form.toString(),
  });

  if (data.flag !== 1) {
    throw new Error(`获取简历失败: ${data.msg || data.message || JSON.stringify(data).slice(0, 200)}`);
  }

  const vo = data.data?.resumeDetailVo;
  if (!vo?.encodeUsercId) {
    throw new Error('获取简历失败: 响应缺少 encodeUsercId');
  }

  return {
    resumeId,
    usercId: String(vo.encodeUsercId),
    imId: String(vo.imId || ''),
    name: vo.baseInfo?.name || '',
  };
}

/** 打开简历详情页并展开右侧 IM 聊天面板（输入框出现即就绪） */
export async function openResumeImPanel(page: Page, resumeId: string): Promise<void> {
  await safeGoto(page, `https://lpt.liepin.com/resume/detail?resIdEncode=${encodeURIComponent(resumeId)}&sfrom=R_SEARCH_CONDITION`);
  assertLptPageAlive(page, '打开简历详情');
  // 等元素/点击一律走 *Safe 版本：puppeteer 原生 waitForSelector/click 依赖页签
  // 渲染帧，自动化页签在后台时会挂满 60s 协议超时（2026-09-27 事故）
  await waitForSelectorSafe(page, '.xpath-open-im-btn', { timeout: 20000 });
  await clickSafe(page, '.xpath-open-im-btn');
  await waitForSelectorSafe(page, '.im-ui-textarea', { timeout: 20000 });
}
