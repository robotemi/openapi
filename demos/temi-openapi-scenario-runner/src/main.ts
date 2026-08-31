import logoUrl from "../logo.svg";
import {
  ENVIRONMENTS,
  isEnvironment,
  TemiApiClient,
  TemiApiError,
  type Environment,
  type RobotSummary,
  type RobotStatus,
} from "./api";
import {
  actionAvailability,
  discoveryFailure,
  RobotDiscoveryController,
  RobotSelectionError,
  type DiscoveryFailure,
  type DiscoveryState,
} from "./discovery";
import {
  SequenceComposer,
  SequenceComposerError,
  type ComposerContext,
  type ComposerOption,
  type SequenceActionDraft,
  type SequenceComposerState,
} from "./composer";
import { RequestOrchestrator } from "./orchestrator";
import {
  acceptRun,
  beginRun,
  createRunState,
  hasActiveRun,
  recoverUnknown,
  requestStop,
  transitionRunState,
  type RunStateSnapshot,
} from "./run-state";
import { PlayPollStopLifecycle, type LifecycleSnapshot } from "./lifecycle";
import { TimelineStore } from "./timeline";

const appRoot = document.querySelector<HTMLElement>("#app");
if (appRoot === null) throw new Error("Missing demo application root.");
const app: HTMLElement = appRoot;

const timeline = new TimelineStore();
const orchestrator = new RequestOrchestrator({ timeline });

type DemoScreen = "connect" | "robot" | "actions" | "review" | "running";
type Language = "zh" | "en";
type RobotStatusFilter = "all" | "online";
type EnvironmentTransportState = "unknown" | "readable" | "blocked";
type StatusTone = "neutral" | "success" | "error";
type RobotStatusPanelState = {
  expanded: boolean;
  requestState: "idle" | "pending" | "succeeded" | "failed";
  data: RobotStatus | null;
  receivedAt: number | null;
  error: string | null;
  requestId: number;
};

const runtimeEnglish: Readonly<Record<string, string>> = {
  "连接已失效，请重新连接。": "The connection expired. Reconnect and try again.",
  "当前环境无法连接，请重新开始。": "This environment cannot be reached. Start over and try again.",
  "请输入访问令牌。": "Enter an access token.",
  "正在验证连接…": "Verifying the connection…",
  "正在读取机器人…": "Loading robots…",
  "没有可用的机器人。": "No robots are available.",
  "正在读取机器人资源…": "Loading robot resources…",
  "部分资源读取失败，可重新读取。": "Some robot resources could not be loaded. You can reload them.",
  "部分机器人状态读取失败。": "Some robot statuses could not be loaded.",
  "正在刷新状态…": "Refreshing status…",
  "状态刷新失败。": "Status refresh failed.",
  "当前环境无法连接，不能运行。": "This environment cannot be reached, so the run cannot start.",
  "请先检查动作。": "Check the actions first.",
  "正在刷新机器人状态…": "Refreshing robot status…",
  "正在启动…": "Starting…",
  "未能启动运行。": "The run could not be started.",
  "正在停止…": "Stopping…",
  "停止请求未被确认。": "The stop request was not confirmed.",
  "请修正标出的内容。": "Fix the highlighted items.",
  "正在检查动作…": "Checking actions…",
  "动作检查失败，请修正后重试。": "The action check failed. Fix the actions and try again.",
  "运行状态异常。": "The run state is invalid.",
  "连接已失效，访问令牌已清除。": "The connection expired and the access token was cleared.",
  "所需资源尚不可用。": "The required resources are not available yet.",
  "请选择列表中的机器人。": "Select a robot from the list.",
  "访问令牌无效或已过期。": "The access token is invalid or expired.",
  "连接超时，请检查网络后重试。": "The connection timed out. Check the network and try again.",
  "连接失败，请检查网络或浏览器访问限制。": "Connection failed. Check the network or browser access restrictions.",
  "状态读取超时。": "The status request timed out.",
  "状态读取失败，请检查网络。": "Could not read status. Check the network.",
  "无权读取该机器人状态。": "You do not have permission to read this robot's status.",
  "状态读取失败。": "Could not read status.",
  "请求失败。": "The request failed.",
  "连接已失效。": "The connection expired.",
  "网络不可用。": "The network is unavailable.",
  "请求超时。": "The request timed out.",
  "无法确认 Play 是否已被机器人接受；不会自动重试 Play。": "It is unclear whether the robot accepted Play. Play will not be retried automatically.",
  "本次状态观察未知；只会重试 GET，不会自动重试 Play 或 Stop。": "This status observation is unknown. Only GET may retry; Play and Stop will not be retried automatically.",
  "无法确认 Stop 是否已被接受；不会自动重发 Stop，只会继续 GET 状态观察。": "It is unclear whether Stop was accepted. Stop will not be resent; only GET status observation will continue.",
  "401：已清除内存 OAT；无法确认机器人当前是否仍在执行，不能自动重试 Play 或 Stop。": "401: The in-memory OAT was cleared. The robot's current execution state is unknown, so Play and Stop cannot be retried automatically.",
};

let environment: Environment = "production";
let language: Language = "zh";
let languageMenuOpen = false;
let client: TemiApiClient | null = null;
let discovery: RobotDiscoveryController | null = null;
let composer: SequenceComposer | null = null;
let runState: RunStateSnapshot = createRunState();
let lifecycle: PlayPollStopLifecycle | null = null;
let environmentTransport: Record<Environment, EnvironmentTransportState> = {
  production: "unknown",
  integration: "unknown",
};

let pendingRobotSerialNumber: string | null = null;
const robotStatusPanels = new Map<string, RobotStatusPanelState>();
let nextRobotStatusRequestId = 1;
let robotStatusFilter: RobotStatusFilter = "all";
let robotStatusesRefreshed = false;
let robotStatusesRefreshing = false;
let robotResourcesLoading = false;
let editingValidatedSequence = false;
let addActionMenuOpen = false;
let actionMenuId: string | null = null;
let draggedActionId: string | null = null;
let statusMessage = "";
let statusTone: StatusTone = "neutral";

function render(): void {
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.title = copy("场景运行 | temi Developer", "Scenario Runner | temi Developer");
  app.innerHTML = renderPage();
  bindEvents();
}

function renderPage(): string {
  const screen = currentScreen();
  return `
    <div class="app-shell">
      ${renderHeader()}
      <main class="app-main">
        ${screen === "connect" ? "" : renderProgress(screen)}
        ${renderScreen(screen)}
      </main>
      ${renderPlayConfirmation()}
    </div>
  `;
}

function currentScreen(): DemoScreen {
  if (client === null || runState.phase === "idle" || runState.phase === "verifying") {
    return "connect";
  }
  if (discovery === null || discovery.state.selectedRobot === null) return "robot";

  const lifecyclePhase = lifecycle?.state.phase;
  const hasRunView = lifecycle !== null && (
    ["starting", "running", "stopping", "terminal", "unknown"].includes(lifecyclePhase ?? "") ||
    ["starting", "running", "stopping", "terminal", "unknown", "failed"].includes(runState.phase)
  );
  if (hasRunView) return "running";
  if (editingValidatedSequence) return "actions";
  if (
    lifecyclePhase === "preflighting" ||
    lifecyclePhase === "blocked" ||
    lifecyclePhase === "confirmation_required" ||
    lifecyclePhase === "failed"
  ) {
    return "review";
  }
  if (
    composer?.state.validation.status === "succeeded" &&
    (runState.phase === "ready" || runState.phase === "terminal")
  ) {
    return "review";
  }
  return "actions";
}

function renderHeader(): string {
  const connected = client !== null;
  const verified = discovery?.state.verify.status === "succeeded";
  const statusText = !connected
    ? copy("未连接", "Not connected")
    : verified
      ? copy(`${environmentLabel(environment)} · 已连接`, `${environmentLabel(environment)} · Connected`)
      : copy("正在连接", "Connecting");
  const canDisconnect = connected && !isLifecycleLocked() && runState.phase !== "validating";
  const languageLabel = language === "zh" ? "中文" : "English";

  return `
    <header class="app-header">
      <div class="header-inner">
        <div class="brand-lockup" aria-label="temi developer">
          <img src="${logoUrl}" alt="temi developer" />
        </div>
        <div class="header-actions">
          <div class="language-picker">
            <button
              class="language-button"
              type="button"
              data-language-toggle
              aria-haspopup="menu"
              aria-expanded="${languageMenuOpen}"
              aria-label="${copy("选择语言", "Select language")}"
            >
              <span>${languageLabel}</span>
              <span class="language-chevron ${languageMenuOpen ? "open" : ""}" aria-hidden="true">⌄</span>
            </button>
            ${languageMenuOpen ? renderLanguageMenu() : ""}
          </div>
          <span class="connection-status">
            <span class="status-dot ${verified ? "online" : ""}"></span>
            <span>${statusText}</span>
          </span>
          ${canDisconnect ? `<button class="header-button" type="button" data-reset>${copy("断开", "Disconnect")}</button>` : ""}
        </div>
      </div>
    </header>
  `;
}

function renderLanguageMenu(): string {
  return `
    <div class="language-menu" role="menu" aria-label="${copy("选择语言", "Select language")}">
      <button class="language-option ${language === "zh" ? "selected" : ""}" type="button" role="menuitemradio" aria-checked="${language === "zh"}" data-language="zh">
        <span>中文</span><span aria-hidden="true">${language === "zh" ? "✓" : ""}</span>
      </button>
      <button class="language-option ${language === "en" ? "selected" : ""}" type="button" role="menuitemradio" aria-checked="${language === "en"}" data-language="en">
        <span>English</span><span aria-hidden="true">${language === "en" ? "✓" : ""}</span>
      </button>
    </div>
  `;
}

function renderProgress(screen: DemoScreen): string {
  const steps = [
    copy("选择机器人", "Select robot"),
    copy("编排动作", "Add actions"),
    copy("确认运行", "Review"),
  ];
  const currentIndex = screen === "robot" ? 0 : screen === "actions" ? 1 : screen === "review" ? 2 : 3;
  return `
    <nav class="progress" aria-label="${copy("运行步骤", "Run steps")}">
      <ol class="progress-list">
        ${steps.map((label, index) => {
          const stateClass = index < currentIndex ? "complete" : index === currentIndex ? "current" : "";
          const marker = index < currentIndex ? "✓" : String(index + 1);
          return `<li class="progress-step ${stateClass}"><span class="step-index">${marker}</span><span class="progress-label">${label}</span></li>`;
        }).join("")}
      </ol>
    </nav>
  `;
}

