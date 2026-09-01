/**
 * Pi Web Test Worker — Cloudflare Browser Rendering proxy
 *
 * Provides headless browser capabilities via Cloudflare's Browser Rendering API.
 * Endpoints:
 *   POST /screenshot  — capture PNG screenshot of a URL
 *   POST /content     — extract text/HTML content from a page
 *   POST /a11y        — run accessibility audit (axe-core)
 *   POST /responsive  — capture screenshots at multiple viewports
 *   GET  /ping        — health check
 *
 * Auth: Every request must include an X-Api-Key header matching the API_KEY secret.
 */

import puppeteer from "@cloudflare/puppeteer";

interface Env {
	BROWSER: Fetcher;
	API_KEY: string;
}

const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSIVE_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;

// ── Helpers ──────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function errorResponse(message: string, status = 400): Response {
	return jsonResponse({ error: message }, status);
}

import { isBlockedHost, ipv4Parts, ipv6Parts, validatePublicUrl } from "../../lib/remote-url-safety.ts";

/**
 * Check DNS answers before handing a hostname to the browser. The browser
 * renderer resolves the hostname separately, so request validation remains
 * lexical as well; this lookup closes the common hostname-to-private-IP gap.
 */
async function validateResolvedHost(url: string): Promise<string | null> {
	const hostname = new URL(url).hostname.replace(/[\[\]]/g, "").replace(/\.$/, "");
	if (ipv4Parts(hostname) || ipv6Parts(hostname)) return null;
	try {
		const answers = await Promise.all(["A", "AAAA"].map(async (type) => {
			const query = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;
			const response = await fetch(query, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5_000) });
			if (!response.ok) throw new Error("DNS lookup failed");
			return await response.json() as { Answer?: Array<{ type?: number; data?: string }> };
		}));
		for (const answerSet of answers) {
			for (const answer of answerSet.Answer || []) {
				if (answer.data && (answer.type === 1 || answer.type === 28) && isBlockedHost(answer.data)) {
					return "The hostname resolves to a local or private network address";
				}
			}
		}
		return null;
	} catch {
		return "Unable to validate the hostname's DNS answers";
	}
}

async function validateTarget(url: unknown): Promise<string | null> {
	if (typeof url !== "string") return "Missing required field: url";
	const lexicalError = validatePublicUrl(url);
	return lexicalError || await validateResolvedHost(url);
}

async function parseBody(request: Request): Promise<Record<string, any> | null> {
	try {
		if (!request.body) return {};
		const reader = request.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > MAX_REQUEST_BODY_BYTES) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
		const raw = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			raw.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const parsed = JSON.parse(new TextDecoder().decode(raw));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

// ── Route Handlers ───────────────────────────────

function viewportDimension(value: unknown, fallback: number, min: number, max: number): number | null {
	const parsed = value === undefined ? fallback : Number(value);
	return Number.isFinite(parsed) && parsed >= min && parsed <= max ? Math.round(parsed) : null;
}

async function handleScreenshot(body: Record<string, any>, env: Env): Promise<Response> {
	const { url, width = 1280, height = 720, fullPage = false } = body;
	if (!url) return errorResponse("Missing required field: url");
	const viewportWidth = viewportDimension(width, 1280, 320, 3840);
	const viewportHeight = viewportDimension(height, 720, 240, 2160);
	if (viewportWidth === null || viewportHeight === null) return errorResponse("Viewport dimensions must be within 320–3840 x 240–2160");

	const urlError = await validateTarget(url);
	if (urlError) return errorResponse(urlError);

	const browser = await puppeteer.launch(env.BROWSER);
	try {
		const page = await browser.newPage();
		await page.setViewport({ width: viewportWidth, height: viewportHeight });
		await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });

		const screenshot = await page.screenshot({ fullPage: Boolean(fullPage) });
		if (screenshot.byteLength > MAX_SCREENSHOT_BYTES) return errorResponse("Screenshot is too large", 413);

		return new Response(screenshot, {
			headers: {
				"Content-Type": "image/png",
				"X-Page-Title": encodeURIComponent((await page.title()) || "untitled"),
			},
		});
	} finally {
		await browser.close();
	}
}

async function handleContent(body: Record<string, any>, env: Env): Promise<Response> {
	const { url, selector } = body;
	if (!url) return errorResponse("Missing required field: url");

	const urlError = await validateTarget(url);
	if (urlError) return errorResponse(urlError);

	const browser = await puppeteer.launch(env.BROWSER);
	try {
		const page = await browser.newPage();
		await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });

		const title = await page.title();

		let text: string;
		let html: string;

		if (selector) {
			const el = await page.$(selector);
			if (!el) {
				return jsonResponse({ title, text: "", html: "", error: `Selector "${selector}" not found` });
			}
			text = await el.evaluate((node: Element) => node.textContent || "");
			html = await el.evaluate((node: Element) => node.innerHTML);
		} else {
			text = await page.evaluate(() => document.body.innerText);
			html = await page.evaluate(() => document.body.innerHTML);
		}

		// Truncate large content
		const MAX_TEXT = 50000;
		const MAX_HTML = 100000;

		return jsonResponse({
			title,
			url,
			text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "\n...[truncated]" : text,
			html: html.length > MAX_HTML ? html.slice(0, MAX_HTML) + "\n...[truncated]" : html,
			textLength: text.length,
			htmlLength: html.length,
		});
	} finally {
		await browser.close();
	}
}

