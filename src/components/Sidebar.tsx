import { useState } from 'react';
import {
  Bookmark,
  FolderCheck,
  Gamepad2,
  HardDrive,
  History,
  Home,
  Loader2,
  Mic,
  Music,
  Newspaper,
  Radio,
  ThumbsUp,
  Trash2,
} from 'lucide-react';
import { formatBytes, type CacheSummary } from '../lib/tauri-api';

export type NavTab = 'discover' | 'history' | 'watchLater' | 'liked' | 'cached';

export interface FeedCategory {
  id: string;
  label: string;
  query: string;
}

export const SIDEBAR_CATEGORIES: FeedCategory[] = [
  { id: 'home', label: 'Beranda', query: 'trending music live gaming tech 2026' },
  { id: 'live', label: 'Live Streaming', query: 'live stream 24/7 radio news music' },
  { id: 'music', label: 'Musik', query: 'official music video hits 2026' },
  { id: 'gaming', label: 'Gaming', query: 'gameplay walkthrough 1080p 60fps' },
  { id: 'news', label: 'Berita', query: 'breaking news live stream' },
  { id: 'podcast', label: 'Podcast', query: 'podcast technology interview' },
];

interface SidebarProps {
  activeTab: NavTab;
  activeCategory: string;
  historyCount: number;
  watchLaterCount: number;
  likedCount: number;
  onSelectTab: (tab: NavTab) => void;
  onSelectCategory: (cat: FeedCategory) => void;
  cacheSummary: CacheSummary | null;
  onClearCache: () => Promise<void>;
}

const CATEGORY_ICONS: Record<string, typeof Home> = {
  home: Home,
  live: Radio,
  music: Music,
  gaming: Gamepad2,
  news: Newspaper,
  podcast: Mic,
};