function renderScreen(screen: DemoScreen): string {
  if (screen === "connect") return renderConnect();
  if (screen === "robot") return renderRobotSelection();
  if (screen === "actions") return renderActions();
  if (screen === "review") return renderReview();
  return renderRunning();
}

function renderConnect(): string {
  const connecting = runState.phase === "verifying";
  const failed = runState.phase === "failed";
  const blocked = environmentTransport[environment] === "blocked";
  const canConnect = runState.phase === "idle" && client === null && !blocked;
  return `
    <section class="connect-wrap stage" aria-label="${copy("连接", "Connect")}">
      <div class="connect-card">
        <form class="connect-form" data-connection-form>
          <div class="field">
            <label for="environment">${copy("环境", "Environment")}</label>
            <select id="environment" data-environment ${canConnect ? "" : "disabled"}>
              ${ENVIRONMENTS.map((value) => `
                <option value="${value}" ${value === environment ? "selected" : ""}>${environmentLabel(value)}</option>
              `).join("")}
            </select>
          </div>
          <div class="field">
            <label for="oat">${copy("访问令牌（OAT）", "Access token (OAT)")}</label>
            <input
              id="oat"
              type="password"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              required
              data-oat
              ${canConnect ? "" : "disabled"}
            />
            <p class="field-note">${copy("仅在本页使用，连接后清空。", "Used only on this page and cleared after connecting.")}</p>
          </div>
          <button class="button primary wide" type="submit" ${canConnect ? "" : "disabled"}>
            ${connecting ? copy("正在连接…", "Connecting…") : copy("连接", "Connect")}
          </button>
          ${renderStatusNotice()}
        </form>
        ${failed || blocked ? `<button class="button wide reconnect-button" type="button" data-reset>${copy("重新连接", "Reconnect")}</button>` : ""}
      </div>
    </section>
  `;
}

function renderRobotSelection(): string {
  const state = discovery?.state;
  const allRobots = state?.robots.data ?? [];
  const orderedRobots = robotStatusesRefreshed ? sortRobotsOnlineFirst(allRobots) : allRobots;
  const robots = robotStatusFilter === "online"
    ? orderedRobots.filter((robot) => isRobotOnline(robot.serialNumber))
    : orderedRobots;
  const onlineCount = allRobots.filter((robot) => isRobotOnline(robot.serialNumber)).length;
  const loading = state?.robots.status === "pending" || runState.phase === "discovering" && state?.robots.status !== "succeeded";
  const failed = state?.robots.status === "failed" || runState.phase === "failed";

  return `
    <section class="stage" aria-labelledby="robot-title">
      <div class="stage-head">
        <div>
          <h1 id="robot-title">${copy("选择机器人", "Select a robot")}</h1>
          <p>${copy("选择这次运行要使用的机器人。", "Choose the robot for this run.")}</p>
        </div>
        ${allRobots.length > 0 ? `
          <div class="robot-list-tools">
            <button
              class="robot-list-tool ${robotStatusFilter === "online" ? "active" : ""}"
              type="button"
              data-filter-online
              aria-pressed="${robotStatusFilter === "online"}"
              ${robotStatusesRefreshed ? "" : "disabled"}
            >${copy("仅看在线", "Online only")}${robotStatusesRefreshed ? ` ${onlineCount}` : ""}</button>
            <button class="robot-list-tool" type="button" data-refresh-all-statuses ${robotStatusesRefreshing ? "disabled" : ""}>
              <span class="refresh-symbol ${robotStatusesRefreshing ? "spinning" : ""}" aria-hidden="true">↻</span>
              ${robotStatusesRefreshing ? copy("刷新中…", "Refreshing…") : copy("刷新状态", "Refresh status")}
            </button>
            <span class="stage-count">${copy(`${allRobots.length} 台设备`, `${allRobots.length} ${allRobots.length === 1 ? "device" : "devices"}`)}</span>
          </div>
        ` : ""}
      </div>
      ${loading ? renderLoadingPanel(copy("正在读取机器人…", "Loading robots…")) : ""}
      ${failed ? renderInlineNotice(copy("机器人列表读取失败，请重新连接。", "Could not load the robot list. Reconnect and try again."), "error") : ""}
      ${!loading && !failed && allRobots.length === 0 ? renderInlineNotice(copy("没有可用的机器人。", "No robots are available."), "error") : ""}
      ${!loading && !failed && allRobots.length > 0 && robots.length === 0 ? renderInlineNotice(copy("当前没有在线机器人。", "No robots are currently online."), "neutral") : ""}
      ${robots.length === 0 ? "" : `
        <div class="robot-grid">
          ${robots.map((robot, index) => {
            const selected = pendingRobotSerialNumber === robot.serialNumber;
            const statusPanel = robotStatusPanels.get(robot.serialNumber);
            const expanded = statusPanel?.expanded === true;
            const panelId = `robot-status-${index}`;
            return `
              <article class="robot-card ${selected ? "selected" : ""} ${expanded ? "expanded" : ""}">
                <button
                  class="robot-select-control"
                  type="button"
                  data-robot-card="${escapeHtml(robot.serialNumber)}"
                  aria-pressed="${selected}"
                >
                  <span class="robot-card-top">
                    <span>
                      <span class="robot-name">${displayName(robot.teminame, copy("未命名机器人", "Unnamed robot"))}</span>
                      <span class="robot-serial">${escapeHtml(robot.serialNumber)}</span>
                    </span>
                    <span class="robot-select-mark" aria-hidden="true">${selected ? "✓" : ""}</span>
                  </span>
                  ${renderRobotCardStatus(statusPanel)}
                </button>
                <div class="robot-card-footer">
                  <button class="robot-card-action" type="button" data-robot-card="${escapeHtml(robot.serialNumber)}">${copy("选择", "Select")}</button>
                  <button
                    class="robot-status-toggle"
                    type="button"
                    data-robot-status-toggle="${escapeHtml(robot.serialNumber)}"
                    aria-expanded="${expanded}"
                    aria-controls="${panelId}"
                  >${expanded ? copy("收起", "Collapse") : copy("查看状态", "View status")}</button>
                </div>
                ${expanded ? renderRobotStatusPanel(panelId, statusPanel) : ""}
              </article>
            `;
          }).join("")}
        </div>
      `}
      ${renderStatusNotice()}
      <div class="stage-actions">
        ${failed ? `<button class="button ghost" type="button" data-reset>${copy("重新连接", "Reconnect")}</button>` : "<span></span>"}
        <button class="button primary stage-actions-end" type="button" data-continue-robot ${pendingRobotSerialNumber === null || robotStatusesRefreshing ? "disabled" : ""}>
          ${copy("继续", "Continue")} <span aria-hidden="true">→</span>
        </button>
      </div>
    </section>
  `;
}

function renderRobotCardStatus(panel: RobotStatusPanelState | undefined): string {
  if (panel?.requestState === "pending") {
    return `<span class="robot-card-status refreshing"><span class="robot-card-status-dot"></span>${copy("刷新中…", "Refreshing…")}</span>`;
  }
  if (panel?.requestState === "failed") {
    return `<span class="robot-card-status error"><span class="robot-card-status-dot"></span>${copy("读取失败", "Unavailable")}</span>`;
  }
  if (panel?.requestState === "succeeded" && panel.data !== null) {
    return `<span class="robot-card-status ${panel.data.status}"><span class="robot-card-status-dot"></span>${statusLabel(panel.data.status)}</span>`;
  }
  return `<span class="robot-card-status unknown"><span class="robot-card-status-dot"></span>${copy("未刷新", "Not refreshed")}</span>`;
}

function sortRobotsOnlineFirst(robots: readonly RobotSummary[]): readonly RobotSummary[] {
  return [...robots].sort((left, right) => Number(isRobotOnline(right.serialNumber)) - Number(isRobotOnline(left.serialNumber)));
}

function isRobotOnline(serialNumber: string): boolean {
  const panel = robotStatusPanels.get(serialNumber);
  return panel?.data?.status === "online" && panel.requestState !== "failed";
}

function renderRobotStatusPanel(
  panelId: string,
  panel: RobotStatusPanelState | undefined,
): string {
  if (panel === undefined || panel.requestState === "idle") return "";
  if (panel.requestState === "pending" && panel.data === null) {
    return `
      <div class="robot-status-panel" id="${panelId}" role="status">
        <p class="robot-status-loading"><span class="loading-dot"></span>${copy("正在读取状态…", "Loading status…")}</p>
      </div>
    `;
  }
  if (panel.requestState === "failed" || panel.data === null) {
    return `
      <div class="robot-status-panel" id="${panelId}" role="status">
        <p class="robot-status-error">${escapeHtml(localizeRuntimeText(panel.error ?? "状态读取失败。"))}</p>
      </div>
    `;
  }

  const status = panel.data;
  return `
    <div class="robot-status-panel" id="${panelId}" role="status">
      ${panel.requestState === "pending" ? `<p class="robot-status-loading compact"><span class="loading-dot"></span>${copy("正在更新…", "Updating…")}</p>` : ""}
      <dl class="robot-status-facts">
        <div><dt>${copy("状态", "Status")}</dt><dd>${statusLabel(status.status)}</dd></div>
        <div><dt>${copy("电量", "Battery")}</dt><dd>${escapeHtml(robotBatteryText(status))}</dd></div>
        <div><dt>${copy("移动", "Movement")}</dt><dd>${escapeHtml(robotMovementText(status))}</dd></div>
        <div><dt>${copy("任务", "Sequence")}</dt><dd>${escapeHtml(robotSequenceText(status))}</dd></div>
        <div><dt>${copy("通话", "Call")}</dt><dd>${escapeHtml(robotCallText(status))}</dd></div>
      </dl>
      <p class="robot-status-snapshot">${copy("最近一次读取结果", "Latest reading")}${panel.receivedAt === null ? "" : ` · ${formatClock(panel.receivedAt)}`}</p>
    </div>
  `;
}