async function handleA11y(body: Record<string, any>, env: Env): Promise<Response> {
	const { url } = body;
	if (!url) return errorResponse("Missing required field: url");

	const urlError = await validateTarget(url);
	if (urlError) return errorResponse(urlError);

	const browser = await puppeteer.launch(env.BROWSER);
	try {
		const page = await browser.newPage();
		await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });

		const title = await page.title();

		// Inject axe-core for accessibility testing
		await page.addScriptTag({
			url: "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.9.1/axe.min.js",
		});

		// Wait for axe to be available with explicit timeout
		await page.waitForFunction("typeof window.axe !== 'undefined'", { timeout: 15000 });

		// Run axe audit
		const results = await page.evaluate(async () => {
			// @ts-ignore — axe is injected at runtime
			const axeResults = await window.axe.run();
			return {
				violations: axeResults.violations.map((v: any) => ({
					id: v.id,
					impact: v.impact,
					description: v.description,
					help: v.help,
					helpUrl: v.helpUrl,
					nodes: v.nodes.length,
				})),
				passes: axeResults.passes.length,
				incomplete: axeResults.incomplete.length,
				inapplicable: axeResults.inapplicable.length,
			};
		});

		return jsonResponse({
			title,
			url,
			...results,
			summary: {
				violations: results.violations.length,
				passes: results.passes,
				incomplete: results.incomplete,
				inapplicable: results.inapplicable,
			},
		});
	} finally {
		await browser.close();
	}
}

async function handleResponsive(body: Record<string, any>, env: Env): Promise<Response> {
	const { url, viewports } = body;
	if (!url) return errorResponse("Missing required field: url");

	const urlError = await validateTarget(url);
	if (urlError) return errorResponse(urlError);

	const defaultViewports = [
		{ name: "mobile", width: 375, height: 812 },
		{ name: "tablet", width: 768, height: 1024 },
		{ name: "desktop", width: 1440, height: 900 },
	];

	if (Array.isArray(viewports) && (viewports.length === 0 || viewports.length > 10)) return errorResponse("Viewports must contain between 1 and 10 entries");
	const vps = Array.isArray(viewports) ? viewports : defaultViewports;

		const browser = await puppeteer.launch(env.BROWSER);
	try {
		const page = await browser.newPage();
		const screenshots: Array<{ name: string; width: number; height: number; base64: string }> = [];
		let totalScreenshotBytes = 0;

		for (const vp of vps) {
			const w = viewportDimension(vp?.width, 1280, 320, 3840);
			const h = viewportDimension(vp?.height, 720, 240, 2160);
			if (w === null || h === null) return errorResponse("Viewport dimensions must be within 320–3840 x 240–2160");
			const name = typeof vp?.name === "string" ? vp.name.slice(0, 64) : `${w}x${h}`;

			await page.setViewport({ width: w, height: h });
			await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });

			const shot = await page.screenshot();
			if (shot.byteLength > MAX_SCREENSHOT_BYTES) return errorResponse("Screenshot is too large", 413);
			totalScreenshotBytes += shot.byteLength;
			if (totalScreenshotBytes > MAX_RESPONSIVE_BYTES) return errorResponse("Responsive screenshots are too large", 413);
			// Convert ArrayBuffer/Buffer to base64
			const bytes = new Uint8Array(shot as ArrayBuffer);
			let binary = "";
			for (let i = 0; i < bytes.length; i++) {
				binary += String.fromCharCode(bytes[i]);
			}
			const base64 = btoa(binary);

			screenshots.push({ name, width: w, height: h, base64 });
		}

		const title = await page.title();

		return jsonResponse({
			title,
			url,
			viewports: screenshots.map((s) => ({
				name: s.name,
				width: s.width,
				height: s.height,
				sizeBytes: s.base64.length,
			})),
			screenshots: screenshots.map((s) => ({
				name: s.name,
				base64: s.base64,
			})),
		});
	} finally {
		await browser.close();
	}
}

// ── Main Handler ─────────────────────────────────

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Health check — no auth needed
		if (url.pathname === "/ping") {
			return jsonResponse({ status: "ok", service: "pi-web-test" });
		}

		// Auth check
		const apiKey = request.headers.get("X-Api-Key");
		if (!env.API_KEY || apiKey !== env.API_KEY) {
			return errorResponse("Unauthorized", 401);
		}

		if (request.method !== "POST") {
			return errorResponse("Method not allowed. Use POST.", 405);
		}
		const contentLength = Number(request.headers.get("content-length") || 0);
		if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_REQUEST_BODY_BYTES) {
			return errorResponse("Request body too large", 413);
		}

		const body = await parseBody(request);
		if (body === null) return errorResponse("Request body too large", 413);

		try {
			switch (url.pathname) {
				case "/screenshot":
					return await handleScreenshot(body, env);
				case "/content":
					return await handleContent(body, env);
				case "/a11y":
					return await handleA11y(body, env);
				case "/responsive":
					return await handleResponsive(body, env);
				default:
					return errorResponse(`Unknown endpoint: ${url.pathname}. Available: /screenshot, /content, /a11y, /responsive, /ping`, 404);
			}
		} catch (err: any) {
			return errorResponse(`Browser error: ${err.message || String(err)}`, 500);
		}
	},
} satisfies ExportedHandler<Env>;