export function Sidebar({
  activeTab,
  activeCategory,
  historyCount,
  watchLaterCount,
  likedCount,
  onSelectTab,
  onSelectCategory,
  cacheSummary,
  onClearCache,
}: SidebarProps) {
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const usedBytes = cacheSummary?.totalBytes ?? 0;
  const maxBytes = cacheSummary?.maxBytes ?? 5 * 1024 * 1024 * 1024;
  const pct = Math.min(100, Math.round((usedBytes / Math.max(1, maxBytes)) * 100));
  const activeJobs = cacheSummary?.activeJobs ?? [];

  const handleClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setClearing(true);
    try {
      await onClearCache();
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col justify-between border-r border-white/[0.08] bg-[#0f0f0f] p-3">
      <div className="space-y-4">
        <div className="flex items-center gap-2.5 px-2 py-1">
          <svg
            viewBox="0 0 32 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="h-7 w-7 shrink-0"
            aria-hidden="true"
          >
            <rect width="32" height="32" rx="8" fill="#181818" stroke="#303030" />
            <path d="M10 8.5L24.5 16L10 23.5V8.5Z" fill="#ff0033" />
            <path d="M10 8.5L18.5 16L10 19.5V8.5Z" fill="#ff4d6d" fillOpacity="0.65" />
          </svg>
          <div className="flex items-baseline gap-1.5">
            <span className="text-base font-bold tracking-wide text-white">Aetheris</span>
            <span className="text-[10px] font-medium uppercase tracking-wider text-[#aaaaaa]">HD</span>
          </div>
        </div>

        <nav aria-label="Navigasi utama" className="space-y-0.5">
          {SIDEBAR_CATEGORIES.map((cat) => {
            const Icon = CATEGORY_ICONS[cat.id] ?? Home;
            const selected = activeTab === 'discover' && activeCategory === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => {
                  onSelectTab('discover');
                  onSelectCategory(cat);
                }}
                className={`flex w-full items-center gap-4 rounded-lg px-3 py-2 text-sm transition-colors ${
                  selected
                    ? 'bg-[#272727] font-medium text-white'
                    : 'text-[#f1f1f1] hover:bg-[#272727]/60'
                }`}
              >
                <Icon
                  className={`h-5 w-5 ${
                    cat.id === 'live' ? 'text-[#ff0000]' : selected ? 'text-white' : 'text-[#aaaaaa]'
                  }`}
                />
                <span>{cat.label}</span>
              </button>
            );
          })}

          <div className="my-2 border-t border-white/[0.08]" />

          <button
            type="button"
            onClick={() => onSelectTab('history')}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
              activeTab === 'history'
                ? 'bg-[#272727] font-medium text-white'
                : 'text-[#f1f1f1] hover:bg-[#272727]/60'
            }`}
          >
            <span className="flex items-center gap-4">
              <History className="h-5 w-5 text-[#aaaaaa]" />
              <span>Riwayat</span>
            </span>
            {historyCount > 0 && (
              <span className="tabular-nums rounded-full bg-[#272727] px-2 py-0.5 font-mono text-[11px] text-[#aaaaaa]">
                {historyCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => onSelectTab('watchLater')}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
              activeTab === 'watchLater'
                ? 'bg-[#272727] font-medium text-white'
                : 'text-[#f1f1f1] hover:bg-[#272727]/60'
            }`}
          >
            <span className="flex items-center gap-4">
              <Bookmark className="h-5 w-5 text-amber-400" />
              <span>Tonton Nanti</span>
            </span>
            {watchLaterCount > 0 && (
              <span className="tabular-nums rounded-full bg-[#272727] px-2 py-0.5 font-mono text-[11px] text-[#aaaaaa]">
                {watchLaterCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => onSelectTab('liked')}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
              activeTab === 'liked'
                ? 'bg-[#272727] font-medium text-white'
                : 'text-[#f1f1f1] hover:bg-[#272727]/60'
            }`}
          >
            <span className="flex items-center gap-4">
              <ThumbsUp className="h-5 w-5 text-sky-400" />
              <span>Disukai</span>
            </span>
            {likedCount > 0 && (
              <span className="tabular-nums rounded-full bg-[#272727] px-2 py-0.5 font-mono text-[11px] text-[#aaaaaa]">
                {likedCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => onSelectTab('cached')}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
              activeTab === 'cached'
                ? 'bg-[#272727] font-medium text-white'
                : 'text-[#f1f1f1] hover:bg-[#272727]/60'
            }`}
          >
            <span className="flex items-center gap-4">
              <FolderCheck className="h-5 w-5 text-emerald-400" />
              <span>Offline 1080p</span>
            </span>
            <span className="tabular-nums rounded-full bg-[#272727] px-2 py-0.5 font-mono text-[11px] text-[#f1f1f1]">
              {cacheSummary?.fileCount ?? 0}
            </span>
          </button>
        </nav>
      </div>

      <div className="space-y-2.5 rounded-xl border border-white/[0.08] bg-[#181818] p-3">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 font-medium text-[#f1f1f1]">
            <HardDrive className="h-3.5 w-3.5 text-[#aaaaaa]" />
            Cache 1080p
          </span>
          <span className="tabular-nums font-mono text-[11px] text-[#aaaaaa]">
            {pct}%
          </span>
        </div>

        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#272727]">
          <div
            className="h-full bg-[#ff0000] transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="tabular-nums flex items-center justify-between font-mono text-[11px] text-[#aaaaaa]">
          <span>{formatBytes(usedBytes)}</span>
          <span>{formatBytes(maxBytes)}</span>
        </div>

        {activeJobs.length > 0 && (
          <div className="space-y-1 border-t border-white/[0.08] pt-2">
            {activeJobs.slice(0, 3).map((job) => (
              <div
                key={job.videoId}
                className="flex items-center justify-between gap-2 text-[11px] text-[#f1f1f1]"
              >
                <span className="truncate">{job.title}</span>
                {job.status === 'failed' ? (
                  <span className="shrink-0 text-red-400">gagal</span>
                ) : (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-amber-400" />
                )}
              </div>
            ))}
          </div>
        )}

        {(cacheSummary?.fileCount ?? 0) > 0 && (
          <div className="flex items-center gap-1.5 pt-1">
            <button
              type="button"
              disabled={clearing}
              onClick={handleClear}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors ${
                confirmClear
                  ? 'border-red-500/60 bg-red-950/60 text-red-200'
                  : 'border-white/10 bg-[#272727] text-[#f1f1f1] hover:bg-[#3f3f3f]'
              }`}
            >
              <Trash2 className="h-3 w-3" />
              {clearing
                ? 'Menghapus...'
                : confirmClear
                  ? 'Konfirmasi Hapus'
                  : 'Bersihkan Cache'}
            </button>
            {confirmClear && (
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="rounded-lg border border-white/10 px-2 py-1 text-[11px] text-[#aaaaaa] hover:text-white"
              >
                Batal
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