function renderActions(): string {
  const discoveryState = discovery?.state;
  const composerState = composer?.state;
  const selectedRobot = discoveryState?.selectedRobot;
  if (discoveryState === undefined || selectedRobot === null || selectedRobot === undefined || composerState === undefined) {
    return renderLoadingPanel(copy("正在准备动作编辑器…", "Preparing the action editor…"));
  }

  const actions = composerState.actions;
  const loadingResources = robotResourcesLoading || runState.phase === "discovering";
  const editLocked = loadingResources || runState.phase === "validating" || isLifecycleLocked();
  const validationIssues = composerState.validation.status === "failed" ? composerState.validation.issues.length : 0;
  const hasResourceFailures = [discoveryState.status, discoveryState.locations, discoveryState.contacts]
    .some((slot) => slot.status === "failed");

  return `
    <section class="stage" aria-labelledby="actions-title">
      <div class="stage-head">
        <div>
          <h1 id="actions-title">${copy("编排动作", "Add actions")}</h1>
          <p>${copy("动作会按照这里的顺序执行。", "Actions run in the order shown here.")}</p>
        </div>
        <span class="stage-count">${copy(`${actions.length} 个动作`, `${actions.length} ${actions.length === 1 ? "action" : "actions"}`)}</span>
      </div>
      ${renderRobotContext(discoveryState)}
      ${loadingResources ? renderInlineNotice(copy("正在读取机器人资源…", "Loading robot resources…"), "neutral") : renderResourceNotice(discoveryState)}
      ${loadingResources || hasResourceFailures ? "" : renderStatusNotice()}
      ${actions.length === 0
        ? `<div class="empty-sequence"><div><strong>${copy("还没有动作", "No actions yet")}</strong><span>${copy("从移动、播报或呼叫开始。", "Start with movement, speech, or a call.")}</span></div></div>`
        : `<ol class="sequence-list">${actions.map((action, index) => renderActionCard(action, index, composerState, editLocked)).join("")}</ol>`}
      ${renderComposerValidation(composerState)}
      <div class="add-action">
        <button class="button" type="button" data-toggle-add-menu ${editLocked ? "disabled" : ""}>
          <span aria-hidden="true">＋</span> ${copy("添加动作", "Add action")}
        </button>
        ${addActionMenuOpen ? renderAddActionMenu(discoveryState, editLocked) : ""}
      </div>
      <div class="stage-actions">
        <button class="button ghost" type="button" data-back-robot ${editLocked ? "disabled" : ""}>
          <span aria-hidden="true">←</span> ${copy("返回", "Back")}
        </button>
        <button class="button primary" type="button" data-validate-sequence ${actions.length === 0 || editLocked ? "disabled" : ""}>
          ${runState.phase === "validating"
            ? copy("正在检查…", "Checking…")
            : validationIssues > 0
              ? copy(`修正 ${validationIssues} 个问题`, `Fix ${validationIssues} ${validationIssues === 1 ? "issue" : "issues"}`)
              : composerState.validation.status === "succeeded"
                ? copy("返回确认", "Return to review")
                : copy("检查并继续", "Check and continue")}
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </section>
  `;
}

function renderRobotContext(state: DiscoveryState): string {
  const robot = state.selectedRobot;
  if (robot === null) return "";
  const status = state.status.data?.status;
  const battery = state.status.data?.battery?.level;
  const updatedAt = state.status.receivedAt;
  const meta = [
    robot.serialNumber,
    typeof battery === "number" && Number.isFinite(battery) ? copy(`${battery}% 电量`, `${battery}% battery`) : null,
    updatedAt === null ? null : copy(`更新于 ${formatClock(updatedAt)}`, `Updated at ${formatClock(updatedAt)}`),
  ].filter((item): item is string => item !== null).join(" · ");

  return `
    <div class="robot-context">
      <div class="robot-context-main">
        <span class="robot-avatar" aria-hidden="true">t</span>
        <div>
          <strong>${displayName(robot.teminame, copy("未命名机器人", "Unnamed robot"))}</strong>
          <p>${escapeHtml(meta)}</p>
        </div>
      </div>
      <div class="robot-context-actions">
        ${renderStatusPill(status, robotResourcesLoading || state.status.status === "pending")}
        <button class="text-button" type="button" data-refresh-status ${robotResourcesLoading || state.status.status === "pending" || isLifecycleLocked() ? "disabled" : ""}>${copy("刷新", "Refresh")}</button>
      </div>
    </div>
  `;
}

function renderResourceNotice(state: DiscoveryState): string {
  const failures: string[] = [];
  if (state.status.status === "failed") failures.push(copy("状态读取失败", "Status unavailable"));
  if (state.locations.status === "failed") failures.push(copy("位置不可用", "Locations unavailable"));
  if (state.contacts.status === "failed") failures.push(copy("联系人不可用", "Contacts unavailable"));
  if (failures.length > 0) {
    return `
      <div class="resource-notice">
        ${renderInlineNotice(`${failures.join(copy("，", ", "))}${copy("。", ".")}`, "error")}
        <button class="text-button" type="button" data-refresh-resources>${copy("重新读取", "Reload")}</button>
      </div>
    `;
  }
  return "";
}

