// The FIX inspector: every message that crossed the wire, in both directions.
// Selecting one validates its framing and decodes each field with the dictionary.

import { describeField, msgTypeName } from "../engine/dictionary.js";
import { decode } from "../engine/fix.js";
import { category, escapeHtml, formatClock, highlightRaw, summarize } from "./format.js";

const MAX_MESSAGES = 400;

export function createInspector({ listEl, detailEl, filtersEl }) {
  const messages = [];
  let filter = "all";
  let selected = null;
  let nextId = 1;

  const visible = () => messages.filter((m) => filter === "all" || m.category === filter);

  const isProblem = (m) =>
    !m.ok || m.type === "3" || m.type === "9" || (m.type === "8" && m.parsed.get(150) === "8");

  const item = (m) => `<li>
      <button type="button" class="msg${isProblem(m) ? " msg--error" : ""}"
        data-id="${m.id}" aria-selected="${m.id === selected}">
        <span class="msg__dir msg__dir--${m.dir}" aria-label="${m.dir === "out" ? "Sent" : "Received"}">${m.dir === "out" ? "↑" : "↓"}</span>
        <span class="msg__time">${formatClock(m.time)}</span>
        <span class="msg__type">35=${escapeHtml(m.type)}</span>
        <span class="msg__summary">${escapeHtml(m.summary)}</span>
      </button>
    </li>`;

  function renderList() {
    listEl.innerHTML = visible().map(item).join("");
  }

  function renderDetail() {
    const m = messages.find((x) => x.id === selected);
    if (!m) return;
    const rows = m.parsed.fields
      .map(([tag, value]) => {
        const { name, meaning } = describeField(tag, value);
        const frame = tag === 8 || tag === 9 || tag === 10;
        return `<tr class="${frame ? "is-header" : ""}"><td>${tag}</td><td>${escapeHtml(name)}</td>
          <td>${escapeHtml(value)}</td><td>${escapeHtml(meaning ?? "")}</td></tr>`;
      })
      .join("");

    detailEl.innerHTML = `
      <div class="detail__head">
        <p class="detail__title">${m.dir === "out" ? "Sent" : "Received"} · ${escapeHtml(msgTypeName(m.type))}</p>
        <span class="detail__check${m.ok ? "" : " detail__check--bad"}">
          ${m.ok ? "✓ BodyLength and CheckSum verified" : `✕ ${escapeHtml(m.error)}`}
        </span>
      </div>
      <pre class="detail__raw">${highlightRaw(m.raw)}</pre>
      <table class="fields">
        <thead><tr><th>Tag</th><th>Field</th><th>Value</th><th>Meaning</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function select(id) {
    selected = id;
    for (const el of listEl.querySelectorAll("[data-id]")) {
      el.setAttribute("aria-selected", String(Number(el.dataset.id) === id));
    }
    renderDetail();
  }

  listEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-id]");
    if (button) select(Number(button.dataset.id));
  });

  listEl.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const list = visible();
    const at = list.findIndex((m) => m.id === selected);
    const next = list[Math.max(0, Math.min(list.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      select(next.id);
      listEl.querySelector(`[data-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
    }
  });

  filtersEl.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-filter]");
    if (!chip) return;
    filter = chip.dataset.filter;
    for (const el of filtersEl.querySelectorAll("[data-filter]")) {
      el.setAttribute("aria-pressed", String(el === chip));
    }
    renderList();
  });

  return {
    add(dir, raw) {
      const result = decode(raw);
      const m = {
        id: nextId++,
        dir,
        raw,
        time: Date.now(),
        parsed: result.message,
        type: result.message.type,
        ok: result.ok,
        error: result.ok ? null : result.error,
        summary: summarize(result.message),
        category: category(result.message.type),
      };
      messages.push(m);
      if (messages.length > MAX_MESSAGES) messages.shift();

      const follow = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
      if (filter === "all" || filter === m.category) {
        listEl.insertAdjacentHTML("beforeend", item(m));
        if (listEl.children.length > MAX_MESSAGES) listEl.firstElementChild.remove();
        if (follow) listEl.scrollTop = listEl.scrollHeight;
      }
      // Show something useful straight away: the first order the user sends.
      if (selected === null && m.type === "D") select(m.id);
      return m;
    },
  };
}
