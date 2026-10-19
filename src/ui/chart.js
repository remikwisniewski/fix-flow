// Trade price chart on Canvas 2D: one buffer of recent trades per symbol, redrawn
// on the next animation frame whenever something changes.

import { formatPrice } from "../engine/fix.js";

const MAX_POINTS = 300;

export function createChart(canvas) {
  const ctx = canvas.getContext("2d");
  const series = new Map();
  let symbol = null;
  let frame = null;
  let width = 0;
  let height = 0;

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    schedule();
  }

  function schedule() {
    if (frame === null) frame = requestAnimationFrame(draw);
  }

  function draw() {
    frame = null;
    ctx.clearRect(0, 0, width, height);
    const points = series.get(symbol) ?? [];
    const padX = 14;
    const axis = 58;
    const top = 16;
    const bottom = height - 18;

    if (points.length < 2) {
      ctx.fillStyle = css("--muted");
      ctx.font = `12px ${css("--font-body")}`;
      ctx.fillText("Waiting for trades…", padX, height / 2);
      return;
    }

    let min = Math.min(...points);
    let max = Math.max(...points);
    const pad = Math.max(2, (max - min) * 0.15);
    min -= pad;
    max += pad;
    const x = (i) => padX + (i / (MAX_POINTS - 1)) * (width - padX - axis);
    const y = (p) => bottom - ((p - min) / (max - min)) * (bottom - top);
    const offset = MAX_POINTS - points.length;

    // Grid and price labels
    ctx.strokeStyle = css("--line");
    ctx.fillStyle = css("--muted");
    ctx.font = `11px ${css("--font-mono")}`;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const price = min + ((max - min) * i) / 4;
      const py = Math.round(y(price)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padX, py);
      ctx.lineTo(width - axis + 6, py);
      ctx.stroke();
      ctx.fillText(formatPrice(Math.round(price)), width - axis + 10, py + 4);
    }

    // Area under the line
    const accent = css("--accent");
    const gradient = ctx.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, "rgba(217, 102, 61, 0.22)");
    gradient.addColorStop(1, "rgba(217, 102, 61, 0)");
    ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(x(i + offset), y(p)) : ctx.lineTo(x(i + offset), y(p))));
    ctx.lineTo(x(points.length - 1 + offset), bottom);
    ctx.lineTo(x(offset), bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Price line
    ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(x(i + offset), y(p)) : ctx.lineTo(x(i + offset), y(p))));
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    ctx.stroke();

    // Last price marker
    const lastX = x(points.length - 1 + offset);
    const lastY = y(points.at(-1));
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  new ResizeObserver(resize).observe(canvas);

  return {
    add(trades) {
      for (const trade of trades) {
        const points = series.get(trade.symbol) ?? [];
        points.push(trade.price);
        if (points.length > MAX_POINTS) points.shift();
        series.set(trade.symbol, points);
      }
      if (trades.some((t) => t.symbol === symbol)) schedule();
    },
    show(next) {
      symbol = next;
      schedule();
    },
  };
}
