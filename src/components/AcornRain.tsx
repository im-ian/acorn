import { useEffect, useState } from "react";
import acornUrl from "../assets/acorn-trimmed.png";

interface Acorn {
  id: number;
  leftPct: number;
  size: number;
  duration: number;
  delay: number;
  rotateStart: number;
  rotateEnd: number;
  swayPx: number;
}

const MIN_COUNT = 70;
const MAX_COUNT = 120;
const MIN_SIZE = 28;
const MAX_SIZE = 96;
const MIN_DURATION = 4.5;
const MAX_DURATION = 8.5;
const MAX_DELAY = 3.5;
const MAX_TOTAL = (MAX_DURATION + MAX_DELAY) * 1000 + 200;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function buildBatch(): Acorn[] {
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const count = reduced
    ? Math.floor(MIN_COUNT / 2)
    : Math.floor(rand(MIN_COUNT, MAX_COUNT));
  const seed = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: seed + i,
    leftPct: rand(-2, 102),
    size: Math.round(rand(MIN_SIZE, MAX_SIZE)),
    duration: rand(MIN_DURATION, MAX_DURATION),
    delay: rand(0, reduced ? 0.2 : MAX_DELAY),
    rotateStart: rand(-180, 180),
    rotateEnd: rand(-720, 720),
    swayPx: rand(-80, 80),
  }));
}

export function AcornRain() {
  const [batches, setBatches] = useState<Map<number, Acorn[]>>(new Map());

  useEffect(() => {
    function handler() {
      const batchId = Date.now() + Math.random();
      const acorns = buildBatch();
      setBatches((prev) => {
        const next = new Map(prev);
        next.set(batchId, acorns);
        return next;
      });
      window.setTimeout(() => {
        setBatches((prev) => {
          const next = new Map(prev);
          next.delete(batchId);
          return next;
        });
      }, MAX_TOTAL);
    }
    window.addEventListener("acorn:shake-tree", handler);
    return () => window.removeEventListener("acorn:shake-tree", handler);
  }, []);

  if (batches.size === 0) return null;

  const all: Acorn[] = [];
  for (const arr of batches.values()) all.push(...arr);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[100] overflow-hidden"
    >
      <style>{ACORN_KEYFRAMES}</style>
      {all.map((a) => (
        <img
          key={a.id}
          src={acornUrl}
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            top: 0,
            left: `${a.leftPct}%`,
            width: `${a.size}px`,
            height: "auto",
            // CSS custom props consumed by the keyframes below.
            ["--rs" as never]: `${a.rotateStart}deg`,
            ["--re" as never]: `${a.rotateEnd}deg`,
            ["--sway" as never]: `${a.swayPx}px`,
            animation: `acorn-fall ${a.duration}s cubic-bezier(0.45,0.05,0.55,0.95) ${a.delay}s both`,
            willChange: "transform",
            userSelect: "none",
          }}
        />
      ))}
    </div>
  );
}

const ACORN_KEYFRAMES = `
@keyframes acorn-fall {
  0% {
    transform: translate3d(0, -40vh, 0) rotate(var(--rs));
    opacity: 1;
  }
  100% {
    transform: translate3d(var(--sway), 120vh, 0) rotate(var(--re));
    opacity: 1;
  }
}
`;
