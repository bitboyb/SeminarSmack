/**
 * participant.js — Student join page logic for SeminarSmack.
 *
 * Students land here via QR code or link. The page connects to the
 * broadcast channel and waits for presenter snapshots. If a ?session=
 * param is present (legacy), it also loads the JSON file.
 */

import {
  getConfigStatus, openRoomChannel, sendBroadcast, closeRoomChannel,
  COOLDOWN_MS, SUBMISSION_LIMITS,
  loadSessionFromFile, validateSession,
  sanitizeSimpleToken, sanitizeHostToken, normalizeSessionName,
  getOrCreateDeviceId, createPublicState,
  getCurrentActivity, getActivityById, getActivityNumber, getResponseTotal,
  isActivityRevealed, getTextMaxLength, clampIndex,
  hashString, stableStringify, humanizeType, defaultDescription,
  escapeHtml, escapeAttribute,
  renderMetricCard, renderEmptyState, setBanner, buildSubmissionStoreKey,
  getLocalSubmissionEntry, resetLocalSubmissionEntry, recordLocalSubmission,
  verifyEventIfNeeded, createLocalSubmissionEntry
} from "./app.js";

export async function initJoinPage() {
  const params = new URLSearchParams(window.location.search);
  const room = sanitizeSimpleToken(params.get("room"));
  const sessionParam = normalizeSessionName(params.get("session"));
  const hostToken = sanitizeHostToken(params.get("host"));

  const runtime = {
    page: "join", room, sessionParam, hostToken,
    deviceId: getOrCreateDeviceId(),
    channel: null, client: null,
    session: null, sessionHash: "",
    sessionSource: sessionParam ? `${sessionParam}.json` : "not loaded",
    sharedState: null, connectionLabel: "Not connected", connectionTone: "muted",
    textDraft: "", bannerMessage: "", bannerTone: "info",
    submissionStoreKey: buildSubmissionStoreKey(room, sessionParam || "default"),
    lastHeartbeat: Date.now(), watchdogTimer: null
  };

  if (!room) {
    runtime.bannerMessage = "No room code found. Ask your teacher for the join link or QR code.";
    runtime.bannerTone = "warning";
    renderAudience(runtime);
    return;
  }

  // Legacy: load session from file if param is present
  if (sessionParam) {
    const loaded = await loadSessionFromFile(sessionParam);
    if (loaded.ok) {
      runtime.session = loaded.session;
      runtime.sessionHash = hashString(stableStringify(loaded.session));
      runtime.sessionSource = loaded.sourceLabel;
      runtime.sharedState = createPublicState(runtime.session);
      runtime.submissionStoreKey = buildSubmissionStoreKey(room, runtime.sessionHash);
    }
  }

  if (!runtime.session) {
    runtime.bannerMessage = "Connecting… waiting for presenter to start the session.";
    runtime.bannerTone = "info";
  }

  const configStatus = getConfigStatus();
  if (!configStatus.ok) {
    runtime.connectionLabel = "Offline";
    runtime.connectionTone = "warning";
    runtime.bannerMessage = "Realtime is not available. The site may not be fully configured yet.";
    runtime.bannerTone = "warning";
    renderAudience(runtime);
    return;
  }

  renderAudience(runtime);

  try {
    const { channel, client } = await openRoomChannel(room, {
      activity_changed: async (p) => {
        const ok = await verifyEventIfNeeded(runtime, "activity_changed", p);
        if (!ok || !runtime.session || !runtime.sharedState) return;
        runtime.lastHeartbeat = Date.now();
        const rev = Number(p.revision) || 0;
        if (rev < runtime.sharedState.revision) return;
        runtime.sharedState.currentActivityIndex = clampIndex(Number(p.currentActivityIndex), runtime.session.activities.length);
        runtime.sharedState.submissionsLocked = Boolean(p.submissionsLocked);
        runtime.sharedState.revision = rev;
        renderAudience(runtime);
      },
      session_reset: async (p) => {
        const ok = await verifyEventIfNeeded(runtime, "session_reset", p);
        if (!ok || !runtime.session || !runtime.sharedState) return;
        runtime.lastHeartbeat = Date.now();
        const rev = Number(p.revision) || 0;
        if (rev < runtime.sharedState.revision) return;
        const activity = getActivityById(runtime.session, p.activityId);
        if (!activity) return;
        const state = runtime.sharedState.activityStates[activity.id];
        state.counts = Array.isArray(activity.options) ? activity.options.map(() => 0) : [];
        state.texts = [];
        state.resetCount = Number(p.resetCount) || state.resetCount + 1;
        runtime.sharedState.revision = rev;
        resetLocalSubmissionEntry(runtime, activity.id, state.resetCount);
        renderAudience(runtime);
      },
      submissions_locked: async (p) => {
        const ok = await verifyEventIfNeeded(runtime, "submissions_locked", p);
        if (!ok || !runtime.sharedState) return;
        runtime.lastHeartbeat = Date.now();
        const rev = Number(p.revision) || 0;
        if (rev < runtime.sharedState.revision) return;
        runtime.sharedState.submissionsLocked = Boolean(p.locked);
        runtime.sharedState.revision = rev;
        renderAudience(runtime);
      },
      reveal_answer: async (p) => {
        const ok = await verifyEventIfNeeded(runtime, "reveal_answer", p);
        if (!ok || !runtime.session || !runtime.sharedState) return;
        runtime.lastHeartbeat = Date.now();
        const rev = Number(p.revision) || 0;
        if (rev < runtime.sharedState.revision) return;
        const aid = String(p.activityId || "");
        if (Boolean(p.revealed)) runtime.sharedState.revealedActivityIds.add(aid);
        else runtime.sharedState.revealedActivityIds.delete(aid);
        runtime.sharedState.revision = rev;
        renderAudience(runtime);
      },
      state_snapshot: async (p) => {
        const ok = await verifyEventIfNeeded(runtime, "state_snapshot", p);
        if (!ok) return;
        if (applySnapshot(runtime, p)) {
          runtime.bannerMessage = "";
          runtime.bannerTone = "info";
          renderAudience(runtime);
        }
      }
    });

    runtime.channel = channel;
    runtime.client = client;
    runtime.connectionLabel = "Connected";
    runtime.connectionTone = "success";
    if (!runtime.session) {
      runtime.bannerMessage = "Connected. Waiting for presenter to start the session.";
      runtime.bannerTone = "info";
    }

    runtime.lastHeartbeat = Date.now();
    runtime.watchdogTimer = window.setInterval(() => {
      if (!runtime.channel) return;
      const elapsed = Date.now() - runtime.lastHeartbeat;
      if (elapsed > 60000) {
        void closeRoomChannel(runtime.channel);
        runtime.channel = null;
        runtime.bannerMessage = "The session has ended or the presenter has disconnected.";
        runtime.bannerTone = "warning";
        runtime.connectionLabel = "Offline";
        runtime.connectionTone = "warning";
        renderAudience(runtime);
        window.clearInterval(runtime.watchdogTimer);
      } else if (elapsed > 15000 && runtime.bannerMessage !== "Presenter appears to be offline. Waiting for them to reconnect...") {
        runtime.bannerMessage = "Presenter appears to be offline. Waiting for them to reconnect...";
        runtime.bannerTone = "warning";
        renderAudience(runtime);
      }
    }, 5000);
  } catch {
    runtime.connectionLabel = "Connection failed";
    runtime.connectionTone = "warning";
    runtime.bannerMessage = "Could not connect to the session. Check the room code and try again.";
    runtime.bannerTone = "warning";
  }

  renderAudience(runtime);
  window.addEventListener("beforeunload", () => {
    if (runtime.watchdogTimer) window.clearInterval(runtime.watchdogTimer);
    if (runtime.channel) void closeRoomChannel(runtime.channel);
  });
}