function renderAddActionMenu(state: DiscoveryState, locked: boolean): string {
  const actions = [
    { type: "MOVEMENT", glyph: "M", label: copy("前往位置", "Go to location") },
    { type: "SPEAK", glyph: "S", label: copy("播报文字", "Speak text") },
    { type: "START_CALL", glyph: "C", label: copy("发起呼叫", "Start call") },
  ] as const;
  return `
    <div class="add-action-menu" role="menu" aria-label="${copy("选择动作", "Select an action")}">
      ${actions.map((action) => {
        const availability = actionAvailability(state, action.type);
        const disabled = locked || !availability.enabled;
        return `
          <button type="button" role="menuitem" data-add-action="${action.type}" ${disabled ? "disabled" : ""} title="${escapeHtml(actionAvailabilityText(state, action.type))}">
            <span class="action-glyph">${action.glyph}</span><span>${action.label}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function renderActionCard(
  action: SequenceActionDraft,
  index: number,
  state: SequenceComposerState,
  locked: boolean,
): string {
  return `
    <li>
      <article class="sequence-card" draggable="${locked ? "false" : "true"}" data-action-card data-action-id="${escapeHtml(action.id)}">
        <button class="drag-handle" type="button" tabindex="-1" aria-label="${copy(`拖动动作 ${index + 1}`, `Drag action ${index + 1}`)}" ${locked ? "disabled" : ""}>⠿</button>
        <div class="sequence-content">
          <div class="sequence-heading">
            <span class="sequence-number">${index + 1}</span>
            <h2>${actionLabel(action.type)}</h2>
          </div>
          ${renderActionFields(action, state, locked)}
        </div>
        <div class="action-menu-wrap">
          <button class="icon-button" type="button" data-toggle-action-menu="${escapeHtml(action.id)}" aria-label="${copy("动作菜单", "Action menu")}" ${locked ? "disabled" : ""}>•••</button>
          ${actionMenuId === action.id ? renderActionMenu(action, index, state.actions.length) : ""}
        </div>
      </article>
    </li>
  `;
}

function renderActionFields(
  action: SequenceActionDraft,
  state: SequenceComposerState,
  locked: boolean,
): string {
  const error = actionValidationIssue(state, action.id);
  const context = state.context;
  if (action.type === "MOVEMENT") {
    return `
      <div class="field">
        <label for="${escapeHtml(action.id)}-location">${copy("位置", "Location")}</label>
        <select id="${escapeHtml(action.id)}-location" data-action-field="location" data-action-id="${escapeHtml(action.id)}" ${locked ? "disabled" : ""}>
          <option value="">${copy("请选择位置", "Select a location")}</option>
          ${(context?.locations ?? []).map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === action.location ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
        </select>
        ${error === null ? "" : `<p class="field-error">${escapeHtml(error)}</p>`}
      </div>
    `;
  }
  if (action.type === "SPEAK") {
    return `
      <div class="field">
        <label for="${escapeHtml(action.id)}-tts">${copy("播报内容", "Text to speak")}</label>
        <textarea id="${escapeHtml(action.id)}-tts" rows="3" data-action-field="tts" data-action-id="${escapeHtml(action.id)}" placeholder="${copy("输入机器人要说的话", "Enter what the robot should say")}" ${locked ? "disabled" : ""}>${escapeHtml(action.tts)}</textarea>
        ${error === null ? "" : `<p class="field-error">${escapeHtml(error)}</p>`}
      </div>
    `;
  }
  return `
    <div class="field">
      <span class="field-label">${copy("联系人", "Contacts")}</span>
      <fieldset class="contact-options" aria-label="${copy("联系人", "Contacts")}" ${locked ? "disabled" : ""}>
        ${(context?.contacts ?? []).map((option, optionIndex) => `
          <label class="contact-choice" for="${escapeHtml(action.id)}-contact-${optionIndex}">
            <input
              id="${escapeHtml(action.id)}-contact-${optionIndex}"
              type="checkbox"
              data-action-contact
              data-action-id="${escapeHtml(action.id)}"
              value="${escapeHtml(option.value)}"
              ${action.contactIds.includes(option.value) ? "checked" : ""}
            />
            <span>${escapeHtml(option.label)}</span>
          </label>
        `).join("")}
      </fieldset>
      ${error === null ? "" : `<p class="field-error">${escapeHtml(error)}</p>`}
    </div>
  `;
}

function renderActionMenu(action: SequenceActionDraft, index: number, total: number): string {
  return `
    <div class="action-menu" role="menu">
      <button type="button" role="menuitem" data-move-action="up" data-action-id="${escapeHtml(action.id)}" ${index === 0 ? "disabled" : ""}>${copy("上移", "Move up")}</button>
      <button type="button" role="menuitem" data-move-action="down" data-action-id="${escapeHtml(action.id)}" ${index === total - 1 ? "disabled" : ""}>${copy("下移", "Move down")}</button>
      <button class="danger-text" type="button" role="menuitem" data-remove-action data-action-id="${escapeHtml(action.id)}">${copy("删除", "Delete")}</button>
    </div>
  `;
}

function renderComposerValidation(state: SequenceComposerState): string {
  if (state.validation.status === "pending") return renderInlineNotice(copy("正在检查动作…", "Checking actions…"), "neutral");
  if (state.validation.status !== "failed") return "";
  const sequenceIssues = state.validation.issues.filter((issue) => issue.actionId === null);
  const remoteError = state.validation.error;
  if (sequenceIssues.length === 0 && remoteError === null) return "";
  const message = remoteError === null
    ? sequenceIssues.map((issue) => validationIssueText(issue.field)).join(" ")
    : validationErrorText(remoteError);
  return renderInlineNotice(message, "error");
}

function renderReview(): string {
  const discoveryState = discovery?.state;
  const composerState = composer?.state;
  const robot = discoveryState?.selectedRobot;
  if (discoveryState === undefined || composerState === undefined || robot === null || robot === undefined) {
    return renderLoadingPanel(copy("正在准备确认内容…", "Preparing the review…"));
  }

  const snapshot = lifecycle?.state;
  const preflighting = snapshot?.phase === "preflighting";
  const confirmationRequired = snapshot?.phase === "confirmation_required";
  const blocked = snapshot?.phase === "blocked";
  const preflightFailed = snapshot?.phase === "failed";
  const status = snapshot?.latestStatus?.status ?? discoveryState.status.data?.status;
  const primaryLabel = preflighting
    ? copy("正在检查状态…", "Checking status…")
    : blocked || preflightFailed
      ? copy("重新检查", "Check again")
      : copy("确认运行", "Confirm run");

  return `
    <section class="stage" aria-labelledby="review-title">
      <div class="stage-head">
        <div>
          <h1 id="review-title">${copy("确认运行", "Review run")}</h1>
          <p>${copy("检查机器人和动作顺序。", "Review the robot and action order.")}</p>
        </div>
      </div>
      <div class="review-panel">
        <div class="review-robot">
          <div>
            <strong>${displayName(robot.teminame, copy("未命名机器人", "Unnamed robot"))}</strong>
            <p>${escapeHtml(robot.serialNumber)}${discoveryState.status.receivedAt === null ? "" : copy(` · 状态更新于 ${formatClock(discoveryState.status.receivedAt)}`, ` · Status updated at ${formatClock(discoveryState.status.receivedAt)}`)}</p>
          </div>
          ${renderStatusPill(status, preflighting)}
        </div>
        <ol class="review-list">
          ${composerState.actions.map((action, index) => `
            <li class="review-item">
              <span class="sequence-number">${index + 1}</span>
              <div><strong>${actionLabel(action.type)}</strong><p>${escapeHtml(actionSummary(action, composerState.context))}</p></div>
              <span class="status-pill">${copy("已检查", "Checked")}</span>
            </li>
          `).join("")}
        </ol>
      </div>
      ${renderReviewCheck(snapshot, status)}
      ${statusTone === "error" && !blocked && !preflightFailed ? renderStatusNotice() : ""}
      <div class="stage-actions">
        <button class="button ghost" type="button" data-back-actions ${preflighting || confirmationRequired ? "disabled" : ""}>
          <span aria-hidden="true">←</span> ${copy("返回修改", "Back to edit")}
        </button>
        <button class="button primary" type="button" data-prepare-play ${preflighting || confirmationRequired ? "disabled" : ""}>${primaryLabel}</button>
      </div>
    </section>
  `;
}

function renderReviewCheck(snapshot: LifecycleSnapshot | undefined, status: RobotStatus["status"] | undefined): string {
  if (snapshot?.phase === "preflighting") {
    return `<div class="review-check neutral"><span class="loading-dot" aria-hidden="true"></span><span>${copy("正在刷新机器人状态…", "Refreshing robot status…")}</span></div>`;
  }
  if (snapshot?.phase === "blocked") {
    return `<div class="review-check blocked"><span class="check-mark">!</span><span>${copy(`机器人当前${statusLabelFor(status, "zh")}，暂时无法运行。`, `The robot is currently ${statusLabelFor(status, "en")} and cannot run yet.`)}</span></div>`;
  }
  if (snapshot?.phase === "failed") {
    return `<div class="review-check blocked"><span class="check-mark">!</span><span>${copy("状态检查失败，请重试。", "The status check failed. Try again.")}</span></div>`;
  }
  return `<div class="review-check"><span class="check-mark">✓</span><span>${copy("动作已检查，运行前会再次确认机器人在线。", "Actions are checked. Robot availability will be confirmed again before running.")}</span></div>`;
}

function renderPlayConfirmation(): string {
  const snapshot = lifecycle?.state;
  const composerState = composer?.state;
  const robot = discovery?.state.selectedRobot;
  if (snapshot?.phase !== "confirmation_required" || composerState === undefined || robot === null || robot === undefined) {
    return "";
  }
  const hasSafetySensitiveAction = composerState.actions.some((action) => action.type === "MOVEMENT" || action.type === "START_CALL");
  const actionOrder = composerState.actions.map((action) => actionLabel(action.type)).join(" → ");
  return `
    <div class="modal-backdrop">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">${copy("确认运行", "Confirm run")}</h2>
        <div class="modal-summary">
          <div><span>${copy("环境", "Environment")}</span><strong>${environmentLabel(environment)}</strong></div>
          <div><span>${copy("机器人", "Robot")}</span><strong>${displayName(robot.teminame, copy("未命名机器人", "Unnamed robot"))}</strong></div>
          <div><span>${copy("动作", "Actions")}</span><strong>${copy(`${composerState.actions.length} 个`, `${composerState.actions.length}`)} · ${actionOrder}</strong></div>
          <div><span>${copy("当前状态", "Current status")}</span><strong>${statusLabel(snapshot.latestStatus?.status)}</strong></div>
        </div>
        <p class="safety-note">${copy("将控制真实机器人。", "This will control a real robot.")}${hasSafetySensitiveAction ? copy("确认移动路径安全，且呼叫对象已经知情。", " Confirm the route is safe and call recipients have been informed.") : ""}</p>
        <div class="modal-actions">
          <button class="button" type="button" data-cancel-play>${copy("返回修改", "Back to edit")}</button>
          <button class="button primary" type="button" data-confirm-play>${copy("确认运行", "Confirm run")}</button>
        </div>
      </section>
    </div>
  `;
}

function renderRunning(): string {
  const snapshot = lifecycle?.state;
  const composerState = composer?.state;
  const robot = discovery?.state.selectedRobot;
  if (snapshot === undefined || composerState === undefined || robot === null || robot === undefined) {
    return renderLoadingPanel(copy("正在读取运行状态…", "Loading run status…"));
  }

  const title = runningTitle(snapshot);
  const subtitle = runningSubtitle(snapshot);
  const canStop = snapshot.identity !== null && snapshot.identity.sequenceId !== null &&
    ["running", "unknown"].includes(snapshot.phase) && !snapshot.stopPending;
  const terminal = snapshot.phase === "terminal";
  const failed = snapshot.phase === "failed";

  return `
    <section class="stage" aria-labelledby="running-title">
      <div class="stage-head">
        <div>
          <h1 id="running-title">${title}</h1>
          <p>${subtitle}</p>
        </div>
        ${renderRunBadge(snapshot)}
      </div>
      <div class="run-panel">
        <div class="run-hero">
          <div>
            <strong>${displayName(robot.teminame, copy("未命名机器人", "Unnamed robot"))}</strong>
            <p>${escapeHtml(robot.serialNumber)}</p>
          </div>
          ${renderStatusPill(snapshot.latestStatus?.status ?? discovery?.state.status.data?.status, snapshot.pollInFlight)}
        </div>
        <ol class="run-list">
          ${composerState.actions.map((action, index) => renderRunItem(action, index, composerState.context, snapshot)).join("")}
        </ol>
      </div>
      ${snapshot.warning === null ? "" : renderInlineNotice(localizeRuntimeText(snapshot.warning), "error")}
      ${snapshot.error === null || snapshot.warning !== null ? "" : renderInlineNotice(lifecycleErrorText(snapshot), "error")}
      ${statusTone === "error" && snapshot.warning === null && snapshot.error === null ? renderStatusNotice() : ""}
      <div class="stage-actions">
        <span></span>
        ${canStop
          ? `<button class="button danger stage-actions-end" type="button" data-stop-run>${snapshot.stopPending ? copy("正在停止…", "Stopping…") : copy("停止运行", "Stop run")}</button>`
          : terminal
            ? `<button class="button primary stage-actions-end" type="button" data-run-again>${copy("再次运行", "Run again")}</button>`
            : failed
              ? `<button class="button primary stage-actions-end" type="button" data-reset>${copy("重新开始", "Start over")}</button>`
              : ""}
      </div>
    </section>
  `;
}

function renderRunItem(
  action: SequenceActionDraft,
  index: number,
  context: ComposerContext | null,
  snapshot: LifecycleSnapshot,
): string {
  const submitted = ["running", "stopping", "unknown", "terminal"].includes(snapshot.phase);
  const status = snapshot.phase === "terminal"
    ? copy("序列已结束", "Sequence ended")
    : submitted
      ? copy("已提交", "Submitted")
      : copy("等待中", "Waiting");
  const className = submitted ? "active" : "waiting";
  const marker = String(index + 1);
  return `
    <li class="run-item ${className}">
      <span class="run-mark">${marker}</span>
      <div><strong>${actionLabel(action.type)}</strong><p>${escapeHtml(actionSummary(action, context))}</p></div>
      <span class="status-pill">${status}</span>
    </li>
  `;
}

function renderRunBadge(snapshot: LifecycleSnapshot): string {
  if (snapshot.phase === "running") return `<span class="run-status"><span class="pulse"></span>${copy("运行中", "Running")}</span>`;
  const success = snapshot.phase === "terminal" && snapshot.observation === "completed";
  return `<span class="status-pill ${success ? "online" : ""}">${lifecyclePhaseLabel(snapshot.phase)}</span>`;
}

function renderStatusPill(status: RobotStatus["status"] | undefined, loading = false): string {
  if (loading) return `<span class="status-pill"><span class="loading-dot"></span>${copy("读取中", "Loading")}</span>`;
  const className = status === "online" ? "online" : status === "busy" || status === "privacy" ? "busy" : "";
  return `<span class="status-pill ${className}">${statusLabel(status)}</span>`;
}

function renderLoadingPanel(message: string): string {
  return `<div class="loading-panel" role="status"><span class="loading-dot"></span><span>${escapeHtml(message)}</span></div>`;
}

function renderStatusNotice(): string {
  if (statusMessage.trim().length === 0) return "";
  return renderInlineNotice(localizeRuntimeText(statusMessage), statusTone);
}

function renderInlineNotice(message: string, tone: StatusTone): string {
  return `<p class="inline-notice ${tone}" role="${tone === "error" ? "alert" : "status"}">${escapeHtml(message)}</p>`;
}

function bindEvents(): void {
  app.querySelector<HTMLButtonElement>("[data-language-toggle]")?.addEventListener("click", () => {
    languageMenuOpen = !languageMenuOpen;
    render();
  });

  app.querySelectorAll<HTMLButtonElement>("[data-language]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextLanguage = button.dataset.language;
      if (!isLanguage(nextLanguage)) return;
      language = nextLanguage;
      languageMenuOpen = false;
      render();
    });
  });

  app.querySelector<HTMLSelectElement>("[data-environment]")?.addEventListener("change", (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (!isEnvironment(value)) return;
    environment = value;
    resetPage("");
  });

  app.querySelector<HTMLFormElement>("[data-connection-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    connectAndVerify();
  });

  app.querySelectorAll<HTMLButtonElement>("[data-robot-card]").forEach((button) => {
    button.addEventListener("click", () => {
      pendingRobotSerialNumber = button.dataset.robotCard ?? null;
      statusMessage = "";
      render();
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-robot-status-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const serialNumber = button.dataset.robotStatusToggle;
      if (serialNumber !== undefined) toggleRobotStatus(serialNumber);
    });
  });

  app.querySelector<HTMLButtonElement>("[data-filter-online]")?.addEventListener("click", () => {
    if (!robotStatusesRefreshed) return;
    robotStatusFilter = robotStatusFilter === "online" ? "all" : "online";
    if (
      robotStatusFilter === "online" &&
      pendingRobotSerialNumber !== null &&
      !isRobotOnline(pendingRobotSerialNumber)
    ) {
      pendingRobotSerialNumber = null;
    }
    render();
  });

  app.querySelector<HTMLButtonElement>("[data-refresh-all-statuses]")?.addEventListener("click", () => {
    void refreshAllRobotStatuses();
  });

  app.querySelector<HTMLButtonElement>("[data-continue-robot]")?.addEventListener("click", () => {
    if (pendingRobotSerialNumber !== null) selectRobot(pendingRobotSerialNumber);
  });

  app.querySelector<HTMLButtonElement>("[data-back-robot]")?.addEventListener("click", () => {
    const selectedSerial = discovery?.state.selectedRobot?.serialNumber ?? null;
    if (selectedSerial !== null) pendingRobotSerialNumber = selectedSerial;
    selectRobot("");
  });

  app.querySelector<HTMLButtonElement>("[data-refresh-status]")?.addEventListener("click", refreshStatus);
  app.querySelector<HTMLButtonElement>("[data-refresh-resources]")?.addEventListener("click", refreshRobotResources);

  app.querySelector<HTMLButtonElement>("[data-toggle-add-menu]")?.addEventListener("click", () => {
    addActionMenuOpen = !addActionMenuOpen;
    actionMenuId = null;
    render();
  });

  app.querySelectorAll<HTMLButtonElement>("[data-add-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const type = button.dataset.addAction;
      if (!isSequenceActionType(type) || composer === null) return;
      try {
        composer.addAction(type);
        addActionMenuOpen = false;
        statusMessage = "";
        render();
      } catch (error: unknown) {
        handleComposerError(error, "添加动作");
      }
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-toggle-action-menu]").forEach((button) => {
    button.addEventListener("click", () => {
      const actionId = button.dataset.toggleActionMenu ?? null;
      actionMenuId = actionMenuId === actionId ? null : actionId;
      addActionMenuOpen = false;
      render();
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-remove-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const actionId = button.dataset.actionId;
      if (composer === null || actionId === undefined) return;
      try {
        composer.removeAction(actionId);
        actionMenuId = null;
        statusMessage = "";
        render();
      } catch (error: unknown) {
        handleComposerError(error, "删除动作");
      }
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-move-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const actionId = button.dataset.actionId;
      const direction = button.dataset.moveAction;
      if (composer === null || actionId === undefined || !isMoveDirection(direction)) return;
      try {
        composer.moveAction(actionId, direction);
        actionMenuId = null;
        statusMessage = "";
        render();
      } catch (error: unknown) {
        handleComposerError(error, "调整顺序");
      }
    });
  });

  bindDragAndDrop();

  app.querySelectorAll<HTMLSelectElement>('[data-action-field="location"]').forEach((select) => {
    select.addEventListener("change", () => {
      const actionId = select.dataset.actionId;
      if (composer === null || actionId === undefined) return;
      try {
        statusMessage = "";
        composer.setMovementLocation(actionId, select.value);
      } catch (error: unknown) {
        handleComposerError(error, "修改位置");
      }
    });
  });

  app.querySelectorAll<HTMLTextAreaElement>('[data-action-field="tts"]').forEach((textarea) => {
    textarea.addEventListener("change", () => {
      const actionId = textarea.dataset.actionId;
      if (composer === null || actionId === undefined) return;
      try {
        statusMessage = "";
        composer.setSpeakText(actionId, textarea.value);
      } catch (error: unknown) {
        handleComposerError(error, "修改播报");
      }
    });
  });

  app.querySelectorAll<HTMLInputElement>("[data-action-contact]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const actionId = checkbox.dataset.actionId;
      if (composer === null || actionId === undefined) return;
      const contactIds = Array.from(app.querySelectorAll<HTMLInputElement>("[data-action-contact]"))
        .filter((candidate) => candidate.dataset.actionId === actionId && candidate.checked)
        .map((candidate) => candidate.value);
      try {
        statusMessage = "";
        composer.setCallContacts(actionId, contactIds);
      } catch (error: unknown) {
        handleComposerError(error, "修改联系人");
      }
    });
  });

  app.querySelector<HTMLButtonElement>("[data-validate-sequence]")?.addEventListener("click", validateSequence);

  app.querySelector<HTMLButtonElement>("[data-back-actions]")?.addEventListener("click", () => {
    lifecycle?.cancelPreparation();
    lifecycle?.dispose();
    lifecycle = null;
    editingValidatedSequence = true;
    statusMessage = "";
    render();
  });

  app.querySelector<HTMLButtonElement>("[data-prepare-play]")?.addEventListener("click", preparePlay);

  app.querySelector<HTMLButtonElement>("[data-cancel-play]")?.addEventListener("click", () => {
    lifecycle?.cancelPreparation();
    lifecycle?.dispose();
    lifecycle = null;
    editingValidatedSequence = true;
    statusMessage = "";
    render();
  });

  app.querySelector<HTMLButtonElement>("[data-confirm-play]")?.addEventListener("click", confirmPlay);
  app.querySelector<HTMLButtonElement>("[data-stop-run]")?.addEventListener("click", stopRun);

  app.querySelector<HTMLButtonElement>("[data-run-again]")?.addEventListener("click", () => {
    lifecycle?.dispose();
    lifecycle = null;
    editingValidatedSequence = false;
    statusMessage = "";
    render();
  });

  app.querySelectorAll<HTMLButtonElement>("[data-reset]").forEach((button) => {
    button.addEventListener("click", () => resetPage(""));
  });
}

