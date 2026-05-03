/**
 * session-builder.js — Browser-based session creation for SeminarSmack.
 *
 * Teachers fill in a title, add activities (poll / quiz / text), and
 * click "Start session". The session is saved to localStorage and the
 * browser redirects to the presenter page.
 */

import {
  generateRoomCode,
  randomToken,
  saveSessionToStorage,
  escapeHtml,
  escapeAttribute,
  setBanner,
  buildPageUrl,
  downloadText,
  sanitizeActivityId,
  validateSession,
  copyText,
  flashButtonState
} from "./app.js";

let state = {
  title: "",
  description: "",
  activities: [],
  roomCode: "",
  hostToken: ""
};

let nextActivityId = 1;
let saveDraftTimer = null;

function saveDraft() {
  if (saveDraftTimer) window.clearTimeout(saveDraftTimer);
  saveDraftTimer = window.setTimeout(() => {
    window.localStorage.setItem("seminarsmack:draft-session", JSON.stringify(state));
  }, 500);
}

export function initCreatePage() {
  const draftStr = window.localStorage.getItem("seminarsmack:draft-session");
  if (draftStr) {
    try {
      const draft = JSON.parse(draftStr);
      if (draft && typeof draft === "object" && draft.roomCode) {
        state = draft;
      }
    } catch {}
  }

  if (!state.roomCode) {
    state.roomCode = generateRoomCode();
    state.hostToken = randomToken(18);
  }
  render();
}

function render() {
  const root = document.getElementById("builder-root");
  if (!root) return;

  root.innerHTML = `
    <div class="stack-lg">

      <!-- Session info -->
      <div class="field">
        <span>Session title</span>
        <input id="builder-title" type="text" placeholder="e.g. Week 3 Lecture Check-in" value="${escapeAttribute(state.title)}" />
      </div>
      <div class="field">
        <span>Description (optional)</span>
        <input id="builder-desc" type="text" placeholder="e.g. Quick check on last week's reading" value="${escapeAttribute(state.description)}" />
      </div>

      <!-- Room code display -->
      <div style="text-align: center; padding: var(--space-md) 0;">
        <p class="muted" style="margin: 0 0 var(--space-xs); font-size: 0.85rem;">Your room code</p>
        <div class="room-code-display">${escapeHtml(state.roomCode)}</div>
      </div>

      <div class="divider"></div>

      <!-- Activities list -->
      <div>
        <p class="section-kicker">Activities (${state.activities.length})</p>
        <div id="activities-list" class="stack-lg">
          ${state.activities.length === 0
            ? `<div class="empty-state"><p class="body-copy">No activities yet. Add a poll, quiz, or text question below.</p></div>`
            : state.activities.map((a, i) => renderActivityCard(a, i)).join("")
          }
        </div>
      </div>

      <div class="divider"></div>

      <!-- Add activity -->
      <div>
        <p class="section-kicker">Add an activity</p>
        <div class="builder-add-type">
          <button class="type-option" type="button" data-add-type="poll">
            <div class="type-icon">📊</div>
            <div class="type-option-info">
              <strong>Poll</strong>
              <span>Multiple choice, no correct answer</span>
            </div>
          </button>
          <button class="type-option" type="button" data-add-type="quiz">
            <div class="type-icon">🧠</div>
            <div class="type-option-info">
              <strong>Quiz</strong>
              <span>Multiple choice with a correct answer</span>
            </div>
          </button>
          <button class="type-option" type="button" data-add-type="text">
            <div class="type-icon">💬</div>
            <div class="type-option-info">
              <strong>Short text</strong>
              <span>Open-ended short response</span>
            </div>
          </button>
        </div>
      </div>

      <div class="divider"></div>

      <!-- Actions -->
      <div class="hero-actions" style="gap: var(--space-sm);">
        <button id="start-session" class="button button-primary button-lg" type="button">
          Start session
        </button>
        <button id="export-json" class="button button-ghost" type="button">
          Export as JSON
        </button>
        <label class="button button-ghost" style="cursor: pointer;">
          Import JSON
          <input id="import-json" type="file" accept=".json,application/json" class="visually-hidden" />
        </label>
      </div>

    </div>
  `;

  bindEvents();
}