// ── Snapshot application ───────────────────────────────────────

function applySnapshot(runtime, payload) {
  const rev = Number(payload.revision) || 0;
  if (runtime.sharedState && rev < runtime.sharedState.revision) return false;
  
  runtime.lastHeartbeat = Date.now();
  
  const v = validateSession(payload.session);
  if (!v.ok) return false;

  const session = v.session;
  const nextHash = String(payload.sessionHash || hashString(stableStringify(session)));
  runtime.submissionStoreKey = buildSubmissionStoreKey(runtime.room, nextHash);
  const nextState = createPublicState(session);
  nextState.revision = rev;
  nextState.currentActivityIndex = clampIndex(Number(payload.currentActivityIndex), session.activities.length);
  nextState.submissionsLocked = Boolean(payload.submissionsLocked);
  nextState.revealedActivityIds = new Set(Array.isArray(payload.revealedActivityIds) ? payload.revealedActivityIds : []);

  Object.entries(nextState.activityStates).forEach(([aid, state]) => {
    const incoming = payload.activityStates?.[aid] || {};
    const activity = session.activities.find((a) => a.id === aid);
    state.counts = Array.isArray(activity?.options) ? activity.options.map((_, i) => Number(incoming.counts?.[i]) || 0) : [];
    state.texts = Array.isArray(incoming.texts) ? incoming.texts.map((e, i) => ({ id: String(e.id || `${aid}-${i}`), text: String(e.text || "").slice(0, getTextMaxLength(activity)), submittedAt: String(e.submittedAt || "") })).filter((e) => e.text) : [];
    state.resetCount = Number(incoming.resetCount) || 0;
    getLocalSubmissionEntry(runtime, aid, state.resetCount);
  });

  runtime.session = session;
  runtime.sessionHash = nextHash;
  runtime.sessionSource = "Presenter";
  runtime.sharedState = nextState;
  return true;
}

