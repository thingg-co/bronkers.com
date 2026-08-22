// DOM helpers, formatting, toasts, modals. No framework; no build.
import { formatUnits } from "https://esm.sh/viem@2.21.19";

export const $ = (id) => document.getElementById(id);

/** el('div', {class:'x', onclick, html}, ...children) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "style" && typeof v === "object") for (const [sk, sv] of Object.entries(v)) (sk.startsWith("--") ? node.style.setProperty(sk, sv) : (node.style[sk] = sv));
    else node.setAttribute(k, v === true ? "" : v);
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const c of [].concat(...children)) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ---- formatting ----
const nf = (max = 2, min = 0) => new Intl.NumberFormat(undefined, { maximumFractionDigits: max, minimumFractionDigits: min });

export const fmt = {
  /** bigint wei -> "12,345.67" (auto precision for small numbers) */
  amt(v, decimals = 18, max) {
    const n = Number(formatUnits(v ?? 0n, decimals));
    if (max == null) max = Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 1 ? 2 : 4;
    return nf(max).format(n);
  },
  usd(v, sym = "mUSDC", decimals = 18) {
    return `${fmt.amt(v, decimals)} ${sym}`;
  },
  num(n, max = 2) {
    return nf(max).format(Number(n));
  },
  pct(x, digits = 1, signed = true) {
    const n = Number(x) * 100;
    if (!isFinite(n)) return "–";
    const s = nf(digits).format(Math.abs(n));
    return `${signed ? (n > 0 ? "+" : n < 0 ? "−" : "") : ""}${s}%`;
  },
  bps(bps) {
    return `${(Number(bps) / 100).toFixed(Number(bps) % 100 ? 2 : 0)}%`;
  },
  addr(a, n = 4) {
    if (!a) return "–";
    return `${a.slice(0, 2 + n)}…${a.slice(-n)}`;
  },
  hash(h) {
    return h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "–";
  },
  when(ts) {
    if (!ts) return "–";
    const d = Date.now() / 1000 - ts;
    if (d < 60) return "just now";
    if (d < 3600) return `${Math.floor(d / 60)} min ago`;
    if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
    if (d < 86400 * 30) return `${Math.floor(d / 86400)} d ago`;
    return new Date(ts * 1000).toLocaleDateString();
  },
  date(ts) {
    return ts ? new Date(ts * 1000).toLocaleString() : "–";
  },
  duration(sec) {
    sec = Number(sec);
    if (sec <= 0) return "0";
    if (sec < 3600) return `${Math.round(sec / 60)} min`;
    if (sec < 86400) return `${Math.round(sec / 3600)} h`;
    return `${Math.round(sec / 86400)} d`;
  },
};

