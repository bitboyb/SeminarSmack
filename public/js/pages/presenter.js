/**
 * presenter.js — Presenter dashboard logic for SeminarSmack.
 *
 * @module presenter
 */

import {
  getConfigStatus, openRoomChannel, sendBroadcast, closeRoomChannel,
  COOLDOWN_MS, PRESENTER_HEARTBEAT_MS, SNAPSHOT_DEBOUNCE_MS, SUBMISSION_LIMITS,
  loadSessionFromStorage, loadSessionFromFile, saveSessionToStorage,
  sanitizeSimpleToken, sanitizeHostToken, normalizeSessionName,
  validateSession, createPresenterState, createPresenterActivityState,
  getCurrentActivity, getActivityById, getActivityNumber, getResponseTotal,
  isActivityRevealed, getTextMaxLength, clampIndex, clampNumber,
  hashString, stableStringify, humanizeType, escapeHtml, escapeAttribute,
  renderMetricCard, renderEmptyState, setBanner, buildPageUrl,
  signEvent, verifySignedEvent, verifyEventIfNeeded,
  copyText, flashButtonState, downloadText, randomToken
} from "../app.js";

export async function initPresenterPage() {
  const params = new URLSearchParams(window.location.search);
  const room = sanitizeSimpleToken(params.get("room"));
  const sessionParam = normalizeSessionName(params.get("session"));
  const hostToken = sanitizeHostToken(params.get("host"));

  const runtime = {
    page: "present", room, sessionParam, hostToken,
    channel: null, client: null, session: null,
    sessionHash: "", sessionSource: "not loaded",
    presenterState: null, authoringDraft: "",
    bannerMessage: "", bannerTone: "info",
    connectionLabel: "Not connected", connectionTone: "muted",
    snapshotTimer: null, heartbeatId: null
  };

  if (!room) {
    runtime.bannerMessage = "No room code found. Go back and create a session first.";
    runtime.bannerTone = "warning";
  }

  if (!hostToken) {
    runtime.bannerMessage = "Host token missing — presenter controls will be disabled.";
    runtime.bannerTone = "warning";
  }

  // Session loading priority: localStorage → file → error
  if (room && !runtime.session) {
    const stored = loadSessionFromStorage(room);
    if (stored) {
      attachSession(runtime, stored, "Browser session");
    }
  }

  if (!runtime.session && sessionParam) {
    const loaded = await loadSessionFromFile(sessionParam);
    if (loaded.ok) {
      attachSession(runtime, loaded.session, loaded.sourceLabel);
    }
  }

  if (!runtime.session && !runtime.bannerMessage) {
    runtime.bannerMessage = "No session found. Create one first or add ?session=filename to load a JSON file.";
    runtime.bannerTone = "warning";
  }

  const configStatus = getConfigStatus();
  if (!configStatus.ok) {
    runtime.connectionLabel = "Local preview only";
    runtime.connectionTone = "warning";
    if (!runtime.bannerMessage) {
      runtime.bannerMessage = "Realtime is disabled — config.js is not populated.";
      runtime.bannerTone = "warning";
    }
    renderPresenter(runtime);
    return;
  }

  if (!room || !hostToken) { renderPresenter(runtime); return; }

  renderPresenter(runtime);

  try {
    const { channel, client } = await openRoomChannel(room, {
      vote_submitted: async (p) => handleSubmission(runtime, "poll", p),
      quiz_submitted: async (p) => handleSubmission(runtime, "quiz", p),
      text_submitted: async (p) => handleSubmission(runtime, "text", p),
      activity_changed: async (p) => {
        const ok = await verifyEventIfNeeded(runtime, "activity_changed", p);
        if (!ok || !runtime.session || !runtime.presenterState) return;
        const rev = Number(p.revision) || 0;
        if (rev < runtime.presenterState.revision) return;
        runtime.presenterState.currentActivityIndex = clampIndex(Number(p.currentActivityIndex), runtime.session.activities.length);
        runtime.presenterState.submissionsLocked = Boolean(p.submissionsLocked);
        runtime.presenterState.revision = rev;
        renderPresenter(runtime);
      },
      session_reset: async (p) => {
        const ok = await verifyEventIfNeeded(runtime, "session_reset", p);
        if (!ok || !runtime.session || !runtime.presenterState) return;
        const rev = Number(p.revision) || 0;
        if (rev < runtime.presenterState.revision) return;
        const activity = getActivityById(runtime.session, p.activityId);
        if (!activity) return;
        resetActivity(runtime, activity, { silent: true, nextResetCount: Number(p.resetCount) || undefined, nextRevision: rev || undefined });
        renderPresenter(runtime);
      },
      submissions_locked: async (p) => {
        const ok = await verifyEventIfNeeded(runtime, "submissions_locked", p);
        if (!ok || !runtime.presenterState) return;
        const rev = Number(p.revision) || 0;
        if (rev < runtime.presenterState.revision) return;
        runtime.presenterState.submissionsLocked = Boolean(p.locked);
        runtime.presenterState.revision = rev;
        renderPresenter(runtime);
      },
      reveal_answer: async (p) => {
        const ok = await verifyEventIfNeeded(runtime, "reveal_answer", p);
        if (!ok || !runtime.presenterState) return;
        const rev = Number(p.revision) || 0;
        if (rev < runtime.presenterState.revision) return;
        const aid = String(p.activityId || "");
        if (Boolean(p.revealed)) runtime.presenterState.revealedActivityIds.add(aid);
        else runtime.presenterState.revealedActivityIds.delete(aid);
        runtime.presenterState.revision = rev;
        renderPresenter(runtime);
      }
    });

    runtime.channel = channel;
    runtime.client = client;
    runtime.connectionLabel = "Connected";
    runtime.connectionTone = "success";
    runtime.bannerMessage = "Session is live. Share the student link or QR code when ready.";
    runtime.bannerTone = "success";

    if (runtime.session && runtime.presenterState) {
      await broadcastSnapshot(runtime, "presenter_connected");
      runtime.heartbeatId = window.setInterval(() => { void broadcastSnapshot(runtime, "heartbeat"); }, PRESENTER_HEARTBEAT_MS);
    }
  } catch {
    runtime.connectionLabel = "Connection failed";
    runtime.connectionTone = "warning";
    runtime.bannerMessage = "Could not connect to the realtime channel. Check your Supabase config.";
    runtime.bannerTone = "warning";
  }

  renderPresenter(runtime);
  window.addEventListener("beforeunload", () => {
    if (runtime.snapshotTimer) window.clearTimeout(runtime.snapshotTimer);
    if (runtime.heartbeatId) window.clearInterval(runtime.heartbeatId);
    if (runtime.channel) void closeRoomChannel(runtime.channel);
  });
}