// ── Rendering ──────────────────────────────────────────────────

function renderAudience(runtime) {
  const sessionSummary = document.getElementById("session-summary");
  const activityStage = document.getElementById("activity-stage");
  const resultsStage = document.getElementById("results-stage");
  const pageStatus = document.getElementById("page-status");

  const activeText = document.activeElement?.id === "text-response-input" ? document.activeElement : null;
  const selStart = typeof activeText?.selectionStart === "number" ? activeText.selectionStart : null;
  const selEnd = typeof activeText?.selectionEnd === "number" ? activeText.selectionEnd : null;

  setBanner(pageStatus, runtime.bannerMessage, runtime.bannerTone);
  if (!sessionSummary || !activityStage || !resultsStage) return;

  const activity = getCurrentActivity(runtime.session, runtime.sharedState);
  const actState = activity ? runtime.sharedState?.activityStates[activity.id] : null;
  const total = activity ? getResponseTotal(activity, actState) : 0;

  sessionSummary.innerHTML = runtime.session ? `
    <div class="session-meta">
      <div class="summary-row">
        <div>
          <p class="section-kicker">Live session</p>
          <h2 class="session-title">${escapeHtml(runtime.session.title)}</h2>
          <p class="body-copy">${escapeHtml(runtime.session.description || defaultDescription("join"))}</p>
        </div>
        <div class="stack">
          <span class="badge ${runtime.sharedState?.submissionsLocked ? 'badge-locked' : 'badge-open'}">${runtime.sharedState?.submissionsLocked ? 'Submissions closed' : 'Submissions open'}</span>
        </div>
      </div>
      <div class="metric-grid">
        ${renderMetricCard("Room", `<span class="mono">${escapeHtml(runtime.room || "—")}</span>`, "Session channel")}
        ${renderMetricCard("Question", activity ? `${getActivityNumber(runtime.session, activity.id)} / ${runtime.session.activities.length}` : "Waiting", "Current")}
        ${renderMetricCard("Status", escapeHtml(runtime.connectionLabel), runtime.connectionTone === "success" ? "Live" : "Offline")}
      </div>
    </div>
  ` : renderEmptyState("Waiting for session", "The presenter hasn't started the session yet. Stay on this page — it will update automatically.");

  activityStage.innerHTML = activity ? renderActivityUI(runtime, activity, actState) : renderEmptyState("No active question", "The presenter will push a question to you shortly.");

  resultsStage.innerHTML = activity ? `
    <div class="results-shell">
      <div class="title-row">
        <div><p class="section-kicker">Live results</p><h2 class="activity-title">${escapeHtml(activity.question)}</h2></div>
        <span class="badge badge-accent">${total} response${total === 1 ? '' : 's'}</span>
      </div>
      ${renderResultsUI(runtime, activity, actState)}
    </div>
  ` : renderEmptyState("No results yet", "Results appear here once a question is active.");

  bindSubmissions(runtime, activity);

  if (activeText) {
    const next = document.getElementById("text-response-input");
    next?.focus();
    if (next && typeof selStart === "number" && typeof selEnd === "number") next.setSelectionRange(selStart, selEnd);
  }
}

