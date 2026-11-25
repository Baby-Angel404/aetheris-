import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Bookmark,
  CheckCircle2,
  Download,
  HardDrive,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Share2,
  SkipForward,
  ThumbsUp,
  Volume2,
  VolumeX,
  Wifi,
  X,
} from 'lucide-react';
import {
  formatDuration,
  formatViews,
  toLocalAssetSrc,
  toPlayableSrc,
  type CacheJobStatus,
  type StreamResolution,
  type VideoMeta,
} from '../lib/tauri-api';

interface PlayerProps {
  video: VideoMeta;
  resolution: StreamResolution | null;
  isLoading: boolean;
  error: string | null;
  jobStatus?: CacheJobStatus;
  cachedFilePath?: string;
  isLiked?: boolean;
  isSaved?: boolean;
  hasNext?: boolean;
  onToggleLike?: () => void;
  onToggleSave?: () => void;
  onQueueCache?: () => void;
  onShare?: () => void;
  onNext?: () => void;
  onEnded?: () => void;
  onRetry: () => void;
  onClose: () => void;
}

const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function Player({
  video,
  resolution,
  isLoading,
  error,
  jobStatus,
  cachedFilePath,
  isLiked = false,
  isSaved = false,
  hasNext = false,
  onToggleLike,
  onToggleSave,
  onQueueCache,
  onShare,
  onNext,
  onEnded,
  onRetry,
  onClose,
}: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const hideControlsTimerRef = useRef<number | null>(null);
  const pendingResumeRef = useRef<{ time: number; shouldPlay: boolean } | null>(null);
  const [activeSrc, setActiveSrc] = useState<string | null>(null);
  const [baseVodSrc, setBaseVodSrc] = useState<string | null>(null);
  const [vodSeekBase, setVodSeekBase] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState<number | null>(video.durationSeconds);
  const [isPaused, setIsPaused] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isUsingLocalCache, setIsUsingLocalCache] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const isLive = Boolean(video.isLive);
  const effectiveDuration =
    videoDuration && Number.isFinite(videoDuration) && videoDuration > 0
      ? videoDuration
      : video.durationSeconds ?? 0;

  // Set initial source when resolution arrives
  useEffect(() => {
    setMediaError(null);
    pendingResumeRef.current = null;
    setVodSeekBase(0);
    setCurrentTime(0);
    setVideoDuration(video.durationSeconds);
    if (!resolution) {
      setActiveSrc(null);
      setBaseVodSrc(null);
      setIsUsingLocalCache(false);
      return;
    }

    try {
      const nextSrc = toPlayableSrc(resolution);
      setActiveSrc(nextSrc);
      setBaseVodSrc(resolution.isCached ? null : nextSrc);
      setIsUsingLocalCache(resolution.isCached);
    } catch (e) {
      setMediaError(e instanceof Error ? e.message : 'Unable to initialize playback source');
    }
  }, [resolution, video.durationSeconds]);

  const seekTo = useCallback(
    (targetSeconds: number) => {
      if (isLive) return;
      const maxDur = effectiveDuration > 0 ? effectiveDuration : targetSeconds;
      const clamped = Math.max(0, Math.min(maxDur, targetSeconds));
      const el = videoRef.current;

      if (isUsingLocalCache && el && Number.isFinite(el.duration) && el.duration > 0) {
        el.currentTime = clamped;
        setCurrentTime(clamped);
        return;
      }

      if (baseVodSrc && baseVodSrc.includes('/vod?')) {
        const cleanBase = baseVodSrc.split('&t=')[0];
        setVodSeekBase(clamped);
        setCurrentTime(clamped);
        setActiveSrc(`${cleanBase}&t=${clamped.toFixed(2)}`);
      } else if (el && Number.isFinite(el.duration) && el.duration > 0) {
        el.currentTime = clamped;
        setCurrentTime(clamped);
      }
    },
    [isLive, effectiveDuration, isUsingLocalCache, baseVodSrc],
  );

  // Upgrade seamlessly from progressive stream to 1080p cached WebM when download finishes
  useEffect(() => {
    if (!cachedFilePath || isUsingLocalCache) return;

    const nextLocalSrc = resolution?.localStreamUrl ?? toLocalAssetSrc(cachedFilePath);
    const el = videoRef.current;
    if (el) {
      pendingResumeRef.current = {
        time: vodSeekBase + (Number.isFinite(el.currentTime) ? el.currentTime : 0),
        shouldPlay: !el.paused,
      };
    }
    setVodSeekBase(0);
    setActiveSrc(nextLocalSrc);
    setIsUsingLocalCache(true);
  }, [cachedFilePath, isUsingLocalCache, resolution, vodSeekBase]);

  const toggleFullscreen = useCallback(() => {
    const container = playerContainerRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void container.requestFullscreen().catch(() => {});
    }
  }, []);

  const revealControls = useCallback(() => {
    setShowControls(true);
    if (hideControlsTimerRef.current !== null) {
      window.clearTimeout(hideControlsTimerRef.current);
    }
    hideControlsTimerRef.current = window.setTimeout(() => {
      setShowControls(false);
    }, 2500);
  }, []);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
      revealControls();
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      if (hideControlsTimerRef.current !== null) {
        window.clearTimeout(hideControlsTimerRef.current);
      }
    };
  }, [revealControls]);

  // YouTube-style keyboard shortcuts when player is active
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const el = videoRef.current;
      if (!el) return;

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          revealControls();
          if (el.paused) void el.play().catch(() => {});
          else el.pause();
          break;
        case 'm':
          revealControls();
          el.muted = !el.muted;
          break;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'arrowleft':
          e.preventDefault();
          revealControls();
          seekTo(currentTime - 5);
          break;
        case 'arrowright':
          e.preventDefault();
          revealControls();
          seekTo(currentTime + 5);
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentTime, revealControls, seekTo, toggleFullscreen]);

  // Autoplay with muted fallback for strict WebViews (macOS WKWebView / WebKitGTK)
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !activeSrc || error || mediaError) return;

    const tryAutoPlay = () => {
      void el.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'NotAllowedError' && !el.muted) {
          el.muted = true;
          void el.play().catch(() => {});
        }
      });
    };

    el.addEventListener('canplay', tryAutoPlay, { once: true });
    return () => el.removeEventListener('canplay', tryAutoPlay);
  }, [activeSrc, error, mediaError]);

  const statusBadge = (() => {
    if (isLive) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#cc0000] px-2.5 py-1 text-xs font-semibold text-white">
          <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
          LIVE 1080p
        </span>
      );
    }
    if (isUsingLocalCache) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-950/60 px-2.5 py-1 text-xs font-medium text-emerald-300">
          <HardDrive className="h-3.5 w-3.5" />
          1080p HD Cached
        </span>
      );
    }
    if (jobStatus === 'downloading' || jobStatus === 'queued') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-950/50 px-2.5 py-1 text-xs font-medium text-amber-200">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Memuat 1080p HD...
        </span>
      );
    }
    if (jobStatus === 'completed') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-950/60 px-2.5 py-1 text-xs font-medium text-emerald-300">
          <CheckCircle2 className="h-3.5 w-3.5" />
          1080p HD Siap
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-[#272727] px-2.5 py-1 text-xs font-medium text-[#f1f1f1]">
        <Wifi className="h-3.5 w-3.5 text-red-400" />
        Instant Stream
      </span>
    );
  })();

  const viewsText = formatViews(video.viewCount);
  const channelInitial = (video.channel.trim()[0] ?? 'A').toUpperCase();

  return (
    <section
      aria-label="Active video player"
      className="space-y-3"
    >
      <div
        ref={playerContainerRef}
        onMouseMove={revealControls}
        onMouseLeave={() => {
          if (!isPaused) setShowControls(false);
        }}
        className={`relative w-full overflow-hidden bg-black shadow-lg ${
          isFullscreen ? 'h-screen w-screen rounded-none' : 'aspect-video rounded-xl'
        }`}
      >
        {isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 text-sm text-[#f1f1f1]">
            <Loader2 className="h-7 w-7 animate-spin text-[#ff0033]" />
            <span>Menyiapkan stream...</span>
          </div>
        )}

        {(error || mediaError) && !isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#121212] p-6 text-center">
            <AlertCircle className="h-7 w-7 text-red-500" />
            <div className="max-w-md space-y-1">
              <p className="text-sm font-medium text-white">Gagal memutar video</p>
              <p className="text-xs text-[#aaaaaa]">{error ?? mediaError}</p>
            </div>
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#272727] px-4 py-2 text-xs font-medium text-white hover:bg-[#3f3f3f]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Coba Lagi
            </button>
          </div>
        )}

        {activeSrc && !error && !mediaError && (
          <video
            key={activeSrc}
            ref={videoRef}
            src={activeSrc}
            poster={video.thumbnail}
            autoPlay
            playsInline
            onClick={() => {
              const el = videoRef.current;
              if (!el) return;
              revealControls();
              if (el.paused) void el.play().catch(() => {});
              else el.pause();
            }}
            onDoubleClick={toggleFullscreen}
            onLoadedMetadata={() => {
              const el = videoRef.current;
              if (!el) return;
              el.playbackRate = playbackRate;
              el.volume = volume;
              if (Number.isFinite(el.duration) && el.duration > 0) {
                setVideoDuration(el.duration);
              }
              const pending = pendingResumeRef.current;
              if (!pending) return;
              pendingResumeRef.current = null;
              if (Number.isFinite(pending.time) && pending.time > 0.5) {
                el.currentTime = pending.time;
              }
              if (pending.shouldPlay) {
                void el.play().catch(() => {});
              }
            }}
            onEnded={() => onEnded?.()}
            onTimeUpdate={() => {
              const el = videoRef.current;
              if (!el) return;
              setCurrentTime(vodSeekBase + (Number.isFinite(el.currentTime) ? el.currentTime : 0));
            }}
            onPlay={() => setIsPaused(false)}
            onPause={() => {
              setIsPaused(true);
              setShowControls(true);
            }}
            onVolumeChange={() => {
              const el = videoRef.current;
              if (el) setIsMuted(el.muted);
            }}
            onError={() =>
              setMediaError('WebView gagal mendekode stream. Coba muat ulang atau tunggu cache lokal selesai.')
            }
            className="h-full w-full bg-black object-contain"
          />
        )}

        {activeSrc && !error && !mediaError && (
          <div
            className={`absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/95 via-black/65 to-transparent px-4 pb-3 pt-10 transition-opacity duration-200 ${
              showControls || isPaused ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            {!isLive && effectiveDuration > 0 && (
              <div className="mb-2 flex items-center gap-3">
                <span className="tabular-nums w-12 text-right font-mono text-xs text-white drop-shadow">
                  {formatDuration(currentTime)}
                </span>
                <input
                  type="range"
                  aria-label="Seekbar video"
                  min={0}
                  max={effectiveDuration}
                  step={1}
                  value={Math.min(currentTime, effectiveDuration)}
                  onChange={(e) => {
                    revealControls();
                    seekTo(Number(e.target.value));
                  }}
                  className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-white/30 accent-[#ff0033] hover:h-2"
                />
                <span className="tabular-nums w-12 font-mono text-xs text-zinc-300 drop-shadow">
                  {formatDuration(effectiveDuration)}
                </span>
              </div>
            )}

            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const el = videoRef.current;
                    if (!el) return;
                    revealControls();
                    if (el.paused) void el.play().catch(() => {});
                    else el.pause();
                  }}
                  className="inline-flex items-center gap-1 rounded-full bg-white/15 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm hover:bg-white/25"
                >
                  {isPaused ? <Play className="h-3.5 w-3.5 fill-current" /> : <Pause className="h-3.5 w-3.5" />}
                  {isPaused ? 'Putar' : 'Jeda'}
                </button>

                {!isLive && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        revealControls();
                        seekTo(currentTime - 10);
                      }}
                      className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1.5 text-xs font-medium text-white backdrop-blur-sm hover:bg-white/25"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      -10d
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        revealControls();
                        seekTo(currentTime + 10);
                      }}
                      className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1.5 text-xs font-medium text-white backdrop-blur-sm hover:bg-white/25"
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                      +10d
                    </button>
                  </>
                )}

                {hasNext && onNext && (
                  <button
                    type="button"
                    aria-label="Video berikutnya"
                    onClick={onNext}
                    title="Video berikutnya"
                    className="rounded-full bg-white/15 p-1.5 text-white backdrop-blur-sm hover:bg-white/25"
                  >
                    <SkipForward className="h-4 w-4" />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                {!isLive && (
                  <button
                    type="button"
                    onClick={() => {
                      revealControls();
                      const idx = PLAYBACK_SPEEDS.indexOf(playbackRate);
                      const nextRate = PLAYBACK_SPEEDS[(idx + 1) % PLAYBACK_SPEEDS.length];
                      setPlaybackRate(nextRate);
                      if (videoRef.current) videoRef.current.playbackRate = nextRate;
                    }}
                    title="Kecepatan putar"
                    className="rounded-full bg-white/15 px-2.5 py-1 font-mono text-xs font-medium text-white backdrop-blur-sm hover:bg-white/25"
                  >
                    {playbackRate}x
                  </button>
                )}

                <div className="flex items-center gap-1.5 rounded-full bg-white/15 px-2 py-1 backdrop-blur-sm">
                  <button
                    type="button"
                    aria-label={isMuted ? 'Bunyikan' : 'Bisukan'}
                    onClick={() => {
                      const el = videoRef.current;
                      if (!el) return;
                      revealControls();
                      el.muted = !el.muted;
                      setIsMuted(el.muted);
                    }}
                    className="text-white hover:text-zinc-200"
                  >
                    {isMuted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                  </button>
                  <input
                    type="range"
                    aria-label="Volume"
                    min={0}
                    max={1}
                    step={0.05}
                    value={isMuted ? 0 : volume}
                    onChange={(e) => {
                      const nextVol = Number(e.target.value);
                      setVolume(nextVol);
                      const el = videoRef.current;
                      if (el) {
                        el.volume = nextVol;
                        el.muted = nextVol === 0;
                        setIsMuted(nextVol === 0);
                      }
                    }}
                    className="h-1 w-14 cursor-pointer appearance-none rounded-full bg-white/30 accent-white"
                  />
                </div>

                {typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && (
                  <button
                    type="button"
                    aria-label="Picture-in-Picture"
                    onClick={() => {
                      const el = videoRef.current;
                      if (!el) return;
                      if (document.pictureInPictureElement) {
                        void document.exitPictureInPicture().catch(() => {});
                      } else {
                        void el.requestPictureInPicture?.().catch(() => {});
                      }
                    }}
                    title="Mini Player (PiP)"
                    className="rounded-full bg-white/15 p-1.5 text-white backdrop-blur-sm hover:bg-white/25"
                  >
                    <PictureInPicture2 className="h-4 w-4" />
                  </button>
                )}

                <button
                  type="button"
                  aria-label={isFullscreen ? 'Keluar layar penuh' : 'Layar penuh'}
                  onClick={toggleFullscreen}
                  className="rounded-full bg-white/15 p-1.5 text-white backdrop-blur-sm hover:bg-white/25"
                >
                  {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h1 className="text-lg font-bold leading-snug text-[#f1f1f1]">
          {video.title}
        </h1>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-600 text-sm font-bold text-white">
              {channelInitial}
            </div>
            <div>
              <p className="text-sm font-semibold text-[#f1f1f1]">{video.channel}</p>
              <p className="text-xs text-[#aaaaaa]">
                {isLive ? 'Siaran Langsung' : 'Aetheris 1080p Stream'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {statusBadge}
            {onToggleLike && (
              <button
                type="button"
                onClick={onToggleLike}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  isLiked
                    ? 'bg-sky-600/30 text-sky-300 border border-sky-500/40'
                    : 'bg-[#272727] text-[#f1f1f1] hover:bg-[#3f3f3f]'
                }`}
              >
                <ThumbsUp className={`h-3.5 w-3.5 ${isLiked ? 'fill-current' : ''}`} />
                {isLiked ? 'Disukai' : 'Suka'}
              </button>
            )}
            {onToggleSave && (
              <button
                type="button"
                onClick={onToggleSave}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  isSaved
                    ? 'bg-amber-600/30 text-amber-300 border border-amber-500/40'
                    : 'bg-[#272727] text-[#f1f1f1] hover:bg-[#3f3f3f]'
                }`}
              >
                <Bookmark className={`h-3.5 w-3.5 ${isSaved ? 'fill-current' : ''}`} />
                {isSaved ? 'Tersimpan' : 'Tonton Nanti'}
              </button>
            )}
            {!isLive && !isUsingLocalCache && !cachedFilePath && onQueueCache && (
              <button
                type="button"
                disabled={jobStatus === 'queued' || jobStatus === 'downloading'}
                onClick={onQueueCache}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#272727] px-3 py-1.5 text-xs font-medium text-[#f1f1f1] transition-colors hover:bg-[#3f3f3f] disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" />
                Simpan 1080p
              </button>
            )}
            {onShare && (
              <button
                type="button"
                onClick={onShare}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#272727] px-3 py-1.5 text-xs font-medium text-[#f1f1f1] transition-colors hover:bg-[#3f3f3f]"
              >
                <Share2 className="h-3.5 w-3.5" />
                Bagikan
              </button>
            )}
            <button
              type="button"
              onClick={onRetry}
              title="Muat ulang stream"
              className="inline-flex items-center gap-1.5 rounded-full bg-[#272727] px-3 py-1.5 text-xs font-medium text-[#f1f1f1] transition-colors hover:bg-[#3f3f3f]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Muat Ulang
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Tutup pemutar"
              className="inline-flex items-center gap-1 rounded-full bg-[#272727] px-3 py-1.5 text-xs font-medium text-[#f1f1f1] transition-colors hover:bg-[#3f3f3f]"
            >
              <X className="h-3.5 w-3.5" />
              Tutup
            </button>
          </div>
        </div>

        <div className="rounded-xl bg-[#272727]/80 px-4 py-2.5 text-xs text-[#f1f1f1]">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            {viewsText && <span className="tabular-nums">{viewsText}</span>}
            {viewsText && video.uploadDate && <span>•</span>}
            {video.uploadDate && <span className="tabular-nums">{video.uploadDate}</span>}
            {video.durationSeconds !== null && video.durationSeconds > 0 && (
              <>
                <span>•</span>
                <span className="tabular-nums">Durasi {formatDuration(video.durationSeconds)}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