function bindDragAndDrop(): void {
  app.querySelectorAll<HTMLElement>("[data-action-card]").forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      draggedActionId = card.dataset.actionId ?? null;
      card.classList.add("dragging");
      if (event.dataTransfer !== null) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedActionId ?? "");
      }
    });
    card.addEventListener("dragend", () => {
      draggedActionId = null;
      card.classList.remove("dragging");
    });
    card.addEventListener("dragover", (event) => {
      if (draggedActionId === null) return;
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
    });
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      const targetId = card.dataset.actionId;
      if (composer === null || draggedActionId === null || targetId === undefined || draggedActionId === targetId) return;
      moveActionTo(draggedActionId, targetId);
      draggedActionId = null;
    });
  });
}

function moveActionTo(actionId: string, targetId: string): void {
  const currentComposer = composer;
  if (currentComposer === null) return;
  try {
    let from = currentComposer.state.actions.findIndex((action) => action.id === actionId);
    const to = currentComposer.state.actions.findIndex((action) => action.id === targetId);
    if (from < 0 || to < 0) return;
    while (from < to) {
      currentComposer.moveAction(actionId, "down");
      from += 1;
    }
    while (from > to) {
      currentComposer.moveAction(actionId, "up");
      from -= 1;
    }
    actionMenuId = null;
    statusMessage = "";
    render();
  } catch (error: unknown) {
    handleComposerError(error, "调整顺序");
  }
}

function toggleRobotStatus(serialNumber: string): void {
  const requestClient = client;
  const requestDiscovery = discovery;
  const knownRobot = requestDiscovery?.state.robots.data?.some(
    (robot) => robot.serialNumber === serialNumber,
  ) === true;
  if (requestClient === null || requestDiscovery === null || !knownRobot) return;

  const current = robotStatusPanels.get(serialNumber) ?? {
    expanded: false,
    requestState: "idle",
    data: null,
    receivedAt: null,
    error: null,
    requestId: 0,
  } satisfies RobotStatusPanelState;

  if (current.expanded) {
    robotStatusPanels.set(serialNumber, { ...current, expanded: false });
    render();
    return;
  }
  if (current.requestState === "pending") {
    robotStatusPanels.set(serialNumber, { ...current, expanded: true });
    render();
    return;
  }

  const requestId = nextRobotStatusRequestId++;
  robotStatusPanels.set(serialNumber, {
    ...current,
    expanded: true,
    requestState: "pending",
    error: null,
    requestId,
  });
  render();

  void orchestrator.execute(
    {
      phase: runState.phase,
      operation: "getRobotStatus",
      requestSummary: { serialNumber },
    },
    (options) => requestClient.getRobotStatus(serialNumber, options),
  ).then((status) => {
    if (client !== requestClient || discovery !== requestDiscovery) return;
    const latest = robotStatusPanels.get(serialNumber);
    if (latest?.requestId !== requestId) return;
    robotStatusPanels.set(serialNumber, {
      ...latest,
      requestState: "succeeded",
      data: status,
      receivedAt: Date.now(),
      error: null,
    });
    render();
  }).catch((error: unknown) => {
    if (client !== requestClient || discovery !== requestDiscovery) return;
    const latest = robotStatusPanels.get(serialNumber);
    if (latest?.requestId !== requestId) return;
    if (error instanceof TemiApiError && error.kind === "unauthorized") {
      expireRobotStatusConnection(requestClient, requestDiscovery);
      return;
    }
    robotStatusPanels.set(serialNumber, {
      ...latest,
      requestState: "failed",
      error: robotStatusErrorText(error),
    });
    render();
  });
}