// ---- small components ----
export function sparkline(values, { width = 240, height = 48, cls = "" } = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("sparkline");
  if (cls) svg.classList.add(cls);
  const vals = values.filter((v) => isFinite(v));
  if (vals.length < 2) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", 0);
    line.setAttribute("x2", width);
    line.setAttribute("y1", height / 2);
    line.setAttribute("y2", height / 2);
    svg.appendChild(line);
    return svg;
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * width},${height - 3 - ((v - min) / span) * (height - 6)}`);
  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  poly.setAttribute("points", pts.join(" "));
  svg.appendChild(poly);
  svg.classList.add(vals[vals.length - 1] >= vals[0] ? "up" : "down");
  return svg;
}

export function badge(text, kind = "") {
  return el("span", { class: `badge ${kind}`.trim() }, text);
}

export function progress(ratio, label) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return el("div", { class: "progress", title: label },
    el("div", { class: "progress-bar", style: { width: `${pct}%` } }),
    label ? el("span", { class: "progress-label" }, label) : null);
}

export function kv(rows) {
  return el("dl", { class: "kv" }, rows.filter(Boolean).map(([k, v, title]) => [
    el("dt", { title }, k),
    el("dd", {}, v),
  ]));
}

/** A small ⓘ with a native tooltip; keyboard-focusable so the hint is reachable without a mouse. */
export function tip(text) {
  if (!text) return null;
  return el("span", { class: "tip", tabindex: "0", role: "note", title: text, "aria-label": text }, "ⓘ");
}

export function copyBtn(text, label = "copy") {
  return el("button", {
    class: "btn-ghost tiny", type: "button", title: "Copy to clipboard",
    onclick: async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        toast("Copied", "ok", 1500);
      } catch {
        toast("Could not copy", "err");
      }
    },
  }, label);
}

export function addrChip(addr, { explorer, short = true } = {}) {
  const span = el("span", { class: "addr" }, short ? fmt.addr(addr) : addr);
  if (!addr) return span;
  const inner = explorer ? el("a", { href: `${explorer}/address/${addr}`, target: "_blank", rel: "noopener", class: "addr" }, short ? fmt.addr(addr) : addr) : span;
  return el("span", { class: "addr-chip", title: addr }, inner, copyBtn(addr, "⧉"));
}

export function emptyState(text, extra) {
  return el("div", { class: "empty" }, el("p", {}, text), extra || null);
}

export function spinner(text = "Loading…") {
  return el("div", { class: "loading" }, el("span", { class: "spin" }), " ", text);
}

// ---- toasts ----
let toastHost;
export function toast(msg, kind = "info", ms = 4000) {
  if (!toastHost) {
    toastHost = el("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.appendChild(toastHost);
  }
  const t = el("div", { class: `toast ${kind}` }, msg);
  toastHost.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, ms);
  return t;
}

// ---- modal ----
let openModal = null;
export function modal({ title, body, actions = [], onClose, wide = false }) {
  if (openModal) openModal.close();
  const content = el("div", { class: "modal-body" });
  const actionsEl = el("div", { class: "modal-actions" });
  const box = el("div", { class: `modal ${wide ? "wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title },
    el("div", { class: "modal-head" },
      el("h3", {}, title),
      el("button", { class: "btn-ghost", type: "button", "aria-label": "Close", onclick: () => api.close() }, "✕")),
    content,
    actionsEl);
  const backdrop = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) api.close(); } }, box);
  const api = {
    el: box,
    body: content,
    setBody(node) {
      clear(content);
      append(content, [node]);
    },
    setActions(list) {
      clear(actionsEl);
      for (const a of list) {
        actionsEl.appendChild(el("button", {
          class: `btn ${a.kind || ""}`.trim(), type: "button", disabled: a.disabled,
          onclick: async () => {
            if (a.onClick) await a.onClick(api);
            if (a.close !== false && !a.onClick) api.close();
          },
        }, a.label));
      }
    },
    close() {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      if (openModal === api) openModal = null;
      onClose && onClose();
    },
  };
  const onKey = (e) => { if (e.key === "Escape") api.close(); };
  document.addEventListener("keydown", onKey);
  api.setBody(body);
  api.setActions(actions);
  document.body.appendChild(backdrop);
  openModal = api;
  return api;
}

/** Amount input with a "max" helper. Returns {el, value()} where value() is the raw string. */
export function amountField({ label, max, maxLabel, placeholder = "0.00", sym = "mUSDC", value = "", tip: tipText }) {
  const input = el("input", { type: "text", inputmode: "decimal", placeholder, value, class: "amount", title: tipText || null });
  const maxBtn = max != null ? el("button", { type: "button", class: "btn-ghost tiny", onclick: () => { input.value = max; input.dispatchEvent(new Event("input")); } }, maxLabel || `max ${max}`) : null;
  const wrap = el("label", { class: "field" },
    el("span", { class: "field-label" }, el("span", {}, label, " ", tip(tipText)), maxBtn),
    el("span", { class: "field-input" }, input, el("span", { class: "field-sym" }, sym)));
  return { el: wrap, input, value: () => input.value.trim() };
}

export function textField({ label, placeholder = "", value = "", hint, type = "text", mono = false, rows, tip: tipText }) {
  const input = rows
    ? el("textarea", { placeholder, rows, class: mono ? "mono" : "", title: tipText || null }, value)
    : el("input", { type, placeholder, value, class: mono ? "mono" : "", title: tipText || null });
  const wrap = el("label", { class: "field" },
    el("span", { class: "field-label" }, el("span", {}, label, " ", tip(tipText))),
    input,
    hint ? el("span", { class: "field-hint" }, hint) : null);
  return { el: wrap, input, value: () => input.value.trim() };
}
