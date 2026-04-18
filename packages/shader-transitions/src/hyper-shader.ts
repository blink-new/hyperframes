import {
  createContext,
  setupQuad,
  createProgram,
  createTexture,
  uploadTexture,
  renderShader,
  WIDTH,
  HEIGHT,
  type AccentColors,
} from "./webgl.js";
import { getFragSource, type ShaderName } from "./shaders/registry.js";
import { initCapture, captureScene, captureIncomingScene } from "./capture.js";

declare const gsap: {
  timeline: (opts: Record<string, unknown>) => GsapTimeline;
};

interface GsapTimeline {
  paused: () => boolean;
  play: () => GsapTimeline;
  pause: () => GsapTimeline;
  call: (fn: () => void, args: null, position: number) => GsapTimeline;
  to: (
    target: Record<string, unknown>,
    vars: Record<string, unknown>,
    position: number,
  ) => GsapTimeline;
  set: (target: string, vars: Record<string, unknown>, position?: number) => GsapTimeline;
  from: (target: string, vars: Record<string, unknown>, position?: number) => GsapTimeline;
  fromTo: (
    target: string,
    from: Record<string, unknown>,
    to: Record<string, unknown>,
    position?: number,
  ) => GsapTimeline;
  [key: string]: unknown;
}

export interface TransitionConfig {
  time: number;
  shader: ShaderName;
  duration?: number;
  ease?: string;
}

export interface HyperShaderConfig {
  bgColor: string;
  accentColor?: string;
  scenes: string[];
  transitions: TransitionConfig[];
  timeline?: GsapTimeline;
  compositionId?: string;
}

interface TransState {
  active: boolean;
  prog: WebGLProgram | null;
  fromId: string;
  toId: string;
  progress: number;
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  if (h.length < 6) return [0.5, 0.5, 0.5];
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return [0.5, 0.5, 0.5];
  return [r, g, b];
}

function deriveAccentColors(hex: string): AccentColors {
  const [r, g, b] = parseHex(hex);
  return {
    accent: [r, g, b],
    dark: [r * 0.35, g * 0.35, b * 0.35],
    bright: [Math.min(1, r * 1.5 + 0.2), Math.min(1, g * 1.5 + 0.2), Math.min(1, b * 1.5 + 0.2)],
  };
}

