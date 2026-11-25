import { Bookmark, CheckCircle2, Download, Loader2, Play, Radio } from 'lucide-react';
import {
  formatDuration,
  formatViews,
  type CacheJobStatus,
  type VideoMeta,
} from '../lib/tauri-api';

interface VideoCardProps {
  video: VideoMeta;
  isActive: boolean;
  isCached: boolean;
  isSaved?: boolean;
  isResolving?: boolean;
  error?: string | null;
  jobStatus?: CacheJobStatus;
  onPlay: (video: VideoMeta) => void;
  onQueueCache: (video: VideoMeta) => void;
  onToggleSave?: (video: VideoMeta) => void;
}

const AVATAR_COLORS = [
  'bg-red-600',
  'bg-blue-600',
  'bg-emerald-600',
  'bg-amber-600',
  'bg-violet-600',
  'bg-pink-600',
  'bg-cyan-600',
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function VideoCard({
  video,
  isActive,
  isCached,
  isSaved = false,
  isResolving = false,
  error = null,
  jobStatus,
  onPlay,
  onQueueCache,
  onToggleSave,
}: VideoCardProps) {
  const viewsText = formatViews(video.viewCount);
  const isBusy = jobStatus === 'queued' || jobStatus === 'downloading';
  const isLive = Boolean(video.isLive);
  const initial = (video.channel.trim()[0] ?? 'A').toUpperCase();

  return (
    <article
      onClick={() => onPlay(video)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPlay(video);
        }
      }}
      className={`group flex cursor-pointer flex-col rounded-xl transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
        isActive ? 'bg-white/[0.08] p-1.5 -m-1.5' : 'hover:bg-white/[0.04] p-1.5 -m-1.5'
      }`}
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-[#181818]">
        <img
          src={video.thumbnail}
          alt={video.title}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
        />

        <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors duration-150 group-hover:bg-black/30">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/80 text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100">
            {isResolving ? (
              <Loader2 className="h-5 w-5 animate-spin text-red-500" />
            ) : (
              <Play className="h-5 w-5 fill-current pl-0.5" />
            )}
          </span>
        </div>

        {isLive ? (
          <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded bg-[#cc0000] px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-white shadow">
            <Radio className="h-3 w-3 animate-pulse" />
            LIVE
          </span>
        ) : (
          <span className="tabular-nums absolute bottom-2 right-2 rounded bg-black/85 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-white">
            {formatDuration(video.durationSeconds)}
          </span>
        )}

        {isCached && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-emerald-950/90 px-2 py-0.5 text-[11px] font-medium text-emerald-300 border border-emerald-500/30">
            <CheckCircle2 className="h-3 w-3" />
            1080p
          </span>
        )}
      </div>

      <div className="mt-2.5 flex items-start gap-3">
        <div
          aria-hidden="true"
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${getAvatarColor(
            video.channel,
          )}`}
        >
          {initial}
        </div>

        <div className="min-w-0 flex-1">
          <h3
            title={video.title}
            className="line-clamp-2 text-[14px] font-medium leading-snug text-[#f1f1f1] group-hover:text-white"
          >
            {video.title}
          </h3>
          <p className="mt-1 truncate text-xs text-[#aaaaaa]">{video.channel}</p>
          <div className="flex items-center gap-1.5 text-xs text-[#aaaaaa]">
            {isLive ? (
              <span className="font-medium text-red-400">Sedang Live</span>
            ) : (
              <>
                {viewsText && <span className="tabular-nums">{viewsText}</span>}
                {viewsText && video.uploadDate && <span>•</span>}
                {video.uploadDate && <span className="tabular-nums">{video.uploadDate}</span>}
              </>
            )}
          </div>
          {error && (
            <p className="mt-1 line-clamp-2 text-xs text-red-400" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-center gap-0.5">
          {onToggleSave && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleSave(video);
              }}
              title={isSaved ? 'Hapus dari Tonton Nanti' : 'Simpan ke Tonton Nanti'}
              className={`rounded-full p-1.5 transition-all hover:bg-white/10 ${
                isSaved
                  ? 'text-amber-400 opacity-100'
                  : 'text-[#aaaaaa] opacity-70 hover:text-white group-hover:opacity-100'
              }`}
            >
              <Bookmark className={`h-4 w-4 ${isSaved ? 'fill-current' : ''}`} />
            </button>
          )}

          {!isCached && !isLive && (
            <button
              type="button"
              disabled={isBusy}
              onClick={(e) => {
                e.stopPropagation();
                onQueueCache(video);
              }}
              title="Simpan 1080p MP4 ke cache lokal"
              className="rounded-full p-1.5 text-[#aaaaaa] opacity-70 transition-all hover:bg-white/10 hover:text-white group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isBusy ? (
                <Loader2 className="h-4 w-4 animate-spin text-red-400" />
              ) : (
                <Download className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export function VideoCardSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2.5">
      <div className="aspect-video w-full animate-pulse rounded-xl bg-[#272727]" />
      <div className="flex gap-3">
        <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-[#272727]" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-11/12 animate-pulse rounded bg-[#272727]" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-[#272727]" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-[#212121]" />
        </div>
      </div>
    </div>
  );
}