function attachSession(runtime, session, sourceLabel) {
  runtime.session = session;
  runtime.sessionHash = hashString(stableStringify(session));
  runtime.sessionSource = sourceLabel;
  runtime.presenterState = createPresenterState(session);
  runtime.authoringDraft = JSON.stringify(session, null, 2);

  try {
    const stickyStr = window.localStorage.getItem(`seminarsmack:sticky:${runtime.room}`);
    if (stickyStr) {
      const sticky = JSON.parse(stickyStr);
      if (sticky.sessionHash === runtime.sessionHash) {
        runtime.presenterState.currentActivityIndex = clampIndex(Number(sticky.currentActivityIndex), session.activities.length);
        runtime.presenterState.submissionsLocked = Boolean(sticky.submissionsLocked);
        runtime.presenterState.revealedActivityIds = new Set(Array.isArray(sticky.revealedActivityIds) ? sticky.revealedActivityIds : []);
      }
    }
  } catch {}
}

function saveStickyState(runtime) {
  if (!runtime.room || !runtime.presenterState) return;
  const sticky = {
    sessionHash: runtime.sessionHash,
    currentActivityIndex: runtime.presenterState.currentActivityIndex,
    submissionsLocked: runtime.presenterState.submissionsLocked,
    revealedActivityIds: [...runtime.presenterState.revealedActivityIds]
  };
  window.localStorage.setItem(`seminarsmack:sticky:${runtime.room}`, JSON.stringify(sticky));
}

