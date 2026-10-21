/**
 * dsh-whale-memory — browser half.
 *
 * 在「会话标题栏右侧动作区」(`conversation.session.header.actions`) 放一个
 * 「鲸鲸记忆」开关：开=本会话带鲸鲸记忆说话并维护备份；关=纯干活。
 * 状态读写都走宿主半的 /whale-memory/api/*（同源 loopback）。
 *
 * 这是手写的 loader bundle：由 window.__ModuleLoader__ 注册为普通 Cordis 插件，
 * require 由加载器提供（React 等共享依赖）。
 */

window.__ModuleLoader__.load({
	id: "dsh-whale-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		const SLOT = "conversation.session.header.actions";
		const API = "/whale-memory/api";

		const CSS = `
			.dswm-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;min-height:28px;
				padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.14));
				background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f99);
				font:inherit;font-size:12px;line-height:18px;cursor:pointer;user-select:none;
				transition:color .15s ease,border-color .15s ease,background .15s ease}
			.dswm-pill:hover:not(:disabled){color:var(--dsw-alias-label-secondary,#5f6670);
				border-color:var(--dsw-alias-border-secondary,rgba(0,0,0,.24))}
			.dswm-pill:focus-visible{outline:2px solid var(--dsw-alias-accent-primary,#4c8bf5);outline-offset:2px}
			.dswm-pill:disabled{opacity:.55;cursor:default}
			.dswm-pill[data-on="1"]{color:#1d6fb8;border-color:rgba(29,111,184,.42);background:rgba(29,111,184,.08)}
			.dswm-pill[data-on="1"] .dswm-dot{background:#1d6fb8;box-shadow:0 0 0 2px rgba(29,111,184,.18)}
			.dswm-dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.5;flex:0 0 auto}
			.dswm-pill[data-phase="busy"] .dswm-dot{animation:dswm-pulse 1s ease-in-out infinite}
			.dswm-pill[data-note="error"]{color:var(--dsw-alias-label-error,#c0392b);border-color:rgba(192,57,43,.45)}
			@keyframes dswm-pulse{0%,100%{opacity:.35}50%{opacity:1}}
			.dswm-set-page{max-width:640px;padding:4px 0 24px}
			.dswm-set-title{margin:0 0 6px;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}
			.dswm-set-desc{margin:0 0 16px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#5f6670)}
			.dswm-set-row{padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
			.dswm-set-row:first-of-type{border-top:none;padding-top:4px}
			.dswm-set-label{display:block;margin-bottom:3px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}
			.dswm-set-hint{display:block;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#5f6670)}
			.dswm-set-input{box-sizing:border-box;width:100%;margin-top:8px;padding:7px 10px;border-radius:8px;
				border:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.16));background:var(--dsw-alias-bg-layer-1,#fff);
				color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:13px}
			.dswm-set-input:focus{outline:2px solid rgba(29,111,184,.35);outline-offset:1px}
			.dswm-set-input[data-invalid="1"]{border-color:rgba(192,57,43,.55)}
			.dswm-set-actions{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
			.dswm-set-btn{padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.16));
				background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;cursor:pointer}
			.dswm-set-btn[data-primary="1"]{background:#1d6fb8;border-color:#1d6fb8;color:#fff}
			.dswm-set-btn:disabled{opacity:.5;cursor:default}
			.dswm-set-note{font-size:12px;color:#1d6fb8}
			.dswm-set-note[data-error="1"]{color:#c0392b}
			.dswm-set-flex{display:flex;align-items:center;justify-content:space-between;gap:16px}
			.dswm-toggle{position:relative;flex:0 0 auto;width:38px;height:22px;padding:0;border-radius:999px;cursor:pointer;
				border:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.2));background:rgba(0,0,0,.08);transition:background .15s,border-color .15s}
			.dswm-toggle[data-on="1"]{background:#1d6fb8;border-color:#1d6fb8}
			.dswm-toggle:disabled{opacity:.5;cursor:default}
			.dswm-toggle-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;
				box-shadow:0 1px 2px rgba(0,0,0,.2);transition:left .15s}
			.dswm-toggle[data-on="1"] .dswm-toggle-knob{left:18px}
			.dswm-set-footer{margin-top:16px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a8f99)}
			.dswm-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;
				max-width:min(560px,90vw);box-sizing:border-box;padding:10px 14px;border-radius:10px;
				background:rgba(29,111,184,.96);color:#fff;font-size:13px;line-height:1.55;
				box-shadow:0 8px 28px rgba(0,0,0,.28)}
		`;

		function ensureCss() {
			try {
				if (document.querySelector("style[data-dsh-whale-memory]")) return;
				const style = document.createElement("style");
				style.setAttribute("data-dsh-whale-memory", "1");
				style.textContent = CSS;
				document.head.appendChild(style);
			} catch {
				/* 样式失败不影响功能 */
			}
		}

		function readJson(response) {
			return response.json().catch(() => ({ ok: false, error: "bad-json" }));
		}

		function getState(sessionId) {
			return fetch(`${API}/state?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" })
				.then((response) => readJson(response).then((data) => ({ status: response.status, data })));
		}

		function post(path, body) {
			return fetch(`${API}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}).then((response) => readJson(response).then((data) => ({ status: response.status, data })));
		}

		/**
		 * 「鲸鲸记忆」开关。props.sessionId 由 header.actions 的 standard Session props 提供。
		 */
		function WhaleMemorySwitch(props) {
			const sessionId = props && typeof props.sessionId === "string" ? props.sessionId : null;
			const [state, setState] = React.useState({ phase: "loading", on: false, note: "" });
			const [toast, setToast] = React.useState("");

			React.useEffect(() => {
				if (toast === "") return undefined;
				const timer = setTimeout(() => setToast(""), 10000);
				return () => clearTimeout(timer);
			}, [toast]);

			React.useEffect(() => {
				if (sessionId === null) {
					setState({ phase: "error", on: false, note: "缺少会话 id，开关不可用" });
					return undefined;
				}
				let cancelled = false;
				(async () => {
					try {
						let result = await getState(sessionId);
						// 宿主没见过这个会话：先补一条默认状态（新会话默认关）。
						if (result.data && result.data.ok === true && result.data.known === false) {
							result = await post("/ensure", { sessionId });
						}
						if (cancelled) return;
						if (!result.data || result.data.ok !== true) {
							throw new Error((result.data && result.data.error) || "读不到开关状态");
						}
						setState({ phase: "ready", on: result.data.on === true, note: "" });
					} catch (error) {
						if (!cancelled) {
							setState({ phase: "error", on: false, note: error instanceof Error ? error.message : String(error) });
						}
					}
				})();
				return () => { cancelled = true; };
			}, [sessionId]);

			const toggle = async () => {
				if (sessionId === null || state.phase === "busy" || state.phase === "loading") return;
				const target = !state.on;
				const previous = state.on;
				setState({ phase: "busy", on: previous, note: "" });
				try {
					const result = await post("/toggle", { sessionId, on: target });
					if (!result.data || result.data.ok !== true) {
						const failure = new Error((result.data && result.data.error) || "切换失败");
						if (result.data && Array.isArray(result.data.candidates)) failure.candidates = result.data.candidates;
						throw failure;
					}
					setState({ phase: "ready", on: result.data.on === true, note: "" });
					if (typeof result.data.notice === "string" && result.data.notice !== "") {
						setToast(result.data.notice);
					}
				} catch (error) {
					const candidates = error && Array.isArray(error.candidates) ? error.candidates : null;
					setState({ phase: "error", on: previous, note: error instanceof Error ? error.message : String(error) });
					if (candidates !== null) setToast("找到多个像备份的文件夹，请到设置 → 鲸鲸记忆里选一个");
				}
			};

			const on = state.on === true;
			const busy = state.phase === "busy";
			const label = "鲸鲸记忆";
			const title = state.note !== ""
				? `${state.note}（${on ? "本会话：开" : "本会话：关"}）`
				: (on
					? "本会话正带着鲸鲸记忆说话（点一下切到纯干活）"
					: "本会话是纯干活模式（点一下带上鲸鲸记忆）");

			const button = React.createElement("button", {
				type: "button",
				className: "dswm-pill",
				"data-on": on ? "1" : "0",
				"data-phase": busy ? "busy" : (state.phase === "error" ? "error" : "ready"),
				"data-note": state.note === "" ? "" : "error",
				"aria-pressed": on ? "true" : "false",
				"aria-busy": busy ? "true" : undefined,
				disabled: busy || state.phase === "loading",
				title,
				onClick: toggle,
			},
				React.createElement("span", { className: "dswm-dot", "aria-hidden": "true" }),
				React.createElement("span", { className: "dswm-label" }, label),
				React.createElement("span", { className: "dswm-state" }, busy ? "…" : (on ? "开" : "关")));
			const toastEl = toast === "" ? null : React.createElement("div", {
				className: "dswm-toast",
				role: "status",
				"data-note": "notice",
			}, toast);
			return React.createElement(React.Fragment, null, button, toastEl);
		}

		function Toggle(props) {
			const checked = props.checked === true;
			return React.createElement("button", {
				type: "button",
				role: "switch",
				"aria-checked": checked ? "true" : "false",
				className: "dswm-toggle",
				"data-on": checked ? "1" : "0",
				disabled: props.disabled === true,
				title: props.title || undefined,
				onClick: () => { if (props.disabled !== true) props.onChange(!checked); },
			}, React.createElement("span", { className: "dswm-toggle-knob", "aria-hidden": "true" }));
		}

		function detectionText(detection) {
			if (detection === null || typeof detection !== "object") return "还没检测";
			const dir = detection.dir || detection.base || "";
			const legacy = Array.isArray(detection.legacy) && detection.legacy.length > 0
				? `；另外发现 ${detection.legacy.length} 个旧备份（共 ${detection.legacy.reduce((sum, item) => sum + (Number(item.entryCount) || 0), 0)} 条），打开开关时会合并进来`
				: "";
			if (detection.status === "existing") {
				const count = detection.info && typeof detection.info.entryCount === "number" ? detection.info.entryCount : 0;
				const readme = detection.info && detection.info.hasReadme === true ? "，有 README" : "";
				return `✅ 找到备份：${dir}（${count} 条${readme}）${legacy}`;
			}
			if (detection.status === "missing") return `📁 这个位置还不存在，打开开关时会新建：${dir}${legacy}`;
			if (detection.status === "uninitialized") return `📁 文件夹在，但没找到记忆文件；打开开关时会按格式初始化：${dir}${legacy}`;
			if (detection.status === "ambiguous") {
				const n = Array.isArray(detection.candidates) ? detection.candidates.length : 0;
				return `⚠️ 找到 ${n} 个像备份的文件夹，请点下面选一个`;
			}
			return "未知状态";
		}

		/**
		 * 设置页（settings.section）：备份路径、3 小时归纳间隔、自动归纳、新会话默认。
		 * 值存在宿主的 ~/.dsh/whale-memory/settings.json，改完即生效。
		 */
		function WhaleSettings() {
			const [phase, setPhase] = React.useState("loading");
			const [cfg, setCfg] = React.useState(null);
			const [paths, setPaths] = React.useState(null);
			const [dirDraft, setDirDraft] = React.useState("");
			const [hoursDraft, setHoursDraft] = React.useState("3");
			const [note, setNote] = React.useState("");
			const [failed, setFailed] = React.useState(false);
			const [saving, setSaving] = React.useState(false);
			const [detection, setDetection] = React.useState(null);

			const applyPayload = (data) => {
				if (!data || data.ok !== true) throw new Error((data && data.error) || "读取设置失败");
				setCfg(data.config);
				setPaths(data.paths || null);
				setDetection(data.detection || null);
				setDirDraft(data.config.backupDir || "");
				setHoursDraft(String(data.config.intervalHours));
				setPhase("ready");
			};

			const detect = (path) => {
				setSaving(true);
				setNote("");
				setFailed(false);
				return fetch(`${API}/detect?path=${encodeURIComponent(path)}`, { cache: "no-store" })
					.then((response) => readJson(response))
					.then((data) => {
						if (!data || data.ok !== true) throw new Error((data && data.error) || "检测失败");
						setDetection(data.detection || null);
						return data.detection;
					})
					.catch((error) => { setFailed(true); setNote(error instanceof Error ? error.message : String(error)); })
					.finally(() => setSaving(false));
			};

			React.useEffect(() => {
				let cancelled = false;
				fetch(`${API}/settings`, { cache: "no-store" })
					.then((response) => readJson(response))
					.then((data) => { if (!cancelled) applyPayload(data); })
					.catch((error) => {
						if (cancelled) return;
						setFailed(true);
						setNote(error instanceof Error ? error.message : String(error));
						setPhase("error");
					});
				return () => { cancelled = true; };
			}, []);

			const save = (patch) => {
				setSaving(true);
				setNote("");
				setFailed(false);
				fetch(`${API}/settings`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(patch),
				})
					.then((response) => readJson(response))
					.then((data) => { applyPayload(data); setNote("已保存"); })
					.catch((error) => { setFailed(true); setNote(error instanceof Error ? error.message : String(error)); })
					.finally(() => setSaving(false));
			};

			if (phase === "loading") {
				return React.createElement("div", { className: "dswm-set-page" }, "正在读取设置…");
			}
			const config = cfg || { backupDir: "", intervalHours: 3, autoSummarize: true, defaultOn: false };
			const hours = Number(hoursDraft);
			const hoursInvalid = !(Number.isFinite(hours) && hours > 0 && hours <= 168);
			const shared = paths && paths.shared ? paths.shared : "";

			const row = (label, hint, children) => React.createElement("div", { className: "dswm-set-row" },
				React.createElement("span", { className: "dswm-set-label" }, label),
				React.createElement("span", { className: "dswm-set-hint" }, hint),
				children);

			const noteEl = note === "" ? null : React.createElement("div", {
				className: "dswm-set-note",
				"data-error": failed ? "1" : "0",
				"aria-live": "polite",
				style: { marginTop: 10 },
			}, note);

			return React.createElement("div", { className: "dswm-set-page" },
				React.createElement("h2", { className: "dswm-set-title" }, "鲸鲸记忆"),
				React.createElement("p", { className: "dswm-set-desc" },
					"会话标题栏「鲸鲸记忆」开关的全局设置。开关本身每个会话一个：开 = 带鲸鲸记忆说话并维护备份；关 = 纯干活。"),
				row("备份文件夹",
					`默认是 ${shared || "~/.dsh/storages/鲸鲸记忆备份"}，所有工作区共用。也可以填工作区路径（例如 D:\\my-workspace），我会自动找里面的「鲸鲸记忆备份」。`,
					React.createElement("input", {
						className: "dswm-set-input",
						type: "text",
						value: dirDraft,
						placeholder: shared || "备份文件夹的绝对路径",
						spellCheck: false,
						onChange: (event) => setDirDraft(event.target.value),
						onKeyDown: (event) => { if (event.key === "Enter") save({ backupDir: dirDraft }); },
					}),
					React.createElement("div", { className: "dswm-set-actions" },
						React.createElement("button", {
							type: "button",
							className: "dswm-set-btn",
							"data-primary": "1",
							disabled: saving,
							onClick: () => save({ backupDir: dirDraft }),
						}, "保存路径"),
						React.createElement("button", {
							type: "button",
							className: "dswm-set-btn",
							disabled: saving,
							onClick: () => detect(dirDraft),
						}, "检测"),
						config.backupDir === ""
							? React.createElement("span", { className: "dswm-set-hint" }, "当前：按默认路径")
							: React.createElement("span", { className: "dswm-set-hint" }, `当前：${config.backupDir}`)),
					React.createElement("div", { className: "dswm-set-hint", style: { marginTop: 8 } },
						detection === null ? "还没检测" : detectionText(detection)),
					detection !== null && Array.isArray(detection.candidates) && detection.candidates.length > 1
						? React.createElement("div", { className: "dswm-set-actions" },
							...detection.candidates.map((candidate) => React.createElement("button", {
								key: candidate.dir,
								type: "button",
								className: "dswm-set-btn",
								disabled: saving,
								title: candidate.dir,
								onClick: () => { setDirDraft(candidate.dir); save({ backupDir: candidate.dir }); },
							}, `用这个（${candidate.entryCount} 条）`)))
						: null),
				row("定时归纳间隔（小时）",
					"默认 3 小时。只在开着「鲸鲸记忆」的会话里跑；没有新对话就什么都不做。",
					React.createElement("input", {
						className: "dswm-set-input",
						type: "number",
						min: "0.1",
						max: "168",
						step: "0.5",
						value: hoursDraft,
						"data-invalid": hoursInvalid ? "1" : "0",
						onChange: (event) => setHoursDraft(event.target.value),
					}),
					React.createElement("div", { className: "dswm-set-actions" },
						React.createElement("button", {
							type: "button",
							className: "dswm-set-btn",
							"data-primary": "1",
							disabled: saving || hoursInvalid,
							onClick: () => save({ intervalHours: hours }),
						}, "保存间隔"),
						hoursInvalid ? React.createElement("span", { className: "dswm-set-hint" }, "0.1 ~ 168 之间") : null)),
				React.createElement("div", { className: "dswm-set-row" },
					React.createElement("div", { className: "dswm-set-flex" },
						React.createElement("div", null,
							React.createElement("span", { className: "dswm-set-label" }, "自动归纳"),
							React.createElement("span", { className: "dswm-set-hint" }, "开着才按上面的间隔归纳；关掉就只剩对话里的实时记忆。")),
						React.createElement(Toggle, {
							checked: config.autoSummarize === true,
							disabled: saving,
							title: "自动归纳",
							onChange: (next) => save({ autoSummarize: next }),
						}))),
				React.createElement("div", { className: "dswm-set-row" },
					React.createElement("div", { className: "dswm-set-flex" },
						React.createElement("div", null,
							React.createElement("span", { className: "dswm-set-label" }, "新会话默认打开"),
							React.createElement("span", { className: "dswm-set-hint" }, "只管之后新开的会话；已有的会话不受影响。")),
						React.createElement(Toggle, {
							checked: config.defaultOn === true,
							disabled: saving,
							title: "新会话默认打开",
							onChange: (next) => save({ defaultOn: next }),
						}))),
				noteEl,
				React.createElement("div", { className: "dswm-set-footer" },
					`设置存在：${paths && paths.stateDir ? paths.stateDir : "~/.dsh/whale-memory"}`));
		}

		/**
		 * 客户端插件体：会话标题栏开关 + 设置页。
		 * @param {object} ctx - 客户端 Cordis 上下文。
		 */
		function apply(ctx) {
			const slots = ctx && typeof ctx.get === "function" ? ctx.get("slots") : ctx?.slots;
			if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") {
				console.warn("[dsh-whale-memory] slots 服务不可用，开关未注册");
				return;
			}
			ensureCss();
			const disposers = [];
			disposers.push(slots.inject(SLOT, () => slots.register(
				{
					name: SLOT,
					// order 16：排在「重启」(15) 后面、「后台任务」(20) 前面。
					id: "whale-memory",
					order: 16,
				},
				WhaleMemorySwitch,
			)));
			disposers.push(slots.inject("settings.section", () => slots.register(
				{
					name: "settings.section",
					id: "whale-memory",
					order: 93,
					label: () => "鲸鲸记忆",
				},
				WhaleSettings,
			)));
			if (typeof ctx.effect === "function") {
				ctx.effect(() => () => {
					for (const dispose of disposers) {
						try { dispose() } catch { /* ignore */ }
					}
				});
			}
		}

		module.exports = { name: "dsh-whale-memory", inject: ["slots"], apply };
		return module.exports;
	},
});
