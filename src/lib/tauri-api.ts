import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface VideoMeta {
  id: string;
  title: string;
  channel: string;
  durationSeconds: number | null;
  thumbnail: string;
  viewCount: number | null;
  uploadDate: string | null;
  isLive?: boolean;
}

export interface StreamResolution {
  videoId: string;
  streamUrl: string | null;
  localStreamUrl?: string | null;
  cachedPath: string | null;
  isCached: boolean;
  qualityLabel: string;
}

export interface DependencyStatus {
  ytdlpAvailable: boolean;
  ytdlpVersion: string | null;
  ffmpegAvailable: boolean;
}

export type CacheJobStatus = 'queued' | 'downloading' | 'completed' | 'failed';

export interface CacheJobInfo {
  videoId: string;
  title: string;
  status: CacheJobStatus;
  error: string | null;
}

export interface CacheEntry {
  videoId: string;
  title: string;
  filePath: string;
  sizeBytes: number;
  lastAccessedUnix: number;
}

export interface CacheSummary {
  cacheDir: string;
  totalBytes: number;
  maxBytes: number;
  fileCount: number;
  entries: CacheEntry[];
  activeJobs: CacheJobInfo[];
}

export interface CacheAck {
  videoId: string;
  alreadyCached: boolean;
  filePath: string | null;
  status: CacheJobStatus;
}

export interface CacheUpdatedEvent {
  videoId: string;
  status: CacheJobStatus;
}

export function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in window
  );
}

function assertTauri(): void {
  if (!isTauriRuntime()) {
    throw new Error('Desktop backend unavailable (run inside Tauri window via npm run tauri dev).');
  }
}

export function toPlayableSrc(resolution: StreamResolution): string {
  if (resolution.streamUrl) {
    return resolution.streamUrl;
  }
  if (resolution.localStreamUrl) {
    return resolution.localStreamUrl;
  }
  if (resolution.isCached && resolution.cachedPath) {
    return convertFileSrc(resolution.cachedPath);
  }
  throw new Error('No playable stream or cached file path returned.');
}

export function toLocalAssetSrc(filePath: string): string {
  return isTauriRuntime() ? convertFileSrc(filePath) : filePath;
}

export async function checkDependencies(): Promise<DependencyStatus> {
  assertTauri();
  return invoke<DependencyStatus>('check_dependencies');
}

export async function searchVideos(query: string, limit = 16, offset = 0): Promise<VideoMeta[]> {
  assertTauri();
  return invoke<VideoMeta[]>('search_videos', { query, limit, offset });
}

export async function getVideoInfo(videoId: string): Promise<VideoMeta> {
  assertTauri();
  return invoke<VideoMeta>('get_video_info', { videoId });
}

export async function resolveStream(videoId: string, isLive?: boolean): Promise<StreamResolution> {
  assertTauri();
  return invoke<StreamResolution>('resolve_stream', { videoId, isLive: isLive ?? false });
}

export async function getStreamProxyPort(): Promise<number> {
  assertTauri();
  return invoke<number>('get_stream_proxy_port');
}

export async function cacheVideo(videoId: string, title?: string): Promise<CacheAck> {
  assertTauri();
  return invoke<CacheAck>('cache_video', { videoId, title: title ?? null });
}

export async function getCacheSummary(): Promise<CacheSummary> {
  assertTauri();
  return invoke<CacheSummary>('get_cache_summary');
}

export async function removeCachedVideo(videoId: string): Promise<void> {
  assertTauri();
  return invoke<void>('remove_cached_video', { videoId });
}

export async function clearCache(): Promise<number> {
  assertTauri();
  return invoke<number>('clear_cache');
}

export async function onCacheUpdated(
  handler: (payload: CacheUpdatedEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return () => {};
  }
  return listen<CacheUpdatedEvent>('cache-updated', (event) => {
    handler(event.payload);
  });
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'LIVE';
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / 1024 ** idx;
  return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(2)} ${units[idx]}`;
}

export function formatViews(views: number | null): string | null {
  if (views === null || !Number.isFinite(views)) return null;
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1)}M views`;
  if (views >= 1_000) return `${(views / 1_000).toFixed(1)}K views`;
  return `${views} views`;
}