export function init(config: HyperShaderConfig): GsapTimeline {
  const { bgColor, scenes, transitions } = config;

  // Expose transition metadata for the HDR compositing orchestrator
  if (typeof window !== "undefined" && (window as any).__hf) {
    (window as any).__hf.transitions = transitions.map((t: TransitionConfig, i: number) => ({
      time: t.time,
      duration: t.duration ?? 1,
      shader: t.shader,
      ease: t.ease ?? "none",
      fromScene: scenes[i],
      toScene: scenes[i + 1],
    }));
  }

  const accentColors: AccentColors = config.accentColor
    ? deriveAccentColors(config.accentColor)
    : { accent: [1, 0.6, 0.2], dark: [0.4, 0.15, 0], bright: [1, 0.85, 0.5] };

  const root = document.querySelector<HTMLElement>("[data-composition-id]");
  const compId = config.compositionId || root?.getAttribute("data-composition-id") || "main";

  const state: TransState = {
    active: false,
    prog: null,
    fromId: "",
    toId: "",
    progress: 0,
  };

  let glCanvas = document.getElementById("gl-canvas") as HTMLCanvasElement | null;
  if (!glCanvas) {
    glCanvas = document.createElement("canvas");
    glCanvas.id = "gl-canvas";
    glCanvas.width = WIDTH;
    glCanvas.height = HEIGHT;
    glCanvas.style.cssText = `position:absolute;top:0;left:0;width:${WIDTH}px;height:${HEIGHT}px;z-index:100;pointer-events:none;display:none;`;
    (root || document.body).appendChild(glCanvas);
  }

  const gl = createContext(glCanvas);
  if (!gl) {
    console.warn("[HyperShader] WebGL unavailable — shader transitions disabled.");
    const fallback = config.timeline || gsap.timeline({ paused: true });
    registerTimeline(compId, fallback, config.timeline);
    return fallback;
  }

  const quadBuf = setupQuad(gl);

  const programs = new Map<string, WebGLProgram>();
  for (const t of transitions) {
    if (!programs.has(t.shader)) {
      try {
        programs.set(t.shader, createProgram(gl, getFragSource(t.shader)));
      } catch (e) {
        console.error(`[HyperShader] Failed to compile "${t.shader}":`, e);
      }
    }
  }

  const textures = new Map<string, WebGLTexture>();
  for (const id of scenes) {
    textures.set(id, createTexture(gl));
  }

  const tickShader = () => {
    if (state.active && state.prog) {
      const fromTex = textures.get(state.fromId);
      const toTex = textures.get(state.toId);
      if (fromTex && toTex) {
        renderShader(gl, quadBuf, state.prog, fromTex, toTex, state.progress, accentColors);
      }
    }
  };

  let tl: GsapTimeline;
  if (config.timeline) {
    tl = config.timeline;
    const duration = Number(root?.getAttribute("data-duration") || "40");
    tl.to({ t: 0 }, { t: 1, duration, ease: "none", onUpdate: tickShader }, 0);
  } else {
    tl = gsap.timeline({ paused: true, onUpdate: tickShader });
  }

  initCapture();
  glCanvas.style.display = "none";

  const canvasEl = glCanvas;

  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i];
    const fromId = scenes[i];
    const toId = scenes[i + 1];
    if (!fromId || !toId) continue;

    const prog = programs.get(t.shader);
    if (!prog) continue;

    const dur = t.duration ?? 0.7;
    const ease = t.ease ?? "power2.inOut";
    const T = t.time;

    // Pause timeline during async capture to prevent the progress tween
    // from running ahead. Resume once textures are uploaded.
    tl.call(
      () => {
        const fromScene = document.getElementById(fromId);
        const toScene = document.getElementById(toId);
        if (!fromScene || !toScene) return;

        const wasPlaying = !tl.paused();
        if (wasPlaying) tl.pause();

        captureScene(fromScene, bgColor)
          .then((fromCanvas) => {
            const fromTex = textures.get(fromId);
            if (fromTex) uploadTexture(gl, fromTex, fromCanvas);
            return captureIncomingScene(toScene, bgColor);
          })
          .then((toCanvas) => {
            const toTex = textures.get(toId);
            if (toTex) uploadTexture(gl, toTex, toCanvas);

            document.querySelectorAll<HTMLElement>(".scene").forEach((s) => {
              s.style.opacity = "0";
            });
            canvasEl.style.display = "block";
            state.prog = prog;
            state.fromId = fromId;
            state.toId = toId;
            state.progress = 0;
            state.active = true;

            if (wasPlaying) tl.play();
          })
          .catch((e) => {
            console.warn("[HyperShader] Capture failed, falling back to hard cut:", e);
            document.querySelectorAll<HTMLElement>(".scene").forEach((s) => {
              s.style.opacity = "0";
            });
            const scene = document.getElementById(toId);
            if (scene) scene.style.opacity = "1";
            if (wasPlaying) tl.play();
          });
      },
      null,
      T,
    );

    const proxy = { p: 0 };
    tl.to(
      proxy,
      {
        p: 1,
        duration: dur,
        ease,
        onUpdate: () => {
          state.progress = proxy.p;
        },
      },
      T,
    );

    tl.call(
      () => {
        state.active = false;
        canvasEl.style.display = "none";
        const scene = document.getElementById(toId);
        if (scene) scene.style.opacity = "1";
      },
      null,
      T + dur,
    );
  }

  registerTimeline(compId, tl, config.timeline);
  return tl;
}

function registerTimeline(
  compId: string,
  tl: GsapTimeline,
  provided: GsapTimeline | undefined,
): void {
  if (!provided) {
    const w = window as unknown as { __timelines: Record<string, unknown> };
    w.__timelines = w.__timelines || {};
    w.__timelines[compId] = tl;
  }
}