function renderActivityUI(runtime, activity, actState) {
  const gate = getGate(runtime, activity);
  const localEntry = getLocalSubmissionEntry(runtime, activity.id, actState?.resetCount || 0);
  const selected = Number.isInteger(localEntry.choiceIndex) ? localEntry.choiceIndex : null;

  if (activity.type === "text") {
    return `
      <div class="activity-shell">
        <div class="title-row">
          <div><p class="section-kicker">Your response</p><h2 class="activity-title">${escapeHtml(activity.question)}</h2></div>
          <span class="badge ${runtime.sharedState?.submissionsLocked ? 'badge-locked' : 'badge-open'}">${runtime.sharedState?.submissionsLocked ? 'Closed' : 'Open'}</span>
        </div>
        <form id="text-response-form" class="stack-lg">
          <label class="field"><span>Your answer</span>
            <textarea id="text-response-input" maxlength="${getTextMaxLength(activity)}" placeholder="Type your answer here…" ${gate.canSubmit ? '' : 'disabled'}>${escapeHtml(runtime.textDraft)}</textarea>
          </label>
          <button class="button button-primary button-lg" type="submit" ${gate.canSubmit ? '' : 'disabled'}>Submit</button>
        </form>
        <div class="notice ${gate.tone === 'warning' ? 'notice-warning' : 'notice-info'}">${escapeHtml(gate.message)}</div>
      </div>
    `;
  }

  return `
    <div class="activity-shell">
      <div class="title-row">
        <div><p class="section-kicker">Choose an answer</p><h2 class="activity-title">${escapeHtml(activity.question)}</h2></div>
        <span class="badge ${runtime.sharedState?.submissionsLocked ? 'badge-locked' : 'badge-open'}">${runtime.sharedState?.submissionsLocked ? 'Closed' : 'Open'}</span>
      </div>
      <div class="choice-grid">
        ${activity.options.map((opt, i) => {
          const isSel = selected === i;
          const dis = !gate.canSubmit || (selected !== null && !isSel);
          return `
            <article class="choice-card ${isSel ? 'is-selected' : ''} ${dis ? 'is-disabled' : ''}">
              <div class="choice-header"><span>${escapeHtml(opt)}</span>${isSel ? '<span class="badge badge-open">Your choice</span>' : ''}</div>
              <button class="button ${isSel ? 'button-secondary' : 'button-ghost'} choice-select button-lg" type="button" data-submit-choice="${i}" ${dis ? 'disabled' : ''}>${isSel ? 'Selected ✓' : 'Select'}</button>
            </article>
          `;
        }).join("")}
      </div>
      <div class="notice ${gate.tone === 'warning' ? 'notice-warning' : 'notice-info'}">${escapeHtml(gate.message)}</div>
    </div>
  `;
}

function renderResultsUI(runtime, activity, actState) {
  if (!actState) return renderEmptyState("No results", "Waiting for responses.");
  if (activity.type === "text") {
    const texts = [...actState.texts].reverse();
    return texts.length ? `<div class="text-entry-list">${texts.map((e, i) => `<article class="text-card"><p>${escapeHtml(e.text)}</p><small>Response ${texts.length - i}</small></article>`).join("")}</div>` : renderEmptyState("No responses yet", "Text responses will appear here.");
  }

  const reveal = activity.type === "quiz" && isActivityRevealed(runtime.sharedState, activity.id);
  const total = getResponseTotal(activity, actState);
  return `<div class="choice-grid">${activity.options.map((opt, i) => {
    const count = actState.counts[i] || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const correct = reveal && activity.correctIndex === i;
    return `<article class="choice-card ${correct ? 'is-correct' : ''}"><div class="choice-header"><span>${escapeHtml(opt)}</span><strong>${count}</strong></div><div class="meter"><div class="meter-fill" style="width:${pct}%"></div></div><div class="choice-meta"><span>${pct}%</span><span>${count} response${count === 1 ? '' : 's'}</span></div>${correct ? '<span class="badge badge-open">Correct answer</span>' : ''}</article>`;
  }).join("")}</div>`;
}