function resetActivity(runtime, activity, opts = {}) {
  const next = createPresenterActivityState(activity);
  const cur = runtime.presenterState.activityStates[activity.id];
  next.resetCount = opts.nextResetCount || cur.resetCount + 1;
  runtime.presenterState.activityStates[activity.id] = next;
  runtime.presenterState.revealedActivityIds.delete(activity.id);
  runtime.presenterState.revision = opts.nextRevision || runtime.presenterState.revision + 1;
  saveStickyState(runtime);
  if (!opts.silent) { runtime.bannerMessage = "Activity reset."; runtime.bannerTone = "success"; }
}

// ── Rendering ──────────────────────────────────────────────────

function renderPresenter(runtime) {
  const sessionSummary = document.getElementById("session-summary");
  const controlPanel = document.getElementById("control-panel");
  const activityStage = document.getElementById("activity-stage");
  const resultsStage = document.getElementById("results-stage");
  const authoringPanel = document.getElementById("authoring-panel");
  const qrPanel = document.getElementById("qr-panel");
  const pageStatus = document.getElementById("page-status");

  const activeJsonInput = document.activeElement?.id === "session-json-input" ? document.activeElement : null;
  const jsonSelStart = typeof activeJsonInput?.selectionStart === "number" ? activeJsonInput.selectionStart : null;
  const jsonSelEnd = typeof activeJsonInput?.selectionEnd === "number" ? activeJsonInput.selectionEnd : null;

  setBanner(pageStatus, runtime.bannerMessage, runtime.bannerTone);

  if (!sessionSummary || !controlPanel || !activityStage || !resultsStage || !authoringPanel) return;

  const activity = getCurrentActivity(runtime.session, runtime.presenterState);
  const actState = activity ? runtime.presenterState?.activityStates[activity.id] : null;
  const disabled = !runtime.hostToken || !runtime.session || !runtime.presenterState;
  const canReveal = Boolean(activity && activity.type === "quiz");
  const isRevealed = activity ? isActivityRevealed(runtime.presenterState, activity.id) : false;

  const joinLink = runtime.room ? buildPageUrl("join", { room: runtime.room }) : "";

  // Session summary
  sessionSummary.innerHTML = runtime.session ? `
    <div class="session-meta">
      <div class="summary-row">
        <div>
          <p class="section-kicker">Session loaded</p>
          <h2 class="session-title">${escapeHtml(runtime.session.title)}</h2>
          <p class="body-copy">${escapeHtml(runtime.session.description || "No description.")}</p>
        </div>
        <div class="stack">
          <span class="badge ${runtime.presenterState?.submissionsLocked ? 'badge-locked' : 'badge-open'}">${runtime.presenterState?.submissionsLocked ? 'Submissions closed' : 'Submissions open'}</span>
        </div>
      </div>
      <div class="metric-grid">
        ${renderMetricCard("Room", `<span class="mono">${escapeHtml(runtime.room || "n/a")}</span>`, "Broadcast channel")}
        ${renderMetricCard("Activities", String(runtime.session.activities.length), runtime.sessionSource)}
        ${renderMetricCard("Current", activity ? `${getActivityNumber(runtime.session, activity.id)} / ${runtime.session.activities.length}` : "—", activity ? humanizeType(activity.type) : "None")}
        ${renderMetricCard("Status", escapeHtml(runtime.connectionLabel), runtime.connectionTone === "success" ? "Live" : "Offline")}
      </div>
    </div>
  ` : renderEmptyState("No session loaded", "Create a session first or add ?session=filename to the URL.");

  // QR panel
  if (qrPanel) {
    qrPanel.innerHTML = joinLink ? `
      <div class="qr-panel">
        <p class="section-kicker">📱 Students join here</p>
        <div class="room-code-display">${escapeHtml(runtime.room)}</div>
        <div id="qr-container"></div>
        <p class="body-copy" style="max-width: 360px; margin: 0 auto; font-size: 0.92rem;">Scan the QR code with your phone camera, or open the link below in any browser.</p>
        <div class="stack">
          <div class="copy-row">
            <input id="presenter-join-link" type="text" readonly value="${escapeAttribute(joinLink)}" />
            <button class="button button-ghost" type="button" data-copy-target="presenter-join-link">Copy link</button>
          </div>
        </div>
      </div>
    ` : renderEmptyState("No join link", "A room code is needed to generate the QR code.");
    renderQR(joinLink);
  }

  // Controls
  controlPanel.innerHTML = `
    <div class="controls-shell">
      <p class="section-kicker">Controls</p>
      <div class="control-row">
        <button id="prev-activity" class="button button-ghost" type="button" ${disabled || !activity || getActivityNumber(runtime.session, activity.id) === 1 ? 'disabled' : ''}>← Previous</button>
        <button id="next-activity" class="button button-primary" type="button" ${disabled || !activity || getActivityNumber(runtime.session, activity.id) === runtime.session?.activities.length ? 'disabled' : ''}>Next →</button>
        <button id="toggle-lock" class="button button-secondary" type="button" ${disabled || !activity ? 'disabled' : ''}>${runtime.presenterState?.submissionsLocked ? 'Open submissions' : 'Close submissions'}</button>
        <button id="reset-activity" class="button button-danger" type="button" ${disabled || !activity ? 'disabled' : ''}>Reset & Allow Resubmission</button>
        <button id="toggle-reveal" class="button button-ghost" type="button" ${disabled || !canReveal ? 'disabled' : ''}>${isRevealed ? 'Hide answer' : 'Reveal answer'}</button>
      </div>

    </div>
  `;

  // Activity stage
  activityStage.innerHTML = activity ? `
    <div class="activity-shell">
      <div class="title-row">
        <div>
          <p class="section-kicker">Current activity</p>
          <h2 class="activity-title">${escapeHtml(activity.question)}</h2>
        </div>
        <span class="badge badge-accent">Activity ${getActivityNumber(runtime.session, activity.id)} of ${runtime.session.activities.length}</span>
      </div>
      ${renderPresenterPreview(runtime, activity, actState)}
    </div>
  ` : renderEmptyState("No active activity", "Load a session to start.");

  // Results
  const total = activity ? getResponseTotal(activity, actState) : 0;
  resultsStage.innerHTML = activity ? `
    <div class="results-shell">
      <div class="title-row">
        <div>
          <p class="section-kicker">Results</p>
          <h2 class="activity-title">${escapeHtml(activity.question)}</h2>
        </div>
        <span class="badge badge-accent">${total} response${total === 1 ? '' : 's'}</span>
      </div>
      ${renderResults(runtime, activity, actState)}
    </div>
  ` : renderEmptyState("No results", "Results appear once students submit.");

  // Authoring
  authoringPanel.innerHTML = `
    <div class="authoring-shell">
      <p class="section-kicker">Session JSON</p>
      <details>
        <summary>Import or export session</summary>
        <div class="stack-lg">
          <label class="field">
            <span>Session JSON</span>
            <textarea id="session-json-input" spellcheck="false">${escapeHtml(runtime.authoringDraft || (runtime.session ? JSON.stringify(runtime.session, null, 2) : ""))}</textarea>
          </label>
          <div class="control-row">
            <button id="load-session-json" class="button button-secondary" type="button">Load JSON</button>
            <button id="copy-session-json" class="button button-ghost" type="button">Copy</button>
            <button id="download-session-json" class="button button-ghost" type="button">Download</button>
          </div>
        </div>
      </details>
    </div>
  `;

  bindInteractions(runtime);

  if (activeJsonInput) {
    const next = document.getElementById("session-json-input");
    next?.focus();
    if (next && typeof jsonSelStart === "number" && typeof jsonSelEnd === "number") {
      next.setSelectionRange(jsonSelStart, jsonSelEnd);
    }
  }
}