async function refreshAllRobotStatuses(): Promise<void> {
  const requestClient = client;
  const requestDiscovery = discovery;
  const robots = requestDiscovery?.state.robots.data ?? [];
  if (
    requestClient === null ||
    requestDiscovery === null ||
    robots.length === 0 ||
    robotStatusesRefreshing
  ) {
    return;
  }

  robotStatusesRefreshing = true;
  statusMessage = "";
  const phase = runState.phase;
  const requests = robots.map((robot) => {
    const current = robotStatusPanels.get(robot.serialNumber) ?? {
      expanded: false,
      requestState: "idle",
      data: null,
      receivedAt: null,
      error: null,
      requestId: 0,
    } satisfies RobotStatusPanelState;
    const requestId = nextRobotStatusRequestId++;
    robotStatusPanels.set(robot.serialNumber, {
      ...current,
      requestState: "pending",
      error: null,
      requestId,
    });

    return orchestrator.execute(
      {
        phase,
        operation: "getRobotStatus",
        requestSummary: { serialNumber: robot.serialNumber },
      },
      (options) => requestClient.getRobotStatus(robot.serialNumber, options),
    ).then((status) => {
      if (client !== requestClient || discovery !== requestDiscovery) return;
      const latest = robotStatusPanels.get(robot.serialNumber);
      if (latest?.requestId !== requestId) return;
      robotStatusPanels.set(robot.serialNumber, {
        ...latest,
        requestState: "succeeded",
        data: status,
        receivedAt: Date.now(),
        error: null,
      });
    }).catch((error: unknown) => {
      if (client !== requestClient || discovery !== requestDiscovery) return;
      const latest = robotStatusPanels.get(robot.serialNumber);
      if (latest?.requestId !== requestId) return;
      if (error instanceof TemiApiError && error.kind === "unauthorized") {
        expireRobotStatusConnection(requestClient, requestDiscovery);
        return;
      }
      robotStatusPanels.set(robot.serialNumber, {
        ...latest,
        requestState: "failed",
        error: robotStatusErrorText(error),
      });
    });
  });

  render();
  await Promise.all(requests);
  if (client !== requestClient || discovery !== requestDiscovery) return;

  robotStatusesRefreshing = false;
  robotStatusesRefreshed = true;
  if (
    robotStatusFilter === "online" &&
    pendingRobotSerialNumber !== null &&
    !isRobotOnline(pendingRobotSerialNumber)
  ) {
    pendingRobotSerialNumber = null;
  }
  const failed = robots.some((robot) => robotStatusPanels.get(robot.serialNumber)?.requestState === "failed");
  statusMessage = failed ? "部分机器人状态读取失败。" : "";
  statusTone = failed ? "error" : "success";
  render();
}

function expireRobotStatusConnection(
  requestClient: TemiApiClient,
  requestDiscovery: RobotDiscoveryController,
): void {
  if (client !== requestClient || discovery !== requestDiscovery) return;
  orchestrator.abortReads();
  lifecycle?.dispose();
  lifecycle = null;
  discovery = null;
  composer = null;
  clearConnection();
  runState = createRunState();
  statusMessage = "连接已失效，请重新连接。";
  statusTone = "error";
  render();
}

function connectAndVerify(): void {
  if (runState.phase !== "idle") return;
  if (environmentTransport[environment] === "blocked") {
    statusMessage = "当前环境无法连接，请重新开始。";
    statusTone = "error";
    render();
    return;
  }

  const input = app.querySelector<HTMLInputElement>("[data-oat]");
  const oat = input?.value.trim() ?? "";
  if (oat.length === 0) {
    statusMessage = "请输入访问令牌。";
    statusTone = "error";
    render();
    return;
  }

  if (input !== null) input.value = "";
  const selectedEnvironment = environment;
  const requestClient = new TemiApiClient(selectedEnvironment, oat, {
    onReadableResponse: () => markEnvironmentReadable(selectedEnvironment),
    onTransportFailure: () => markEnvironmentBlocked(selectedEnvironment),
  });
  client = requestClient;
  const requestDiscovery = new RobotDiscoveryController(requestClient, orchestrator, {
    onChange: (state) => {
      if (client !== requestClient) return;
      syncComposerContext(state);
      render();
    },
  });
  discovery = requestDiscovery;
  runState = transitionRunState(runState, "verifying");
  statusMessage = "正在验证连接…";
  statusTone = "neutral";
  const connection = requestDiscovery.connect(() => {
    if (client !== requestClient) return;
    runState = transitionRunState(runState, "discovering");
    statusMessage = "正在读取机器人…";
    statusTone = "neutral";
  });
  render();

  void connection.then((state) => {
    if (client !== requestClient) return;
    const robotCount = state.robots.data?.length ?? 0;
    if (robotCount === 0) {
      runState = transitionRunState(runState, "failed");
      statusMessage = "没有可用的机器人。";
      statusTone = "error";
    } else {
      statusMessage = "";
      statusTone = "success";
    }
    render();
  }).catch((error: unknown) => {
    if (client !== requestClient) return;
    if (runState.phase === "verifying" || runState.phase === "discovering") {
      runState = transitionRunState(runState, "failed");
    }
    const unauthorized = error instanceof TemiApiError && error.kind === "unauthorized";
    discovery = unauthorized ? null : requestDiscovery;
    clearConnection();
    statusMessage = connectionErrorText(error);
    statusTone = "error";
    render();
  });
}

function selectRobot(serialNumber: string): void {
  const requestDiscovery = discovery;
  const requestClient = client;
  if (requestDiscovery === null || requestClient === null) return;
  if (isLifecycleLocked() || runState.phase === "validating") return;

  if (serialNumber.length === 0) {
    robotResourcesLoading = false;
    requestDiscovery.clearSelection();
    if (runState.phase === "ready") runState = transitionRunState(runState, "composing");
    editingValidatedSequence = false;
    addActionMenuOpen = false;
    actionMenuId = null;
    statusMessage = "";
    render();
    return;
  }

  if (runState.phase === "ready") runState = transitionRunState(runState, "composing");
  const phase = runState.phase;
  pendingRobotSerialNumber = serialNumber;
  robotResourcesLoading = true;
  editingValidatedSequence = false;
  statusMessage = "正在读取机器人资源…";
  statusTone = "neutral";
  render();

  void requestDiscovery.selectRobot(serialNumber, phase).then((state) => {
    if (client !== requestClient || discovery !== requestDiscovery) return;
    robotResourcesLoading = false;
    if (runState.phase === "discovering") runState = transitionRunState(runState, "composing");
    const failedResources = [state.status, state.locations, state.contacts].filter((slot) => slot.status === "failed").length;
    statusMessage = failedResources === 0 ? "" : "部分资源读取失败，可重新读取。";
    statusTone = failedResources === 0 ? "success" : "error";
    render();
  }).catch((error: unknown) => {
    handleDiscoveryError(error, requestClient, requestDiscovery, "读取机器人");
  });
}

function refreshRobotResources(): void {
  const serialNumber = discovery?.state.selectedRobot?.serialNumber;
  if (serialNumber !== undefined) selectRobot(serialNumber);
}

function refreshStatus(): void {
  const requestDiscovery = discovery;
  const requestClient = client;
  if (requestDiscovery === null || requestClient === null || requestDiscovery.state.selectedRobot === null) return;
  if (isLifecycleLocked()) return;
  statusMessage = "正在刷新状态…";
  statusTone = "neutral";
  render();

  void requestDiscovery.refreshStatus(runState.phase).then((state) => {
    if (client !== requestClient || discovery !== requestDiscovery) return;
    statusMessage = state.status.status === "succeeded" ? "" : "状态刷新失败。";
    statusTone = state.status.status === "succeeded" ? "success" : "error";
    render();
  }).catch((error: unknown) => {
    handleDiscoveryError(error, requestClient, requestDiscovery, "刷新状态");
  });
}

function preparePlay(): void {
  const currentComposer = composer;
  const requestClient = client;
  const requestDiscovery = discovery;
  if (currentComposer === null || requestClient === null || requestDiscovery === null) return;
  if (environmentTransport[environment] === "blocked") {
    statusMessage = "当前环境无法连接，不能运行。";
    statusTone = "error";
    render();
    return;
  }
  if (!(runState.phase === "ready" || runState.phase === "terminal") || isLifecycleLocked()) return;

  const request = currentComposer.getValidatedRequest();
  if (request === null) {
    statusMessage = "请先检查动作。";
    statusTone = "error";
    render();
    return;
  }

  lifecycle?.dispose();
  let instance!: PlayPollStopLifecycle;
  instance = new PlayPollStopLifecycle({
    client: requestClient,
    environment,
    orchestrator,
    onChange: (snapshot) => {
      if (lifecycle !== instance) return;
      syncRunStateFromLifecycle(snapshot);
      render();
    },
    onStatus: (status) => {
      if (lifecycle !== instance || discovery !== requestDiscovery) return;
      requestDiscovery.recordStatusSnapshot(status);
    },
    onWarning: (message) => {
      if (lifecycle !== instance) return;
      statusMessage = message;
      statusTone = "error";
      render();
    },
  });
  lifecycle = instance;
  editingValidatedSequence = false;
  statusMessage = "正在刷新机器人状态…";
  statusTone = "neutral";
  render();

  void instance.preparePlay(request).then((snapshot) => {
    if (lifecycle !== instance) return;
    if (snapshot.phase === "confirmation_required") {
      statusMessage = "";
      statusTone = "success";
    } else {
      statusMessage = `机器人当前${statusLabelFor(snapshot.latestStatus?.status, "zh")}，暂时无法运行。`;
      statusTone = "error";
    }
    render();
  }).catch((error: unknown) => {
    handleLifecycleError(error, instance, requestClient, "状态检查");
  });
}

function confirmPlay(): void {
  const instance = lifecycle;
  const requestClient = client;
  if (instance === null || requestClient === null || instance.state.phase !== "confirmation_required") return;
  if (environmentTransport[environment] === "blocked") {
    instance.cancelPreparation();
    instance.dispose();
    lifecycle = null;
    statusMessage = "当前环境无法连接，不能运行。";
    statusTone = "error";
    render();
    return;
  }
  statusMessage = "正在启动…";
  statusTone = "neutral";
  render();

  void instance.confirmPlay().then((snapshot) => {
    if (lifecycle !== instance) return;
    statusMessage = snapshot.phase === "running" ? "" : "未能启动运行。";
    statusTone = snapshot.phase === "running" ? "success" : "error";
    render();
  }).catch((error: unknown) => {
    handleLifecycleError(error, instance, requestClient, "启动运行");
  });
}

function stopRun(): void {
  const instance = lifecycle;
  const requestClient = client;
  if (instance === null || requestClient === null) return;
  statusMessage = "正在停止…";
  statusTone = "neutral";
  render();

  void instance.stop().then((snapshot) => {
    if (lifecycle !== instance) return;
    statusMessage = snapshot.phase === "stopping" ? "" : "停止请求未被确认。";
    statusTone = snapshot.phase === "stopping" ? "success" : "error";
    render();
  }).catch((error: unknown) => {
    handleLifecycleError(error, instance, requestClient, "停止运行");
  });
}

