export const DEMO_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

export interface DemoState {
  email?: string;
  emailVerified?: boolean;
  reservation?: boolean;
  minted?: boolean;
  wallet?: string;
  mintedAt?: string;
}

const STORAGE_KEY = "association-poap-astro-demo-v1";

export function getDemoState(): DemoState {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

export function saveDemoState(next: DemoState): DemoState {
  const merged = { ...getDemoState(), ...next };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

export function resetDemoState() {
  window.localStorage.removeItem(STORAGE_KEY);
}

export const event = {
  slug: "first-pilot",
  title: "8 月線上讀書會",
  date: "2026 年 8 月 9 日",
  location: "線上 · 兆量富足教育協會",
  description: "記錄參與兆量富足教育協會 2026 年 8 月線上讀書會的共同學習時光。",
};