function renderQR(url) {
  const container = document.getElementById("qr-container");
  if (!container || !url) return;

  try {
    if (typeof window.qrcode !== "function") throw new Error("QR library not loaded.");
    const qr = window.qrcode(0, "M");
    qr.addData(url);
    qr.make();
    const img = qr.createImgTag(6, 16);
    container.innerHTML = img;
    const imgEl = container.querySelector("img");
    if (imgEl) {
      imgEl.alt = "QR code to join this session";
      imgEl.style.maxWidth = "280px";
      imgEl.style.width = "100%";
      imgEl.style.height = "auto";
      imgEl.style.borderRadius = "var(--radius-md)";
    }
  } catch {
    container.innerHTML = `<div class="notice notice-info" style="text-align:center;">QR code could not be generated. Students can use the link or room code above instead.</div>`;
  }
}

function renderPresenterPreview(runtime, activity, actState) {
  if (activity.type === "text") {
    return `
      <div class="metric-grid">
        ${renderMetricCard("Responses", String(actState?.texts.length || 0), "Current")}
        ${renderMetricCard("Limit", String(SUBMISSION_LIMITS.text), "Per student")}
        ${renderMetricCard("Max chars", String(getTextMaxLength(activity)), "Per response")}
      </div>
    `;
  }

  const isRevealed = isActivityRevealed(runtime.presenterState, activity.id);
  return `
    <div class="choice-grid">
      ${activity.options.map((opt, i) => {
        const correct = activity.type === "quiz" && isRevealed && activity.correctIndex === i;
        return `
          <article class="choice-card ${correct ? 'is-correct' : ''}">
            <div class="choice-header">
              <span>${escapeHtml(opt)}</span>
              ${correct ? '<span class="badge badge-open">Correct</span>' : `<span class="badge badge-accent">Option ${i + 1}</span>`}
            </div>
            <div class="choice-meta"><span>${actState?.counts[i] || 0} votes</span></div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function renderResults(runtime, activity, actState) {
  if (!actState) return renderEmptyState("No results", "Waiting for responses.");

  if (activity.type === "text") {
    const texts = [...actState.texts].reverse();
    return texts.length ? `<div class="text-entry-list">${texts.map((e, i) => `
      <article class="text-card"><p>${escapeHtml(e.text)}</p><small>Response ${texts.length - i}</small></article>
    `).join("")}</div>` : renderEmptyState("No text yet", "Responses appear as students submit.");
  }

  const revealCorrect = activity.type === "quiz" && isActivityRevealed(runtime.presenterState, activity.id);
  const total = getResponseTotal(activity, actState);
  return `<div class="choice-grid">${activity.options.map((opt, i) => {
    const count = actState.counts[i] || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const correct = revealCorrect && activity.correctIndex === i;
    return `
      <article class="choice-card ${correct ? 'is-correct' : ''}">
        <div class="choice-header"><span>${escapeHtml(opt)}</span><strong>${count}</strong></div>
        <div class="meter"><div class="meter-fill" style="width:${pct}%"></div></div>
        <div class="choice-meta"><span>${pct}%</span><span>${count} response${count === 1 ? '' : 's'}</span></div>
        ${correct ? '<span class="badge badge-open">Correct answer</span>' : ''}
      </article>
    `;
  }).join("")}</div>`;
}

// ── Interactions ───────────────────────────────────────────────

function bindInteractions(runtime) {
  document.getElementById("prev-activity")?.addEventListener("click", () => shiftActivity(runtime, -1));
  document.getElementById("next-activity")?.addEventListener("click", () => shiftActivity(runtime, 1));
  document.getElementById("toggle-lock")?.addEventListener("click", () => toggleLock(runtime));
  document.getElementById("reset-activity")?.addEventListener("click", () => resetCurrent(runtime));
  document.getElementById("toggle-reveal")?.addEventListener("click", () => toggleReveal(runtime));

  const jsonInput = document.getElementById("session-json-input");
  jsonInput?.addEventListener("input", () => { runtime.authoringDraft = jsonInput.value; });

  document.getElementById("load-session-json")?.addEventListener("click", () => loadFromDraft(runtime));
  document.getElementById("copy-session-json")?.addEventListener("click", async () => {
    const val = runtime.authoringDraft || (runtime.session ? JSON.stringify(runtime.session, null, 2) : "");
    if (val) { try { await copyText(val); setBanner(document.getElementById("page-status"), "JSON copied.", "success"); } catch {} }
  });
  document.getElementById("download-session-json")?.addEventListener("click", () => {
    const val = runtime.authoringDraft || (runtime.session ? JSON.stringify(runtime.session, null, 2) : "");
    if (val) downloadText("session.json", val);
  });
}

async function shiftActivity(runtime, delta) {
  if (!runtime.session || !runtime.presenterState || !runtime.hostToken) return;
  const cur = getCurrentActivity(runtime.session, runtime.presenterState);
  const ci = cur ? getActivityNumber(runtime.session, cur.id) - 1 : 0;
  const ni = clampIndex(ci + delta, runtime.session.activities.length);
  if (ni === runtime.presenterState.currentActivityIndex) return;
  runtime.presenterState.currentActivityIndex = ni;
  runtime.presenterState.submissionsLocked = false;
  runtime.presenterState.revision += 1;
  saveStickyState(runtime);
  await sendPresenterEvent(runtime, "activity_changed", {
    activityId: runtime.session.activities[ni].id,
    currentActivityIndex: ni, submissionsLocked: false,
    revision: runtime.presenterState.revision
  });
  scheduleSnapshot(runtime, "activity_changed");
  renderPresenter(runtime);
}

async function toggleLock(runtime) {
  if (!runtime.presenterState || !runtime.hostToken) return;
  runtime.presenterState.submissionsLocked = !runtime.presenterState.submissionsLocked;
  runtime.presenterState.revision += 1;
  saveStickyState(runtime);
  await sendPresenterEvent(runtime, "submissions_locked", { locked: runtime.presenterState.submissionsLocked, revision: runtime.presenterState.revision });
  scheduleSnapshot(runtime, "lock_toggled");
  renderPresenter(runtime);
}

async function resetCurrent(runtime) {
  if (!runtime.session || !runtime.presenterState || !runtime.hostToken) return;
  const activity = getCurrentActivity(runtime.session, runtime.presenterState);
  if (!activity) return;
  resetActivity(runtime, activity);
  await sendPresenterEvent(runtime, "session_reset", { activityId: activity.id, resetCount: runtime.presenterState.activityStates[activity.id].resetCount, revision: runtime.presenterState.revision });
  scheduleSnapshot(runtime, "activity_reset");
  renderPresenter(runtime);
}

async function toggleReveal(runtime) {
  if (!runtime.session || !runtime.presenterState || !runtime.hostToken) return;
  const activity = getCurrentActivity(runtime.session, runtime.presenterState);
  if (!activity || activity.type !== "quiz") return;
  const revealed = !runtime.presenterState.revealedActivityIds.has(activity.id);
  if (revealed) runtime.presenterState.revealedActivityIds.add(activity.id);
  else runtime.presenterState.revealedActivityIds.delete(activity.id);
  runtime.presenterState.revision += 1;
  saveStickyState(runtime);
  await sendPresenterEvent(runtime, "reveal_answer", { activityId: activity.id, revealed, revision: runtime.presenterState.revision });
  scheduleSnapshot(runtime, "reveal_toggled");
  renderPresenter(runtime);
}

async function loadFromDraft(runtime) {
  const draft = runtime.authoringDraft || document.getElementById("session-json-input")?.value || "";
  if (!draft.trim()) { runtime.bannerMessage = "Paste valid JSON first."; runtime.bannerTone = "warning"; renderPresenter(runtime); return; }
  let raw;
  try { raw = JSON.parse(draft); } catch { runtime.bannerMessage = "Invalid JSON."; runtime.bannerTone = "warning"; renderPresenter(runtime); return; }
  const v = validateSession(raw);
  if (!v.ok) { runtime.bannerMessage = v.errors.join(" "); runtime.bannerTone = "warning"; renderPresenter(runtime); return; }
  attachSession(runtime, v.session, "Imported JSON");
  runtime.bannerMessage = "Session loaded from JSON."; runtime.bannerTone = "success";
  renderPresenter(runtime);
  if (runtime.hostToken) await broadcastSnapshot(runtime, "session_imported");
}

// ── Submission handling ────────────────────────────────────────

async function handleSubmission(runtime, expectedType, payload) {
  if (!runtime.session || !runtime.presenterState) return;
  const activity = getCurrentActivity(runtime.session, runtime.presenterState);
  if (!activity || activity.type !== expectedType) return;
  if (payload.activityId !== activity.id || runtime.presenterState.submissionsLocked) return;

  const deviceId = sanitizeSimpleToken(payload.deviceId);
  if (!deviceId) return;

  const actState = runtime.presenterState.activityStates[activity.id];
  const entry = actState.submissionsByDevice[deviceId] || { count: 0, lastSubmittedAt: 0, choiceIndex: null, resetCount: actState.resetCount };
  if (Date.now() - entry.lastSubmittedAt < COOLDOWN_MS) return;

  if (expectedType === "text") {
    const text = String(payload.text || "").trim();
    if (!text || text.length > getTextMaxLength(activity) || entry.count >= SUBMISSION_LIMITS.text) return;
    actState.texts.push({ id: `${deviceId}-${Date.now()}`, text, submittedAt: new Date().toISOString() });
  } else {
    const oi = Number(payload.optionIndex);
    if (!Number.isInteger(oi) || oi < 0 || oi >= activity.options.length || entry.count >= SUBMISSION_LIMITS[expectedType]) return;
    actState.counts[oi] = (actState.counts[oi] || 0) + 1;
    entry.choiceIndex = oi;
  }

  entry.count += 1;
  entry.lastSubmittedAt = Date.now();
  entry.resetCount = actState.resetCount;
  actState.submissionsByDevice[deviceId] = entry;
  runtime.presenterState.revision += 1;
  renderPresenter(runtime);
  scheduleSnapshot(runtime, "submission");
}

// ── Broadcasting ───────────────────────────────────────────────

async function sendPresenterEvent(runtime, name, payload) {
  if (!runtime.channel || !runtime.hostToken) return;
  const signed = await signEvent(name, payload, runtime.hostToken);
  await sendBroadcast(runtime.channel, name, signed);
}

async function broadcastSnapshot(runtime, reason) {
  if (!runtime.channel || !runtime.session || !runtime.presenterState || !runtime.hostToken) return;
  const snap = buildSnapshot(runtime, reason);
  const signed = await signEvent("state_snapshot", snap, runtime.hostToken);
  await sendBroadcast(runtime.channel, "state_snapshot", signed);
}

function scheduleSnapshot(runtime, reason) {
  if (runtime.snapshotTimer) window.clearTimeout(runtime.snapshotTimer);
  runtime.snapshotTimer = window.setTimeout(() => { runtime.snapshotTimer = null; void broadcastSnapshot(runtime, reason); }, SNAPSHOT_DEBOUNCE_MS);
}

function buildSnapshot(runtime, reason) {
  const states = Object.fromEntries(
    Object.entries(runtime.presenterState.activityStates).map(([id, s]) => [id, { counts: [...s.counts], texts: s.texts.map((e) => ({ id: e.id, text: e.text, submittedAt: e.submittedAt })), resetCount: s.resetCount }])
  );
  return {
    reason, revision: runtime.presenterState.revision, session: runtime.session,
    sessionHash: runtime.sessionHash || hashString(stableStringify(runtime.session)),
    currentActivityIndex: runtime.presenterState.currentActivityIndex,
    submissionsLocked: runtime.presenterState.submissionsLocked,
    revealedActivityIds: [...runtime.presenterState.revealedActivityIds],
    activityStates: states, sentAt: new Date().toISOString()
  };
}
