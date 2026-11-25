import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Player } from './Player';
import type { StreamResolution, VideoMeta } from '../lib/tauri-api';

afterEach(() => {
  cleanup();
});

const sampleVideo: VideoMeta = {
  id: 'dQw4w9WgXcQ',
  title: 'Aetheris 1080p Playback Demo',
  channel: 'Aetheris Channel',
  durationSeconds: 213,
  thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  viewCount: 52000,
  uploadDate: '20261124',
  isLive: false,
};

const sampleResolution: StreamResolution = {
  videoId: 'dQw4w9WgXcQ',
  streamUrl: 'http://127.0.0.1:4567/vod?url=test',
  localStreamUrl: 'http://127.0.0.1:4567/local?id=dQw4w9WgXcQ',
  cachedPath: null,
  isCached: false,
  qualityLabel: 'Instant Stream',
};

describe('Player', () => {
  it('renders video title, channel, and Instant Stream badge', () => {
    render(
      <Player
        video={sampleVideo}
        resolution={sampleResolution}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Aetheris 1080p Playback Demo')).toBeInTheDocument();
    expect(screen.getByText('Aetheris Channel')).toBeInTheDocument();
    expect(screen.getByText('Instant Stream')).toBeInTheDocument();
    expect(screen.getByLabelText('Seekbar video')).toBeInTheDocument();
    expect(screen.getByText('-10d')).toBeInTheDocument();
    expect(screen.getByText('+10d')).toBeInTheDocument();
  });

  it('shows error state and invokes onRetry / onClose', () => {
    const onRetry = vi.fn();
    const onClose = vi.fn();

    render(
      <Player
        video={sampleVideo}
        resolution={null}
        isLoading={false}
        error="Stream timeout"
        onRetry={onRetry}
        onClose={onClose}
      />,
    );

    expect(screen.getByText('Gagal memutar video')).toBeInTheDocument();
    expect(screen.getByText('Stream timeout')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Coba Lagi'));
    expect(onRetry).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('Tutup pemutar'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows LIVE 1080p badge for live streams', () => {
    render(
      <Player
        video={{ ...sampleVideo, isLive: true, durationSeconds: null }}
        resolution={{ ...sampleResolution, qualityLabel: 'Live 1080p' }}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('LIVE 1080p')).toBeInTheDocument();
    expect(screen.getByText('Siaran Langsung')).toBeInTheDocument();
  });
});