function validateSequence(): void {
  const currentComposer = composer;
  const requestClient = client;
  if (currentComposer === null || requestClient === null || isLifecycleLocked()) return;

  if (currentComposer.state.validation.status === "succeeded" && (runState.phase === "ready" || runState.phase === "terminal")) {
    editingValidatedSequence = false;
    statusMessage = "";
    render();
    return;
  }
  if (runState.phase === "validating") return;
  if (!(runState.phase === "composing" || runState.phase === "terminal")) return;

  const inspection = currentComposer.inspect();
  if (!inspection.valid) {
    statusMessage = "请修正标出的内容。";
    statusTone = "error";
    void currentComposer.validate(requestClient, orchestrator);
    render();
    return;
  }

  runState = transitionRunState(runState, "validating");
  statusMessage = "正在检查动作…";
  statusTone = "neutral";
  render();

  void currentComposer.validate(requestClient, orchestrator).then((validation) => {
    if (composer !== currentComposer || client !== requestClient || runState.phase !== "validating") return;
    if (validation.status === "succeeded") {
      runState = transitionRunState(runState, "ready");
      editingValidatedSequence = false;
      statusMessage = "";
      statusTone = "success";
    } else {
      runState = transitionRunState(runState, "composing");
      statusMessage = "请修正标出的内容。";
      statusTone = "error";
    }
    render();
  }, (error: unknown) => {
    if (composer !== currentComposer || client !== requestClient) return;
    if (runState.phase === "validating") runState = transitionRunState(runState, "composing");
    if (error instanceof TemiApiError && error.kind === "unauthorized") {
      requestClient.clearToken();
      composer = null;
      discovery = null;
      clearConnection();
      runState = createRunState();
      statusMessage = "连接已失效，请重新连接。";
    } else {
      statusMessage = "动作检查失败，请修正后重试。";
    }
    statusTone = "error";
    render();
  });
}

function syncComposerContext(state: DiscoveryState): void {
  const selectedRobot = state.selectedRobot;
  if (selectedRobot === null) {
    composer = null;
    return;
  }

  if (composer === null) {
    let instance!: SequenceComposer;
    instance = new SequenceComposer({
      onChange: (composerState) => {
        if (composer !== instance) return;
        if (["ready", "terminal"].includes(runState.phase) && composerState.validation.status !== "succeeded") {
          runState = transitionRunState(runState, "composing");
        }
        render();
      },
    });
    composer = instance;
  }

  const context: ComposerContext = {
    environment,
    serialNumber: selectedRobot.serialNumber,
    locations: state.locations.status === "succeeded" ? locationOptions(state) : null,
    contacts: state.contacts.status === "succeeded" ? contactOptions(state) : null,
  };
  try {
    composer.setContext(context);
  } catch (error: unknown) {
    if (!(error instanceof SequenceComposerError && error.kind === "validation_pending")) throw error;
  }
}

function syncRunStateFromLifecycle(snapshot: LifecycleSnapshot): void {
  const identity = snapshot.identity;
  try {
    if (snapshot.phase === "starting" && ["ready", "terminal"].includes(runState.phase) && identity !== null) {
      runState = beginRun(runState, identity.serialNumber);
    } else if (snapshot.phase === "running" && identity !== null && identity.sequenceId !== null) {
      if (runState.phase === "starting") runState = acceptRun(runState, identity.sequenceId);
      else if (runState.phase === "unknown") runState = recoverUnknown(runState);
      else if (runState.phase === "stopping") runState = transitionRunState(runState, "running");
    } else if (snapshot.phase === "stopping" && ["running", "unknown"].includes(runState.phase)) {
      runState = requestStop(runState);
    } else if (snapshot.phase === "terminal" && ["running", "stopping", "unknown"].includes(runState.phase)) {
      runState = transitionRunState(runState, "terminal");
    } else if (snapshot.phase === "unknown" && ["starting", "running", "stopping"].includes(runState.phase)) {
      runState = transitionRunState(runState, "unknown");
    } else if (snapshot.phase === "failed" && runState.phase === "starting") {
      runState = transitionRunState(runState, "failed");
    }
  } catch (error: unknown) {
    statusMessage = error instanceof Error ? error.message : "运行状态异常。";
    statusTone = "error";
  }
}

function handleLifecycleError(error: unknown, instance: PlayPollStopLifecycle, requestClient: TemiApiClient, operation: string): void {
  if (lifecycle !== instance) return;
  const snapshot = instance.state;
  if (error instanceof TemiApiError && error.kind === "unauthorized") {
    requestClient.clearToken();
    statusMessage = snapshot.warning ?? "连接已失效，访问令牌已清除。";
    if (snapshot.phase === "failed") {
      composer = null;
      discovery = null;
      clearConnection();
      if (runState.phase === "ready") runState = transitionRunState(runState, "failed");
    }
  } else if (snapshot.warning !== null) {
    statusMessage = snapshot.warning;
  } else {
    statusMessage = `${operation}失败；不会自动重试运行或停止请求。`;
  }
  statusTone = "error";
  render();
}

function handleComposerError(error: unknown, operation: string): void {
  statusMessage = error instanceof SequenceComposerError && error.kind === "resource_unavailable"
    ? "所需资源尚不可用。"
    : `${operation}失败。`;
  statusTone = "error";
  render();
}

function handleDiscoveryError(
  error: unknown,
  requestClient: TemiApiClient,
  requestDiscovery: RobotDiscoveryController,
  operation: string,
): void {
  if (client !== requestClient || discovery !== requestDiscovery) return;
  if (error instanceof RobotSelectionError) {
    robotResourcesLoading = false;
    statusMessage = "请选择列表中的机器人。";
    statusTone = "error";
    render();
    return;
  }
  if (error instanceof TemiApiError && error.kind === "unauthorized") {
    robotResourcesLoading = false;
    requestClient.clearToken();
    discovery = null;
    clearConnection();
    runState = createRunState();
    statusMessage = "连接已失效，请重新连接。";
  } else {
    robotResourcesLoading = false;
    statusMessage = `${operation}失败：${failureText(discoveryFailure(error))}`;
  }
  statusTone = "error";
  render();
}

function resetPage(message: string): void {
  orchestrator.abortReads();
  lifecycle?.dispose();
  lifecycle = null;
  discovery = null;
  composer = null;
  clearConnection();
  runState = createRunState();
  environmentTransport = { production: "unknown", integration: "unknown" };
  pendingRobotSerialNumber = null;
  robotResourcesLoading = false;
  editingValidatedSequence = false;
  addActionMenuOpen = false;
  actionMenuId = null;
  draggedActionId = null;
  timeline.clear();
  statusMessage = message;
  statusTone = "neutral";
  render();
}

function clearConnection(): void {
  const input = app.querySelector<HTMLInputElement>("[data-oat]");
  if (input !== null) input.value = "";
  client?.clearToken();
  client = null;
  robotStatusPanels.clear();
  robotStatusFilter = "all";
  robotStatusesRefreshed = false;
  robotStatusesRefreshing = false;
  pendingRobotSerialNumber = null;
}

function isLifecycleLocked(): boolean {
  const phase = lifecycle?.state.phase;
  return hasActiveRun(runState) || (
    phase !== undefined && ["preflighting", "confirmation_required", "starting", "running", "stopping", "unknown"].includes(phase)
  );
}

function locationOptions(state: DiscoveryState): readonly ComposerOption[] {
  return (state.locations.data?.locations ?? []).flatMap((location) => {
    if (!isNonEmptyText(location.name)) return [];
    return [{ value: location.name, label: location.name }];
  });
}

function contactOptions(state: DiscoveryState): readonly ComposerOption[] {
  return (state.contacts.data?.contacts ?? []).flatMap((contact) => {
    if (!isNonEmptyText(contact.temiId)) return [];
    return [{ value: contact.temiId, label: isNonEmptyText(contact.name) ? contact.name : copy("未命名联系人", "Unnamed contact") }];
  });
}

function actionValidationIssue(state: SequenceComposerState, actionId: string): string | null {
  const issue = state.validation.issues.find((candidate) => candidate.actionId === actionId);
  return issue === undefined ? null : validationIssueText(issue.field);
}

function validationIssueText(field: "sequence" | "location" | "tts" | "contactIds" | "step"): string {
  if (field === "location") return copy("请选择位置。", "Select a location.");
  if (field === "tts") return copy("请输入播报内容。", "Enter text for the robot to speak.");
  if (field === "contactIds") return copy("请选择至少一位联系人。", "Select at least one contact.");
  if (field === "step") return copy("动作顺序无效。", "The action order is invalid.");
  return copy("至少添加一个动作。", "Add at least one action.");
}

function validationErrorText(error: NonNullable<SequenceComposerState["validation"]["error"]>): string {
  if (error.kind === "unauthorized") return copy("连接已失效，请重新连接。", "The connection expired. Reconnect and try again.");
  if (error.kind === "network") return copy("网络请求失败，请稍后重试。", "The network request failed. Try again shortly.");
  if (error.kind === "timeout") return copy("检查超时，请稍后重试。", "The check timed out. Try again shortly.");
  if (error.kind === "http") return copy("动作未通过服务端检查，请修正后重试。", "The server rejected the actions. Fix them and try again.");
  return copy("动作检查失败，请重试。", "The action check failed. Try again.");
}

function actionAvailabilityText(state: DiscoveryState, type: SequenceActionDraft["type"]): string {
  const availability = actionAvailability(state, type);
  if (availability.enabled) return copy("可添加", "Available");
  if (type === "MOVEMENT") return copy("位置尚不可用", "Locations are not available yet");
  if (type === "START_CALL") return copy("联系人尚不可用", "Contacts are not available yet");
  return copy("暂不可用", "Not available yet");
}

function actionLabel(type: SequenceActionDraft["type"]): string {
  if (type === "MOVEMENT") return copy("前往位置", "Go to location");
  if (type === "SPEAK") return copy("播报文字", "Speak text");
  return copy("发起呼叫", "Start call");
}

function actionSummary(action: SequenceActionDraft, context: ComposerContext | null): string {
  if (action.type === "MOVEMENT") return action.location || copy("未选择位置", "No location selected");
  if (action.type === "SPEAK") return action.tts || copy("未填写内容", "No text entered");
  if (action.contactIds.length === 0) return copy("未选择联系人", "No contacts selected");
  return action.contactIds.map((id) => context?.contacts?.find((contact) => contact.value === id)?.label ?? id).join(copy("、", ", "));
}

