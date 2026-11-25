import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Toaster, toast } from 'sonner';
import {
  AlertTriangle,
  HardDrive,
  Link2,
  Loader2,
  Play,
  Radio,
  Search,
  Trash2,
} from 'lucide-react';
import { Player } from './components/Player';
import { Sidebar, SIDEBAR_CATEGORIES, type FeedCategory, type NavTab } from './components/Sidebar';
import { VideoCard, VideoCardSkeleton } from './components/VideoCard';
import {
  cacheVideo,
  checkDependencies,
  clearCache,
  formatBytes,
  formatDuration,
  formatViews,
  getCacheSummary,
  getVideoInfo,
  isTauriRuntime,
  onCacheUpdated,
  removeCachedVideo,
  resolveStream,
  searchVideos,
  type CacheSummary,
  type DependencyStatus,
  type StreamQuality,
  type StreamResolution,
  type VideoMeta,
} from './lib/tauri-api';
import {
  clearHistoryStorage,
  loadAutoplay,
  loadHistory,
  loadLiked,
  loadWatchLater,
  pushHistory,
  saveAutoplay,
  toggleLikedStorage,
  toggleWatchLaterStorage,
} from './lib/storage';

function extractPossibleVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname.includes('youtu.be')) {
      const seg = url.pathname.split('/').filter(Boolean)[0];
      return seg && /^[A-Za-z0-9_-]{11}$/.test(seg) ? seg : null;
    }
    if (url.hostname.includes('youtube.com')) {
      const v = url.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2 && ['shorts', 'embed', 'live'].includes(parts[0])) {
        return /^[A-Za-z0-9_-]{11}$/.test(parts[1]) ? parts[1] : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

const HOME_CHIPS: FeedCategory[] = [
  ...SIDEBAR_CATEGORIES,
  { id: 'lofi', label: 'Lofi & Chill', query: 'lofi hip hop radio live chill' },
  { id: 'tech', label: 'Teknologi', query: 'programming rust linux tech review' },
  { id: 'nature', label: 'Alam 4K', query: '4k nature relaxation video' },
];

const FALLBACK_FEED_QUERIES = [
  'popular music live 2026',
  'lofi chill beats live radio',
  'gaming highlights 1080p 60fps',
  'technology documentary 4k',
];

export function App() {
  const tauriReady = isTauriRuntime();
  const mainRef = useRef<HTMLElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const playRequestIdRef = useRef(0);
  const [activeTab, setActiveTab] = useState<NavTab>('discover');
  const [activeCategory, setActiveCategory] = useState<string>('home');
  const [searchInput, setSearchInput] = useState('');
  const [currentQuery, setCurrentQuery] = useState(SIDEBAR_CATEGORIES[0].query);
  const [videos, setVideos] = useState<VideoMeta[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [feedOffset, setFeedOffset] = useState(0);
  const [fallbackIdx, setFallbackIdx] = useState(0);

  const [deps, setDeps] = useState<DependencyStatus | null>(null);
  const [cacheSummary, setCacheSummary] = useState<CacheSummary | null>(null);

  const [activeVideo, setActiveVideo] = useState<VideoMeta | null>(null);
  const [resolution, setResolution] = useState<StreamResolution | null>(null);
  const [streamQuality, setStreamQuality] = useState<StreamQuality>('auto');
  const [isResolving, setIsResolving] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [history, setHistory] = useState<VideoMeta[]>(() => loadHistory());
  const [watchLater, setWatchLater] = useState<VideoMeta[]>(() => loadWatchLater());
  const [liked, setLiked] = useState<VideoMeta[]>(() => loadLiked());
  const [autoplayNext, setAutoplayNext] = useState<boolean>(() => loadAutoplay());

  const refreshCache = useCallback(async () => {
    if (!tauriReady) return;
    try {
      const summary = await getCacheSummary();
      setCacheSummary(summary);
    } catch (e) {
      console.error('Failed loading cache summary:', e);
    }
  }, [tauriReady]);

  const runSearch = useCallback(
    async (rawQuery: string) => {
      const trimmed = rawQuery.trim();
      if (!trimmed) return;
      if (!tauriReady) {
        toast.error('Desktop backend required: launch with "npm run tauri dev".');
        return;
      }

      const directId = extractPossibleVideoId(trimmed);
      setIsSearching(true);
      setCurrentQuery(trimmed);
      setFeedOffset(0);
      setHasMore(!directId);
      setFallbackIdx(0);
      try {
        if (directId) {
          const meta = await getVideoInfo(directId);
          setVideos([meta]);
        } else {
          const results = await searchVideos(trimmed, 16, 0);
          setVideos(results);
          setFeedOffset(16);
          if (results.length === 0) {
            toast.info('Tidak ada video yang cocok dengan pencarian.');
          }
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Search failed');
      } finally {
        setIsSearching(false);
      }
    },
    [tauriReady],
  );

  const loadMore = useCallback(async () => {
    if (!tauriReady || isSearching || isLoadingMore || !hasMore || activeTab !== 'discover') {
      return;
    }

    setIsLoadingMore(true);
    try {
      let queryToFetch = currentQuery;
      let offsetToFetch = feedOffset;
      let results = await searchVideos(queryToFetch, 16, offsetToFetch);

      // If current query exhausted, seamlessly rotate to related discovery feed
      if (results.length === 0) {
        const nextQuery = FALLBACK_FEED_QUERIES[fallbackIdx % FALLBACK_FEED_QUERIES.length];
        setCurrentQuery(nextQuery);
        setFallbackIdx((i) => i + 1);
        offsetToFetch = 0;
        results = await searchVideos(nextQuery, 16, 0);
      }

      if (results.length === 0) {
        setHasMore(false);
      } else {
        setVideos((prev) => {
          const seen = new Set(prev.map((v) => v.id));
          const unique = results.filter((v) => !seen.has(v.id));
          return [...prev, ...unique];
        });
        setFeedOffset(offsetToFetch + 16);
      }
    } catch (e) {
      console.warn('Load more failed:', e);
    } finally {
      setIsLoadingMore(false);
    }
  }, [tauriReady, isSearching, isLoadingMore, hasMore, activeTab, currentQuery, feedOffset, fallbackIdx]);

  // Infinite scroll observer when user scrolls near bottom
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    const root = mainRef.current;
    if (!sentinel || !root || activeTab !== 'discover' || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadMore();
        }
      },
      { root, rootMargin: '400px' },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [activeTab, hasMore, loadMore]);

  // Initial startup checks + initial feed search + cache-updated listener
  useEffect(() => {
    if (!tauriReady) return;

    void checkDependencies()
      .then((status) => setDeps(status))
      .catch(() => {});
    void refreshCache();
    void runSearch(SIDEBAR_CATEGORIES[0].query);

    let unlisten: (() => void) | null = null;
    void onCacheUpdated((evt) => {
      void refreshCache();
      if (evt.status === 'failed') {
        toast.error(`Background cache failed for ${evt.videoId}`);
      } else if (evt.status === 'completed' && evt.videoId !== 'all') {
        toast.success(`1080p cache ready for ${evt.videoId}`);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [tauriReady, refreshCache, runSearch]);

  const handlePlay = useCallback(
    async (video: VideoMeta, qualityOverride?: StreamQuality) => {
      const requestId = ++playRequestIdRef.current;
      const targetQuality = qualityOverride ?? streamQuality;
      setActiveVideo(video);
      setResolution(null);
      setPlayerError(null);
      setIsResolving(true);
      setHistory(pushHistory(video));
      mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' });

      try {
        // 1. Instant playback resolution (cached 1080p, live 1080p, or selected quality)
        const res = await resolveStream(video.id, Boolean(video.isLive), targetQuality);
        if (playRequestIdRef.current !== requestId) return;
        setResolution(res);

        // 2. Trigger non-blocking background 1080p caching if VOD (<= 20 min) and not already cached
        const canAutoCache =
          video.durationSeconds !== null &&
          video.durationSeconds > 0 &&
          video.durationSeconds <= 20 * 60;
        if (!res.isCached && !video.isLive && canAutoCache) {
          void cacheVideo(video.id, video.title).catch((err) => {
            console.warn('Background cache enqueue failed:', err);
          });
        }
        void refreshCache();
      } catch (e) {
        if (playRequestIdRef.current !== requestId) return;
        const msg = e instanceof Error ? e.message : 'Failed resolving video stream';
        setPlayerError(msg);
        toast.error(msg);
      } finally {
        if (playRequestIdRef.current === requestId) {
          setIsResolving(false);
        }
      }
    },
    [refreshCache, streamQuality],
  );

  const handleQueueCache = useCallback(
    async (video: VideoMeta) => {
      try {
        const ack = await cacheVideo(video.id, video.title);
        if (ack.alreadyCached) {
          toast.info('Video is already in local HD cache.');
        } else {
          toast.success(`Queued 1080p cache: ${video.title}`);
        }
        await refreshCache();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed queuing cache');
      }
    },
    [refreshCache],
  );

  const handleRemoveCached = useCallback(
    async (videoId: string) => {
      try {
        await removeCachedVideo(videoId);
        toast.success('Removed video from cache.');
        await refreshCache();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed removing cached file');
      }
    },
    [refreshCache],
  );

  const handleClearCache = useCallback(async () => {
    try {
      const removed = await clearCache();
      toast.success(`Cleared ${removed} cached video(s).`);
      await refreshCache();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed clearing cache');
    }
  }, [refreshCache]);

  const cachedMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of cacheSummary?.entries ?? []) {
      map.set(entry.videoId, entry.filePath);
    }
    return map;
  }, [cacheSummary]);

  const jobMap = useMemo(() => {
    const map = new Map<string, CacheSummary['activeJobs'][number]['status']>();
    for (const job of cacheSummary?.activeJobs ?? []) {
      map.set(job.videoId, job.status);
    }
    return map;
  }, [cacheSummary]);

  const savedIds = useMemo(() => new Set(watchLater.map((v) => v.id)), [watchLater]);
  const likedIds = useMemo(() => new Set(liked.map((v) => v.id)), [liked]);

  const upNextVideos = useMemo(
    () => (activeVideo ? videos.filter((v) => v.id !== activeVideo.id) : []),
    [videos, activeVideo],
  );

  const handleToggleSave = useCallback((video: VideoMeta) => {
    const { items, saved } = toggleWatchLaterStorage(video);
    setWatchLater(items);
    toast.success(saved ? 'Disimpan ke Tonton Nanti' : 'Dihapus dari Tonton Nanti');
  }, []);

  const handleToggleLike = useCallback((video: VideoMeta) => {
    const { items, liked: isNowLiked } = toggleLikedStorage(video);
    setLiked(items);
    toast.success(isNowLiked ? 'Ditambahkan ke Video Disukai' : 'Batal menyukai video');
  }, []);

  const handleShareVideo = useCallback(async (video: VideoMeta) => {
    const shareUrl = `https://www.youtube.com/watch?v=${video.id}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success('Link video disalin ke clipboard');
    } catch {
      toast.info(shareUrl);
    }
  }, []);

  const handlePlayNext = useCallback(() => {
    if (upNextVideos.length > 0) {
      void handlePlay(upNextVideos[0]);
    }
  }, [upNextVideos, handlePlay]);

  return (
    <div className="flex h-screen overflow-hidden bg-[#0f0f0f] text-[#f1f1f1]">
      <Toaster theme="dark" position="bottom-right" richColors />

      <Sidebar
        activeTab={activeTab}
        activeCategory={activeCategory}
        historyCount={history.length}
        watchLaterCount={watchLater.length}
        likedCount={liked.length}
        onSelectTab={setActiveTab}
        onSelectCategory={(cat) => {
          setActiveCategory(cat.id);
          void runSearch(cat.query);
        }}
        cacheSummary={cacheSummary}
        onClearCache={handleClearCache}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-white/[0.08] bg-[#0f0f0f] px-6 py-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setActiveTab('discover');
              setActiveCategory('');
              void runSearch(searchInput);
            }}
            className="mx-auto flex max-w-2xl items-center gap-2"
          >
            <label htmlFor="yt-search-input" className="sr-only">
              Telusuri YouTube atau tempel URL video
            </label>
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#aaaaaa]" />
              <input
                id="yt-search-input"
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Telusuri video, live streaming, musik, atau tempel URL YouTube..."
                className="w-full rounded-full border border-[#303030] bg-[#121212] py-2 pl-10 pr-4 text-sm text-[#f1f1f1] placeholder:text-[#888888] focus:border-blue-500 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={isSearching}
              className="inline-flex items-center gap-2 rounded-full border border-[#303030] bg-[#222222] px-5 py-2 text-sm font-medium text-[#f1f1f1] transition-colors hover:bg-[#303030] disabled:opacity-50"
            >
              {extractPossibleVideoId(searchInput) ? (
                <>
                  <Link2 className="h-4 w-4" />
                  Buka URL
                </>
              ) : (
                <>
                  <Search className="h-4 w-4" />
                  {isSearching ? 'Mencari...' : 'Cari'}
                </>
              )}
            </button>
          </form>

          {activeTab === 'discover' && (
            <div className="scroller mt-3 flex items-center gap-2 overflow-x-auto pb-1">
              {HOME_CHIPS.map((chip) => {
                const selected = activeCategory === chip.id;
                return (
                  <button
                    key={chip.id}
                    type="button"
                    onClick={() => {
                      setActiveCategory(chip.id);
                      void runSearch(chip.query);
                    }}
                    className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                      selected
                        ? 'bg-[#f1f1f1] text-[#0f0f0f]'
                        : 'bg-[#272727] text-[#f1f1f1] hover:bg-[#3f3f3f]'
                    }`}
                  >
                    {chip.label}
                  </button>
                );
              })}
            </div>
          )}
        </header>

        <main ref={mainRef} className="scroller flex-1 space-y-6 overflow-y-auto p-6">
          {!tauriReady && (
            <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-950/30 p-4 text-sm text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <div>
                <p className="font-medium">Browser Preview Mode</p>
                <p className="text-xs text-amber-200/80">
                  Tauri IPC is inactive in a standalone browser tab. Launch via{' '}
                  <code className="font-mono">npm run tauri dev</code> to enable Rust{' '}
                  <code className="font-mono">yt-dlp</code> stream resolution and LRU disk caching.
                </p>
              </div>
            </div>
          )}

          {deps && !deps.ytdlpAvailable && (
            <div className="flex items-start gap-3 rounded-lg border border-rose-500/30 bg-rose-950/30 p-4 text-sm text-rose-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              <div>
                <p className="font-medium">yt-dlp not found on PATH</p>
                <p className="text-xs text-rose-200/80">
                  Install <code className="font-mono">yt-dlp</code> and{' '}
                  <code className="font-mono">ffmpeg</code> so the Rust backend can resolve streams
                  and merge 1080p MP4 caches.
                </p>
              </div>
            </div>
          )}

          {activeVideo && (
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_380px]">
              <Player
                video={activeVideo}
                resolution={resolution}
                isLoading={isResolving}
                error={playerError}
                jobStatus={jobMap.get(activeVideo.id)}
                cachedFilePath={cachedMap.get(activeVideo.id)}
                isLiked={likedIds.has(activeVideo.id)}
                isSaved={savedIds.has(activeVideo.id)}
                hasNext={upNextVideos.length > 0}
                quality={streamQuality}
                onChangeQuality={(q) => {
                  setStreamQuality(q);
                  void handlePlay(activeVideo, q);
                }}
                onToggleLike={() => handleToggleLike(activeVideo)}
                onToggleSave={() => handleToggleSave(activeVideo)}
                onQueueCache={() => void handleQueueCache(activeVideo)}
                onShare={() => void handleShareVideo(activeVideo)}
                onNext={handlePlayNext}
                onEnded={() => {
                  if (autoplayNext && !activeVideo.isLive) {
                    handlePlayNext();
                  }
                }}
                onRetry={() => void handlePlay(activeVideo)}
                onClose={() => {
                  setActiveVideo(null);
                  setResolution(null);
                  setPlayerError(null);
                }}
              />

              <aside aria-label="Video berikutnya" className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-[#f1f1f1]">Video Berikutnya</h2>
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[#aaaaaa]">
                    <input
                      type="checkbox"
                      checked={autoplayNext}
                      onChange={(e) => {
                        const next = e.target.checked;
                        setAutoplayNext(next);
                        saveAutoplay(next);
                      }}
                      className="h-3.5 w-3.5 accent-[#ff0033]"
                    />
                    Putar Otomatis
                  </label>
                </div>

                <div className="scroller max-h-[600px] space-y-2.5 overflow-y-auto pr-1">
                  {videos
                    .filter((v) => v.id !== activeVideo.id)
                    .map((rec) => {
                      const recLive = Boolean(rec.isLive);
                      const recViews = formatViews(rec.viewCount);
                      return (
                        <button
                          key={rec.id}
                          type="button"
                          onClick={() => void handlePlay(rec)}
                          className="group flex w-full gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-[#272727]"
                        >
                          <div className="relative h-[94px] w-[168px] shrink-0 overflow-hidden rounded-lg bg-[#181818]">
                            <img
                              src={rec.thumbnail}
                              alt={rec.title}
                              loading="lazy"
                              className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-105"
                            />
                            {recLive ? (
                              <span className="absolute bottom-1 right-1 inline-flex items-center gap-1 rounded bg-[#cc0000] px-1 py-0.5 text-[10px] font-semibold text-white">
                                <Radio className="h-2.5 w-2.5" />
                                LIVE
                              </span>
                            ) : (
                              <span className="tabular-nums absolute bottom-1 right-1 rounded bg-black/85 px-1 py-0.5 font-mono text-[10px] font-medium text-white">
                                {formatDuration(rec.durationSeconds)}
                              </span>
                            )}
                          </div>

                          <div className="min-w-0 flex-1 space-y-1">
                            <p className="line-clamp-2 text-[13px] font-medium leading-snug text-[#f1f1f1] group-hover:text-white">
                              {rec.title}
                            </p>
                            <p className="truncate text-xs text-[#aaaaaa]">{rec.channel}</p>
                            <p className="truncate text-[11px] text-[#aaaaaa]">
                              {recLive ? 'Sedang Live' : recViews ?? 'Rekomendasi'}
                            </p>
                          </div>
                        </button>
                      );
                    })}

                  {hasMore && (
                    <button
                      type="button"
                      disabled={isLoadingMore}
                      onClick={() => void loadMore()}
                      className="flex w-full items-center justify-center gap-2 rounded-full border border-[#303030] bg-[#181818] py-2 text-xs font-medium text-[#f1f1f1] hover:bg-[#272727] disabled:opacity-50"
                    >
                      {isLoadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {isLoadingMore ? 'Memuat rekomendasi...' : 'Muat lebih banyak'}
                    </button>
                  )}
                </div>
              </aside>
            </div>
          )}

          {activeTab === 'discover' ? (
            <section aria-label="Video results" className="space-y-5">
              {!activeVideo && (
                <div className="flex items-center justify-between">
                  <h1 className="text-sm font-semibold text-[#f1f1f1]">
                    {isSearching ? 'Memuat video...' : 'Rekomendasi Untuk Anda'}
                  </h1>
                  <span className="tabular-nums font-mono text-xs text-[#aaaaaa]">
                    {videos.length} video
                  </span>
                </div>
              )}

              {isSearching ? (
                <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <VideoCardSkeleton key={i} />
                  ))}
                </div>
              ) : videos.length === 0 ? (
                <div className="surface-card flex flex-col items-center justify-center gap-3 py-16 text-center">
                  <p className="text-sm font-medium text-zinc-300">Belum ada video</p>
                  <p className="text-xs text-zinc-500">
                    Cari topik atau tempel URL YouTube di atas untuk mulai menonton.
                  </p>
                  <button
                    type="button"
                    onClick={() => void runSearch(currentQuery)}
                    className="rounded-full bg-[#272727] px-4 py-1.5 text-xs font-medium text-[#f1f1f1] hover:bg-[#3f3f3f]"
                  >
                    Muat Ulang Beranda
                  </button>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {videos.map((video) => (
                      <VideoCard
                        key={video.id}
                        video={video}
                        isActive={activeVideo?.id === video.id}
                        isCached={cachedMap.has(video.id)}
                        isSaved={savedIds.has(video.id)}
                        isResolving={activeVideo?.id === video.id && isResolving}
                        error={activeVideo?.id === video.id ? playerError : null}
                        jobStatus={jobMap.get(video.id)}
                        onPlay={(v) => void handlePlay(v)}
                        onQueueCache={(v) => void handleQueueCache(v)}
                        onToggleSave={handleToggleSave}
                      />
                    ))}
                  </div>

                  {isLoadingMore && (
                    <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <VideoCardSkeleton key={`more-${i}`} />
                      ))}
                    </div>
                  )}

                  <div ref={loadMoreRef} className="flex justify-center py-4">
                    {hasMore && !isLoadingMore && (
                      <button
                        type="button"
                        onClick={() => void loadMore()}
                        className="rounded-full border border-[#303030] bg-[#181818] px-5 py-2 text-xs font-medium text-[#f1f1f1] transition-colors hover:bg-[#272727]"
                      >
                        Muat Video Lainnya
                      </button>
                    )}
                  </div>
                </>
              )}
            </section>
          ) : activeTab === 'history' || activeTab === 'watchLater' || activeTab === 'liked' ? (
            <section aria-label="Koleksi video" className="space-y-4">
              {(() => {
                const list =
                  activeTab === 'history'
                    ? history
                    : activeTab === 'watchLater'
                      ? watchLater
                      : liked;
                const heading =
                  activeTab === 'history'
                    ? 'Riwayat Tontonan'
                    : activeTab === 'watchLater'
                      ? 'Tonton Nanti'
                      : 'Video yang Disukai';

                return (
                  <>
                    <div className="flex items-center justify-between">
                      <h1 className="text-sm font-semibold text-[#f1f1f1]">{heading}</h1>
                      <div className="flex items-center gap-3">
                        <span className="tabular-nums font-mono text-xs text-[#aaaaaa]">
                          {list.length} video
                        </span>
                        {activeTab === 'history' && history.length > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              clearHistoryStorage();
                              setHistory([]);
                              toast.success('Riwayat tontonan dibersihkan');
                            }}
                            className="inline-flex items-center gap-1.5 rounded-full bg-[#272727] px-3 py-1 text-xs font-medium text-[#f1f1f1] hover:bg-[#3f3f3f]"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Hapus Riwayat
                          </button>
                        )}
                      </div>
                    </div>

                    {list.length === 0 ? (
                      <div className="surface-card flex flex-col items-center justify-center py-16 text-center">
                        <p className="text-sm font-medium text-zinc-300">Belum ada video di {heading}</p>
                        <p className="mt-1 text-xs text-zinc-500">
                          Putar, sukai, atau simpan video untuk melihatnya di sini.
                        </p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {list.map((video) => (
                          <VideoCard
                            key={video.id}
                            video={video}
                            isActive={activeVideo?.id === video.id}
                            isCached={cachedMap.has(video.id)}
                            isSaved={savedIds.has(video.id)}
                            isResolving={activeVideo?.id === video.id && isResolving}
                            error={activeVideo?.id === video.id ? playerError : null}
                            jobStatus={jobMap.get(video.id)}
                            onPlay={(v) => void handlePlay(v)}
                            onQueueCache={(v) => void handleQueueCache(v)}
                            onToggleSave={handleToggleSave}
                          />
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}
            </section>
          ) : (
            <section aria-label="Cached videos library" className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
                    Offline Cached Library
                  </h1>
                  {cacheSummary && (
                    <p className="mt-0.5 font-mono text-xs text-zinc-500">
                      {cacheSummary.cacheDir}
                    </p>
                  )}
                </div>
                <span className="tabular-nums font-mono text-xs text-zinc-400">
                  {formatBytes(cacheSummary?.totalBytes ?? 0)} /{' '}
                  {formatBytes(cacheSummary?.maxBytes ?? 0)}
                </span>
              </div>

              {(cacheSummary?.entries.length ?? 0) === 0 ? (
                <div className="surface-card flex flex-col items-center justify-center py-16 text-center">
                  <HardDrive className="mb-2 h-6 w-6 text-zinc-500" />
                  <p className="text-sm font-medium text-zinc-300">Cache is empty</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Playing any video automatically caches its 1080p MP4 in the background.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-white/[0.06] overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#111419]">
                  {cacheSummary?.entries.map((entry) => (
                    <div
                      key={entry.videoId}
                      className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-[#151921]"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-zinc-100">
                          {entry.title}
                        </p>
                        <p className="tabular-nums font-mono text-xs text-zinc-500">
                          {entry.videoId} · {formatBytes(entry.sizeBytes)}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            void handlePlay({
                              id: entry.videoId,
                              title: entry.title,
                              channel: 'Local Cache',
                              durationSeconds: 0,
                              thumbnail: `https://i.ytimg.com/vi/${entry.videoId}/hqdefault.jpg`,
                              viewCount: null,
                              uploadDate: null,
                              isLive: false,
                            })
                          }
                          className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500"
                        >
                          <Play className="h-3.5 w-3.5 fill-current" />
                          Play Offline
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${entry.title} from cache`}
                          onClick={() => void handleRemoveCached(entry.videoId)}
                          className="rounded-md border border-white/10 p-1.5 text-zinc-400 hover:border-rose-500/40 hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
