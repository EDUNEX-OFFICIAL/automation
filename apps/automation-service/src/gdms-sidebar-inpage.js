/**
 * Pure browser script — loaded via addInitScript (never serialized through tsx).
 * globalThis.__gdmsSidebarEval({ mode: "collect" } | { mode: "click", fp })
 */
globalThis.__gdmsSidebarEval = function (arg) {
  const payload = arg;
  const EXCLUDE = /progress|irx_progress|byte/i;
  const MAX_ONCLICK = 200;
  const RAIL_ROOT_SEL =
    "li.nav_sal, .nav_sal, [class*='gnb'], [class*='sidenav'], [class*='sidebar'], nav, aside";

  const isVisible = (el) => {
    const s = window.getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8;
  };

  const isExcluded = (el) => {
    const blob = `${el.className} ${el.id} ${el.getAttribute("onclick") ?? ""}`;
    return EXCLUDE.test(blob);
  };

  const isClickable = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "a" || tag === "button" || tag === "li") return true;
    if (el.getAttribute("onclick")) return true;
    if (el.getAttribute("role") === "button") return true;
    return false;
  };

  const inLeftRailBand = (el, rootRect) => {
    const r = el.getBoundingClientRect();
    const leftLimit = Math.min(rootRect.left + 110, 150);
    return r.left <= leftLimit && r.width < 100 && r.height >= 16 && r.height <= 96;
  };

  const visibleClickableSiblings = (parent) => {
    const out = [];
    for (const child of Array.from(parent.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (!isVisible(child) || isExcluded(child)) continue;
      if (isClickable(child)) {
        out.push(child);
        continue;
      }
      const nested = child.querySelector("a, button, li, [onclick], [role='button']");
      if (nested && isVisible(nested) && !isExcluded(nested)) out.push(nested);
    }
    return out;
  };

  const inNavContainer = (el) => {
    let node = el;
    for (let depth = 0; depth < 8 && node; depth++) {
      const cls = typeof node.className === "string" ? node.className : "";
      if (/nav_sal|gnb|sidenav|sidebar/i.test(cls)) return true;
      node = node.parentElement;
    }
    return false;
  };

  const candidateFromElement = (el, parent) => {
    if (!isClickable(el) || !isVisible(el) || isExcluded(el)) return null;
    const r = el.getBoundingClientRect();
    const sibs = visibleClickableSiblings(parent);
    const siblingIndex = sibs.indexOf(el);
    if (siblingIndex < 0) return null;
    return {
      domIndex: 0,
      tag: el.tagName.toLowerCase(),
      id: el.id ?? "",
      className: typeof el.className === "string" ? el.className : "",
      title: el.getAttribute("title") ?? "",
      ariaLabel: el.getAttribute("aria-label") ?? "",
      href: el.getAttribute("href") ?? "",
      onclick: (el.getAttribute("onclick") ?? "").slice(0, MAX_ONCLICK),
      parentTag: parent.tagName.toLowerCase(),
      parentClass: typeof parent.className === "string" ? parent.className : "",
      siblingIndex,
      parentRailSiblings: sibs.length,
      inNavContainer: inNavContainer(el),
      hasSvg: Boolean(el.querySelector("svg")),
      hasImg: Boolean(el.querySelector("img")),
      textContent: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
      x: Math.round(r.x),
      y: Math.round(r.y),
    };
  };

  const collect = () => {
    const seen = new Set();
    const raw = [];

    const pushCandidate = (el, parent) => {
      const c = candidateFromElement(el, parent);
      if (!c) return;
      const key = `${c.tag}|${c.id}|${c.className}|${c.x}|${c.y}`;
      if (seen.has(key)) return;
      seen.add(key);
      raw.push(c);
    };

    const roots = [];
    for (const root of Array.from(document.querySelectorAll(RAIL_ROOT_SEL))) {
      if (isVisible(root)) roots.push(root);
    }
    if (!roots.length && document.body) roots.push(document.body);

    for (const root of roots) {
      const rootRect = root.getBoundingClientRect();
      if (rootRect.width > 400 && rootRect.left > 180) continue;
      for (const el of Array.from(
        root.querySelectorAll("a, button, li, [onclick], [role='button']"),
      )) {
        if (!(el instanceof HTMLElement)) continue;
        if (!inLeftRailBand(el, rootRect)) continue;
        const parent = el.parentElement;
        if (!parent) continue;
        pushCandidate(el, parent);
      }
    }

    if (raw.length < 2) {
      for (const el of Array.from(
        document.querySelectorAll("a, button, li, [onclick], [role='button']"),
      )) {
        if (!(el instanceof HTMLElement)) continue;
        const r = el.getBoundingClientRect();
        if (r.x >= 150 || r.width >= 100 || r.height < 16 || r.height > 96) continue;
        const parent = el.parentElement;
        if (!parent) continue;
        pushCandidate(el, parent);
      }
    }

    raw.sort((a, b) => a.y - b.y || a.x - b.x);
    return raw.map((c, i) => ({ ...c, domIndex: i }));
  };

  const clickByFingerprint = (fp) => {
    for (const el of Array.from(
      document.querySelectorAll("li.nav_sal, a, button, li, [onclick], [role='button']"),
    )) {
      if (!(el instanceof HTMLElement)) continue;
      if (!isVisible(el) || isExcluded(el)) continue;
      if (/nav_sal_mis/i.test(el.className)) continue;
      const r = el.getBoundingClientRect();
      if (
        el.tagName.toLowerCase() === fp.tag &&
        (el.id ?? "") === fp.id &&
        (typeof el.className === "string" ? el.className : "") === fp.className &&
        Math.round(r.x) === fp.x &&
        Math.round(r.y) === fp.y
      ) {
        el.click();
        return true;
      }
    }
    return false;
  };

  if (payload.mode === "collect") return collect();
  return clickByFingerprint(payload.fp);
};
