import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoCard } from './VideoCard';
import type { VideoMeta } from '../lib/tauri-api';

afterEach(() => {
  cleanup();
});

const sampleVod: VideoMeta = {
  id: 'dQw4w9WgXcQ',
  title: 'Rust & Tauri Architecture Deep Dive',
  channel: 'Systems Lab',
  durationSeconds: 325,
  thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  viewCount: 145000,
  uploadDate: '20261120',
  isLive: false,
};

const sampleLive: VideoMeta = {
  ...sampleVod,
  id: '36YnV9STBqc',
  title: '24/7 Chill Lofi Radio Live',
  durationSeconds: null,
  isLive: true,
};

describe('VideoCard', () => {
  it('renders VOD metadata and triggers onPlay when clicked', () => {
    const onPlay = vi.fn();
    const onQueueCache = vi.fn();

    render(
      <VideoCard
        video={sampleVod}
        isActive={false}
        isCached={false}
        onPlay={onPlay}
        onQueueCache={onQueueCache}
      />,
    );

    expect(screen.getByText('Rust & Tauri Architecture Deep Dive')).toBeInTheDocument();
    expect(screen.getByText('Systems Lab')).toBeInTheDocument();
    expect(screen.getByText('5:25')).toBeInTheDocument();
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Rust & Tauri Architecture Deep Dive'));
    expect(onPlay).toHaveBeenCalledWith(sampleVod);
    expect(onQueueCache).not.toHaveBeenCalled();
  });

  it('queues cache without triggering play when download button clicked', () => {
    const onPlay = vi.fn();
    const onQueueCache = vi.fn();

    render(
      <VideoCard
        video={sampleVod}
        isActive={false}
        isCached={false}
        onPlay={onPlay}
        onQueueCache={onQueueCache}
      />,
    );

    const downloadBtn = screen.getByTitle('Simpan 1080p MP4 ke cache lokal');
    fireEvent.click(downloadBtn);

    expect(onQueueCache).toHaveBeenCalledWith(sampleVod);
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('renders LIVE badge for live streams and hides download button', () => {
    render(
      <VideoCard
        video={sampleLive}
        isActive={false}
        isCached={false}
        onPlay={vi.fn()}
        onQueueCache={vi.fn()}
      />,
    );

    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(screen.getByText('Sedang Live')).toBeInTheDocument();
    expect(screen.queryByTitle('Simpan 1080p MP4 ke cache lokal')).not.toBeInTheDocument();
  });
});