function renderActivityCard(activity, index) {
  const typeLabel = activity.type === "quiz" ? "Quiz" : activity.type === "text" ? "Short text" : "Poll";
  const total = state.activities.length;

  let optionsHtml = "";
  if (activity.type === "poll" || activity.type === "quiz") {
    optionsHtml = `
      <div class="stack">
        ${(activity.options || []).map((opt, oi) => `
          <div class="builder-option-row">
            <input type="text" value="${escapeAttribute(opt)}" data-activity="${index}" data-option="${oi}" placeholder="Option ${oi + 1}" />
            ${activity.type === "quiz"
              ? `<button type="button" class="button ${activity.correctIndex === oi ? 'button-secondary' : 'button-ghost'}" style="min-height:2.5rem; padding:0.5rem 0.7rem; font-size:0.8rem;" data-set-correct="${index}" data-correct-index="${oi}">${activity.correctIndex === oi ? '✓ Correct' : 'Set correct'}</button>`
              : ''
            }
            <button type="button" class="button button-danger" style="min-height:2.5rem; padding:0.5rem 0.7rem; font-size:0.8rem;" data-remove-option="${index}" data-option-index="${oi}">✕</button>
          </div>
        `).join("")}
        <button type="button" class="button button-ghost" style="justify-self: start;" data-add-option="${index}">+ Add option</button>
      </div>
    `;
  }

  let textSettingsHtml = "";
  if (activity.type === "text") {
    textSettingsHtml = `
      <div class="field">
        <span>Max characters</span>
        <input type="number" min="1" max="280" value="${activity.maxLength || 180}" data-activity-maxlen="${index}" />
      </div>
    `;
  }

  return `
    <div class="builder-activity-card">
      <div class="builder-activity-header">
        <h3><span class="badge badge-accent">${typeLabel}</span> Activity ${index + 1}</h3>
        <div class="builder-activity-actions">
          <button type="button" class="button button-ghost" style="min-height:2.2rem; padding:0.4rem 0.6rem; font-size:0.85rem;" data-move-up="${index}" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="button button-ghost" style="min-height:2.2rem; padding:0.4rem 0.6rem; font-size:0.85rem;" data-move-down="${index}" ${index === total - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="button button-danger" style="min-height:2.2rem; padding:0.4rem 0.6rem; font-size:0.85rem;" data-remove-activity="${index}">Remove</button>
        </div>
      </div>
      <div class="field">
        <span>Question</span>
        <input type="text" value="${escapeAttribute(activity.question)}" data-activity-question="${index}" placeholder="Enter your question" />
      </div>
      ${optionsHtml}
      ${textSettingsHtml}
    </div>
  `;
}

