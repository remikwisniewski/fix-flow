// Short notices for fills, rejects and session events.

import { gsap } from "gsap";
import { escapeHtml } from "./format.js";

export function createToasts(container, { reducedMotion }) {
  return function toast(text, kind = "info") {
    const el = document.createElement("div");
    el.className = `toast toast--${kind}`;
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.innerHTML = escapeHtml(text);
    container.append(el);
    while (container.children.length > 3) container.firstElementChild.remove();

    if (!reducedMotion) gsap.from(el, { y: 16, autoAlpha: 0, duration: 0.35, ease: "power3.out" });
    setTimeout(() => {
      if (reducedMotion) return el.remove();
      gsap.to(el, { autoAlpha: 0, y: 8, duration: 0.3, onComplete: () => el.remove() });
    }, 3600);
  };
}