function runningTitle(snapshot: LifecycleSnapshot): string {
  if (snapshot.phase === "starting") return copy("正在启动", "Starting");
  if (snapshot.phase === "running") return copy("正在运行", "Running");
  if (snapshot.phase === "stopping") return copy("正在停止", "Stopping");
  if (snapshot.phase === "unknown") return copy("结果未知", "Result unknown");
  if (snapshot.phase === "failed") return copy("启动失败", "Start failed");
  if (snapshot.observation === "completed") return copy("已完成", "Completed");
  if (snapshot.observation === "stopped") return copy("已停止", "Stopped");
  if (snapshot.observation === "aborted") return copy("已中止", "Aborted");
  if (snapshot.observation === "identity_mismatch") return copy("运行已变化", "Run changed");
  return copy("已结束", "Ended");
}

function runningSubtitle(snapshot: LifecycleSnapshot): string {
  if (snapshot.phase === "starting") return copy("正在等待服务接受运行。", "Waiting for the service to accept the run.");
  if (snapshot.phase === "running") return copy("正在等待机器人更新状态。", "Waiting for the robot to update its status.");
  if (snapshot.phase === "stopping") return copy("停止请求已发送，正在等待终态。", "The stop request was sent. Waiting for a final state.");
  if (snapshot.phase === "unknown") return copy("只会继续读取状态，不会自动重发运行或停止请求。", "Only status reads will continue. Run and stop requests will not be retried automatically.");
  if (snapshot.phase === "failed") return copy("运行请求未成功。", "The run request did not succeed.");
  if (snapshot.observation === "identity_mismatch") return copy("机器人返回了另一个运行标识，当前结果不能归因于本次运行。", "The robot returned a different run ID, so this result cannot be attributed to the current run.");
  return copy("本次运行已经结束。", "This run has ended.");
}

function lifecyclePhaseLabel(phase: LifecycleSnapshot["phase"]): string {
  if (phase === "starting") return copy("启动中", "Starting");
  if (phase === "running") return copy("运行中", "Running");
  if (phase === "stopping") return copy("停止中", "Stopping");
  if (phase === "terminal") return copy("已结束", "Ended");
  if (phase === "failed") return copy("失败", "Failed");
  if (phase === "unknown") return copy("未知", "Unknown");
  return copy("准备中", "Preparing");
}

function lifecycleErrorText(snapshot: LifecycleSnapshot): string {
  const error = snapshot.error;
  if (error === null) return copy("运行状态未知。", "The run status is unknown.");
  if (error.kind === "unauthorized") return copy("连接已失效，访问令牌已清除。", "The connection expired and the access token was cleared.");
  if (error.kind === "network") return copy("网络请求失败。", "The network request failed.");
  if (error.kind === "timeout") return copy("请求超时。", "The request timed out.");
  if (error.kind === "http") return copy(`请求失败（HTTP ${error.status ?? "unknown"}）。`, `Request failed (HTTP ${error.status ?? "unknown"}).`);
  return copy("请求结果未知。", "The request result is unknown.");
}

function connectionErrorText(error: unknown): string {
  if (error instanceof TemiApiError && error.kind === "unauthorized") return "访问令牌无效或已过期。";
  if (error instanceof TemiApiError && error.kind === "timeout") return "连接超时，请检查网络后重试。";
  if (error instanceof TemiApiError && error.kind === "http") return `连接被拒绝（HTTP ${error.status ?? "unknown"}）。`;
  return "连接失败，请检查网络或浏览器访问限制。";
}

function robotStatusErrorText(error: unknown): string {
  if (error instanceof TemiApiError && error.kind === "timeout") return "状态读取超时。";
  if (error instanceof TemiApiError && error.kind === "network") return "状态读取失败，请检查网络。";
  if (error instanceof TemiApiError && error.kind === "http" && error.status === 403) return "无权读取该机器人状态。";
  if (error instanceof TemiApiError && error.kind === "http") return `状态读取失败（HTTP ${error.status ?? "unknown"}）。`;
  return "状态读取失败。";
}

function robotBatteryText(status: RobotStatus): string {
  const values: string[] = [];
  if (typeof status.battery?.level === "number" && Number.isFinite(status.battery.level)) {
    values.push(`${status.battery.level}%`);
  }
  if (typeof status.battery?.isCharging === "boolean") {
    values.push(status.battery.isCharging ? copy("充电中", "Charging") : copy("未充电", "Not charging"));
  }
  return values.length === 0 ? copy("未知", "Unknown") : values.join(" · ");
}

function robotMovementText(status: RobotStatus): string {
  return compactRobotStatusValue([
    status.movement?.type,
    status.movement?.status,
    status.movement?.location,
  ]);
}

function robotSequenceText(status: RobotStatus): string {
  const step = status.sequence?.step;
  const total = status.sequence?.total;
  const progress = typeof step === "number" && typeof total === "number" ? `${step}/${total}` : undefined;
  return compactRobotStatusValue([
    status.sequence?.status,
    status.sequence?.name,
    progress,
  ]);
}

function robotCallText(status: RobotStatus): string {
  return compactRobotStatusValue([status.call?.status]);
}

function compactRobotStatusValue(values: Array<string | undefined>): string {
  const known = values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return known.length === 0 ? copy("未知", "Unknown") : known.join(" · ");
}

function failureText(failure: DiscoveryFailure | null): string {
  if (failure === null) return "请求失败。";
  if (failure.kind === "unauthorized") return "连接已失效。";
  if (failure.kind === "network") return "网络不可用。";
  if (failure.kind === "timeout") return "请求超时。";
  if (failure.kind === "http") return `HTTP ${failure.status ?? "unknown"}。`;
  return "请求失败。";
}

function statusLabel(status: RobotStatus["status"] | undefined): string {
  return statusLabelFor(status, language);
}

function statusLabelFor(status: RobotStatus["status"] | undefined, targetLanguage: Language): string {
  if (status === "online") return targetLanguage === "zh" ? "在线" : "Online";
  if (status === "busy") return targetLanguage === "zh" ? "忙碌" : "Busy";
  if (status === "offline") return targetLanguage === "zh" ? "离线" : "Offline";
  if (status === "privacy") return targetLanguage === "zh" ? "隐私模式" : "Privacy mode";
  return targetLanguage === "zh" ? "状态未知" : "Status unknown";
}

function environmentLabel(value: Environment): string {
  return value === "production" ? "Production" : "Integration";
}

function displayName(value: string | undefined, fallback: string): string {
  return escapeHtml(isNonEmptyText(value) ? value : fallback);
}

function formatClock(value: number): string {
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function markEnvironmentReadable(value: Environment): void {
  if (environmentTransport[value] === "unknown") environmentTransport[value] = "readable";
}

function markEnvironmentBlocked(value: Environment): void {
  environmentTransport[value] = "blocked";
}

function isNonEmptyText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSequenceActionType(value: string | undefined): value is SequenceActionDraft["type"] {
  return value === "MOVEMENT" || value === "SPEAK" || value === "START_CALL";
}

function isMoveDirection(value: string | undefined): value is "up" | "down" {
  return value === "up" || value === "down";
}

function isLanguage(value: string | undefined): value is Language {
  return value === "zh" || value === "en";
}

function localizeRuntimeText(value: string): string {
  if (language === "zh") return value;
  const exact = runtimeEnglish[value];
  if (exact !== undefined) return exact;

  const robotUnavailable = /^机器人当前(.+)，暂时无法运行。$/.exec(value);
  if (robotUnavailable !== null) {
    return `The robot is currently ${runtimeStatusEnglish(robotUnavailable[1])} and cannot run yet.`;
  }

  const noRetryFailure = /^(.+)失败；不会自动重试运行或停止请求。$/.exec(value);
  if (noRetryFailure !== null) {
    return `${runtimeOperationEnglish(noRetryFailure[1])} failed. Run and stop requests will not be retried automatically.`;
  }

  const detailedFailure = /^(.+)失败：(.+)$/.exec(value);
  if (detailedFailure !== null) {
    return `${runtimeOperationEnglish(detailedFailure[1])} failed: ${localizeRuntimeText(detailedFailure[2])}`;
  }

  const simpleFailure = /^(.+)失败。$/.exec(value);
  if (simpleFailure !== null) return `${runtimeOperationEnglish(simpleFailure[1])} failed.`;

  const httpFailure = /^连接被拒绝（HTTP (.+)）。$/.exec(value);
  if (httpFailure !== null) return `Connection was rejected (HTTP ${httpFailure[1]}).`;
  const statusHttpFailure = /^状态读取失败（HTTP (.+)）。$/.exec(value);
  if (statusHttpFailure !== null) return `Could not read status (HTTP ${statusHttpFailure[1]}).`;
  const bareHttpFailure = /^HTTP (.+)。$/.exec(value);
  if (bareHttpFailure !== null) return `HTTP ${bareHttpFailure[1]}.`;

  return value;
}

function runtimeOperationEnglish(operation: string): string {
  const operations: Readonly<Record<string, string>> = {
    "添加动作": "Add action",
    "删除动作": "Delete action",
    "调整顺序": "Reorder actions",
    "修改位置": "Update location",
    "修改播报": "Update speech",
    "修改联系人": "Update contacts",
    "读取机器人": "Load robot",
    "刷新状态": "Refresh status",
    "状态检查": "Status check",
    "启动运行": "Start run",
    "停止运行": "Stop run",
  };
  return operations[operation] ?? operation;
}

function runtimeStatusEnglish(status: string): string {
  const statuses: Readonly<Record<string, string>> = {
    "在线": "online",
    "忙碌": "busy",
    "离线": "offline",
    "隐私模式": "in privacy mode",
    "状态未知": "in an unknown state",
  };
  return statuses[status] ?? status;
}

function copy(chinese: string, english: string): string {
  return language === "zh" ? chinese : english;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

window.addEventListener("pagehide", () => {
  orchestrator.abortReads();
  lifecycle?.dispose();
  clearConnection();
});

window.addEventListener("beforeunload", (event) => {
  if (!isLifecycleLocked()) return;
  event.preventDefault();
  event.returnValue = copy(
    "机器人可能继续执行，且本页关闭后无法恢复当前运行。",
    "The robot may continue running, and this run cannot be recovered after closing the page.",
  );
});

document.addEventListener("visibilitychange", () => {
  if (lifecycle !== null && document.visibilityState === "visible") render();
});

render();