function bindEvents() {
  // Title & description
  document.getElementById("builder-title")?.addEventListener("input", (e) => {
    state.title = e.target.value;
    saveDraft();
  });
  document.getElementById("builder-desc")?.addEventListener("input", (e) => {
    state.description = e.target.value;
    saveDraft();
  });

  // Add activity type
  document.querySelectorAll("[data-add-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.addType;
      addActivity(type);
    });
  });

  // Activity question inputs
  document.querySelectorAll("[data-activity-question]").forEach((input) => {
    input.addEventListener("input", () => {
      const idx = Number(input.dataset.activityQuestion);
      state.activities[idx].question = input.value;
      saveDraft();
    });
  });

  // Option text inputs
  document.querySelectorAll("[data-activity][data-option]").forEach((input) => {
    input.addEventListener("input", () => {
      const ai = Number(input.dataset.activity);
      const oi = Number(input.dataset.option);
      state.activities[ai].options[oi] = input.value;
      saveDraft();
    });
  });

  // Add option
  document.querySelectorAll("[data-add-option]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.addOption);
      state.activities[idx].options.push("");
      saveDraft();
      render();
    });
  });

  // Remove option
  document.querySelectorAll("[data-remove-option]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ai = Number(btn.dataset.removeOption);
      const oi = Number(btn.dataset.optionIndex);
      state.activities[ai].options.splice(oi, 1);
      // Fix correctIndex if needed
      if (state.activities[ai].type === "quiz") {
        if (state.activities[ai].correctIndex === oi) {
          state.activities[ai].correctIndex = null;
        } else if (state.activities[ai].correctIndex > oi) {
          state.activities[ai].correctIndex--;
        }
      }
      saveDraft();
      render();
    });
  });

  // Set correct answer
  document.querySelectorAll("[data-set-correct]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ai = Number(btn.dataset.setCorrect);
      const ci = Number(btn.dataset.correctIndex);
      state.activities[ai].correctIndex = ci;
      saveDraft();
      render();
    });
  });

  // Move up/down
  document.querySelectorAll("[data-move-up]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.moveUp);
      if (idx > 0) {
        const temp = state.activities[idx];
        state.activities[idx] = state.activities[idx - 1];
        state.activities[idx - 1] = temp;
        saveDraft();
        render();
      }
    });
  });

  document.querySelectorAll("[data-move-down]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.moveDown);
      if (idx < state.activities.length - 1) {
        const temp = state.activities[idx];
        state.activities[idx] = state.activities[idx + 1];
        state.activities[idx + 1] = temp;
        saveDraft();
        render();
      }
    });
  });

  // Remove activity
  document.querySelectorAll("[data-remove-activity]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.removeActivity);
      state.activities.splice(idx, 1);
      saveDraft();
      render();
    });
  });

  // Max length for text activities
  document.querySelectorAll("[data-activity-maxlen]").forEach((input) => {
    input.addEventListener("input", () => {
      const idx = Number(input.dataset.activityMaxlen);
      state.activities[idx].maxLength = Number(input.value) || 180;
      saveDraft();
    });
  });

  // Start session
  document.getElementById("start-session")?.addEventListener("click", () => {
    startSession();
  });

  // Export JSON
  document.getElementById("export-json")?.addEventListener("click", () => {
    const session = buildSessionObject();
    if (!session) return;
    downloadText("session.json", JSON.stringify(session, null, 2));
  });

  // Import JSON
  document.getElementById("import-json")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const validation = validateSession(parsed);
      if (!validation.ok) {
        setBanner(document.getElementById("page-status"), validation.errors.join(" "), "warning");
        return;
      }
      state.title = validation.session.title;
      state.description = validation.session.description || "";
      state.activities = validation.session.activities.map((a) => ({
        ...a,
        options: a.options ? [...a.options] : undefined
      }));
      setBanner(document.getElementById("page-status"), "Session imported successfully.", "success");
      saveDraft();
      render();
    } catch {
      setBanner(document.getElementById("page-status"), "Could not read the JSON file.", "warning");
    }
  });
}

function addActivity(type) {
  const id = sanitizeActivityId(`${type}-${nextActivityId}`, nextActivityId);
  nextActivityId++;

  const activity = { id, type, question: "" };

  if (type === "poll" || type === "quiz") {
    activity.options = ["", ""];
    if (type === "quiz") activity.correctIndex = null;
  }

  if (type === "text") {
    activity.maxLength = 180;
  }

  state.activities.push(activity);
  saveDraft();
  render();
}

function buildSessionObject() {
  return {
    title: state.title.trim(),
    description: state.description.trim(),
    activities: state.activities.map((a, i) => {
      const out = {
        id: sanitizeActivityId(a.id || `activity-${i + 1}`, i),
        type: a.type,
        question: a.question.trim()
      };
      if (a.type === "poll" || a.type === "quiz") {
        out.options = (a.options || []).map((o) => o.trim()).filter(Boolean);
      }
      if (a.type === "quiz") {
        out.correctIndex = Number.isInteger(a.correctIndex) ? a.correctIndex : null;
      }
      if (a.type === "text") {
        out.maxLength = a.maxLength || 180;
      }
      return out;
    })
  };
}

function startSession() {
  const session = buildSessionObject();
  const validation = validateSession(session);

  if (!validation.ok) {
    setBanner(document.getElementById("page-status"), validation.errors.join(" "), "warning");
    return;
  }

  saveSessionToStorage(state.roomCode, validation.session);
  window.localStorage.removeItem("seminarsmack:draft-session");

  const url = buildPageUrl("present", {
    room: state.roomCode,
    host: state.hostToken
  });
  window.location.href = url;
}
