import type { VideoMeta } from './tauri-api';

const HISTORY_KEY = 'aetheris.history.v1';
const WATCH_LATER_KEY = 'aetheris.watchLater.v1';
const LIKED_KEY = 'aetheris.liked.v1';
const AUTOPLAY_KEY = 'aetheris.autoplay.v1';
const MAX_HISTORY_ITEMS = 60;

function readJsonList(key: string): VideoMeta[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as VideoMeta[]) : [];
  } catch {
    return [];
  }
}

function writeJsonList(key: string, items: VideoMeta[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadHistory(): VideoMeta[] {
  return readJsonList(HISTORY_KEY);
}

export function pushHistory(video: VideoMeta): VideoMeta[] {
  const current = readJsonList(HISTORY_KEY).filter((v) => v.id !== video.id);
  const next = [video, ...current].slice(0, MAX_HISTORY_ITEMS);
  writeJsonList(HISTORY_KEY, next);
  return next;
}

export function clearHistoryStorage(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.removeItem(HISTORY_KEY);
}

export function loadWatchLater(): VideoMeta[] {
  return readJsonList(WATCH_LATER_KEY);
}

export function toggleWatchLaterStorage(video: VideoMeta): { items: VideoMeta[]; saved: boolean } {
  const current = readJsonList(WATCH_LATER_KEY);
  const exists = current.some((v) => v.id === video.id);
  const next = exists ? current.filter((v) => v.id !== video.id) : [video, ...current];
  writeJsonList(WATCH_LATER_KEY, next);
  return { items: next, saved: !exists };
}

export function loadLiked(): VideoMeta[] {
  return readJsonList(LIKED_KEY);
}

export function toggleLikedStorage(video: VideoMeta): { items: VideoMeta[]; liked: boolean } {
  const current = readJsonList(LIKED_KEY);
  const exists = current.some((v) => v.id === video.id);
  const next = exists ? current.filter((v) => v.id !== video.id) : [video, ...current];
  writeJsonList(LIKED_KEY, next);
  return { items: next, liked: !exists };
}

export function loadAutoplay(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return true;
  const raw = window.localStorage.getItem(AUTOPLAY_KEY);
  return raw === null ? true : raw === 'true';
}

export function saveAutoplay(enabled: boolean): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(AUTOPLAY_KEY, String(enabled));
}