// ── Submission logic ───────────────────────────────────────────

function getGate(runtime, activity) {
  if (!runtime.channel) return { canSubmit: false, message: "Not connected yet. Please wait.", tone: "warning" };
  if (runtime.sharedState?.submissionsLocked) return { canSubmit: false, message: "Submissions are closed for this question.", tone: "warning" };

  const actState = runtime.sharedState?.activityStates?.[activity.id];
  const entry = getLocalSubmissionEntry(runtime, activity.id, actState?.resetCount || 0);
  const limit = SUBMISSION_LIMITS[activity.type] || 1;

  if (entry.count >= limit) return { canSubmit: false, message: activity.type === "text" ? `You've reached the limit of ${limit} responses.` : "You've already submitted.", tone: "warning" };

  const cooldown = COOLDOWN_MS - (Date.now() - entry.lastSubmittedAt);
  if (entry.lastSubmittedAt && cooldown > 0) return { canSubmit: false, message: `Please wait ${Math.ceil(cooldown / 1000)} seconds.`, tone: "warning" };

  return { canSubmit: true, message: activity.type === "text" ? `You can submit up to ${limit} responses.` : "Choose one option.", tone: "info" };
}

function bindSubmissions(runtime, activity) {
  if (!activity) return;

  document.querySelectorAll("[data-submit-choice]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.getAttribute("data-submit-choice"));
      await submitChoice(runtime, activity, idx);
    });
  });

  const textInput = document.getElementById("text-response-input");
  const textForm = document.getElementById("text-response-form");
  textInput?.addEventListener("input", () => { runtime.textDraft = textInput.value; });
  textForm?.addEventListener("submit", async (e) => { e.preventDefault(); await submitText(runtime, activity); });
}

async function submitChoice(runtime, activity, optionIndex) {
  const gate = getGate(runtime, activity);
  if (!gate.canSubmit) { runtime.bannerMessage = gate.message; runtime.bannerTone = gate.tone; renderAudience(runtime); return; }

  try {
    await sendBroadcast(runtime.channel, activity.type === "quiz" ? "quiz_submitted" : "vote_submitted", {
      activityId: activity.id, deviceId: runtime.deviceId, optionIndex, sentAt: new Date().toISOString()
    });
    recordLocalSubmission(runtime, activity.id, { countIncrement: 1, choiceIndex: optionIndex });
    runtime.bannerMessage = "Answer submitted!";
    runtime.bannerTone = "success";
  } catch {
    runtime.bannerMessage = "Submission failed. Check your connection.";
    runtime.bannerTone = "warning";
  }
  renderAudience(runtime);
}

async function submitText(runtime, activity) {
  const gate = getGate(runtime, activity);
  const textInput = document.getElementById("text-response-input");
  const message = typeof textInput?.value === "string" ? textInput.value.trim() : runtime.textDraft.trim();

  if (!gate.canSubmit) { runtime.bannerMessage = gate.message; runtime.bannerTone = gate.tone; renderAudience(runtime); return; }
  if (!message) { runtime.bannerMessage = "Type a response first."; runtime.bannerTone = "warning"; renderAudience(runtime); return; }
  if (message.length > getTextMaxLength(activity)) { runtime.bannerMessage = `Keep it under ${getTextMaxLength(activity)} characters.`; runtime.bannerTone = "warning"; renderAudience(runtime); return; }

  try {
    await sendBroadcast(runtime.channel, "text_submitted", {
      activityId: activity.id, deviceId: runtime.deviceId, text: message, sentAt: new Date().toISOString()
    });
    recordLocalSubmission(runtime, activity.id, { countIncrement: 1 });
    runtime.textDraft = "";
    runtime.bannerMessage = "Response submitted!";
    runtime.bannerTone = "success";
  } catch {
    runtime.bannerMessage = "Submission failed. Check your connection.";
    runtime.bannerTone = "warning";
  }
  renderAudience(runtime);
}
