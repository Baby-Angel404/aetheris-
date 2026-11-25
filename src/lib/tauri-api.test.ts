import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDuration,
  formatViews,
  isTauriRuntime,
  toPlayableSrc,
} from './tauri-api';

describe('tauri-api utilities', () => {
  it('formats durations across seconds, minutes, and hours', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(null)).toBe('LIVE');
  });

  it('formats view counts compactly', () => {
    expect(formatViews(null)).toBeNull();
    expect(formatViews(950)).toBe('950 views');
    expect(formatViews(12_500)).toBe('12.5K views');
    expect(formatViews(2_400_000)).toBe('2.4M views');
  });

  it('formats byte sizes cleanly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB');
  });

  it('resolves playable source preferring streamUrl or localStreamUrl', () => {
    expect(
      toPlayableSrc({
        videoId: 'dQw4w9WgXcQ',
        streamUrl: 'http://127.0.0.1:4567/vod?url=abc',
        localStreamUrl: 'http://127.0.0.1:4567/local?id=dQw4w9WgXcQ',
        cachedPath: null,
        isCached: false,
        qualityLabel: 'Instant Stream',
      }),
    ).toBe('http://127.0.0.1:4567/vod?url=abc');

    expect(() =>
      toPlayableSrc({
        videoId: 'dQw4w9WgXcQ',
        streamUrl: null,
        cachedPath: null,
        isCached: false,
        qualityLabel: 'None',
      }),
    ).toThrow();
  });

  it('detects non-tauri jsdom environment', () => {
    expect(isTauriRuntime()).toBe(false);
  });
});
