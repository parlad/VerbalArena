import { useEffect, useState, useCallback, useRef } from 'react';
import {
  MessageSquare, Send, Plus, LogOut, User as UserIcon, Settings,
  Sparkles, ThumbsUp, ThumbsDown, ArrowLeft, Search,
  Moon, Sun, Share2, Clock, BarChart2, Swords, Trophy,
  Users, Brain, Zap, Flame, SortAsc, Image, Video, X, Paperclip, FileText, Download
} from 'lucide-react';
import { supabase, type Debate, type ArgumentWithUser, type ArgumentMedia } from './lib/supabase';
import { AuthModal } from './components/AuthModal';
import { CreateDebateModal } from './components/CreateDebateModal';
import { TopicPreferencesModal } from './components/TopicPreferencesModal';
import { TopicSidebar } from './components/TopicSidebar';
import { CreateTopicModal } from './components/CreateTopicModal';
import { TopicDebateView } from './components/TopicDebateView';
import { Toast, type ToastItem } from './components/Toast';

type Topic = {
  topic_id: string;
  title: string;
  description: string;
  category: string;
  source: string;
  external_url?: string;
  vote_count: number;
  creator_user_id?: string;
  created_at: string;
};

type LocalUser = {
  user_id: string;
  username: string;
  email: string;
  reputation_score: number;
  profile_picture_url?: string;
  topic_creation_points?: number;
  role?: 'user' | 'moderator' | 'master';
};

const MAX_ARG_LENGTH = 500;

function App() {
  const [currentUser, setCurrentUser] = useState<LocalUser | null>(null);
  const [debates, setDebates] = useState<Debate[]>([]);
  const [debateArgCounts, setDebateArgCounts] = useState<Record<string, { supporting: number; opposing: number }>>({});
  const [selectedDebate, setSelectedDebate] = useState<Debate | null>(null);
  const [debateArguments, setDebateArguments] = useState<ArgumentWithUser[]>([]);
  const [newArgument, setNewArgument] = useState('');
  const [selectedPosition, setSelectedPosition] = useState<'supporting' | 'opposing'>('supporting');
  const [loading, setLoading] = useState(true);
  const [argsLoading, setArgsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showCreateDebate, setShowCreateDebate] = useState(false);
  const [showTopicPreferences, setShowTopicPreferences] = useState(false);
  const [showCreateTopic, setShowCreateTopic] = useState(false);
  const [userPreferences, setUserPreferences] = useState<string[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<Topic | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [userArgVotes, setUserArgVotes] = useState<Map<string, 'up' | 'down'>>(new Map());
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('va_dark') === 'true');
  const [argSortMode, setArgSortMode] = useState<'new' | 'top'>('new');
  const [viewerCount, setViewerCount] = useState(1);
  const [debateSummary, setDebateSummary] = useState<{
    supportingPoints: string[];
    opposingPoints: string[];
    assessment: string;
    dominantSide: 'supporting' | 'opposing' | 'tied';
  } | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [selectedMediaFiles, setSelectedMediaFiles] = useState<File[]>([]);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Dark mode effect ──────────────────────────────────────────────────────
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('va_dark', String(isDarkMode));
  }, [isDarkMode]);

  // ── Toast helpers ─────────────────────────────────────────────────────────
  const addToast = useCallback((message: string, type: ToastItem['type'] = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts(prev => [...prev, { id, message, type }]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // ── Initial load ──────────────────────────────────────────────────────────
  useEffect(() => {
    const storedUser = localStorage.getItem('verbalarena_user');
    if (storedUser) {
      const user = JSON.parse(storedUser);
      setCurrentUser(user);
      loadUserPreferences(user.user_id);
    }
    loadDebates();
  }, []);

  // ── Real-time subscription for selected debate ────────────────────────────
  useEffect(() => {
    if (!selectedDebate) return;
    const channel = supabase
      .channel(`debate-args-${selectedDebate.debate_id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'arguments',
          filter: `debate_id=eq.${selectedDebate.debate_id}`,
        },
        async (payload) => {
          const newArg = payload.new as ArgumentWithUser;
          setDebateArguments(cur => {
            if (cur.some(a => a.argument_id === newArg.argument_id)) return cur;
            // Fetch user data for arguments from other users
            supabase
              .from('users')
              .select('username, profile_picture_url, reputation_score')
              .eq('user_id', newArg.user_id)
              .single()
              .then(({ data: userData }) => {
                if (userData) {
                  setDebateArguments(prev =>
                    prev.map(a =>
                      a.argument_id === newArg.argument_id
                        ? { ...a, users: userData }
                        : a
                    )
                  );
                }
              });
            return [...cur, { ...newArg, users: newArg.users || { username: 'Loading...', profile_picture_url: null, reputation_score: 0 } }];
          });
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [selectedDebate?.debate_id]);

  // ── Live viewer count (presence) ──────────────────────────────────────────
  useEffect(() => {
    if (!selectedDebate) { setViewerCount(1); return; }
    const presenceKey = currentUser?.user_id || ('anon-' + Math.random().toString(36).slice(2));
    const channel = supabase.channel(`viewers:${selectedDebate.debate_id}`);
    channel
      .on('presence', { event: 'sync' }, () => {
        setViewerCount(Math.max(1, Object.keys(channel.presenceState()).length));
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ user: presenceKey, online_at: Date.now() });
        }
      });
    return () => { supabase.removeChannel(channel); };
  }, [selectedDebate?.debate_id, currentUser?.user_id]);

  // ── Data loaders ──────────────────────────────────────────────────────────
  async function loadDebates() {
    const { data, error } = await supabase
      .from('debates')
      .select('*')
      .eq('status', 'open')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error loading debates:', error);
    } else {
      const list: Debate[] = data || [];
      setDebates(list);
      // Load argument counts for each debate
      if (list.length > 0) {
        loadArgCounts(list.map(d => d.debate_id));
      }
    }
    setLoading(false);
  }

  async function loadArgCounts(debateIds: string[]) {
    const { data } = await supabase
      .from('arguments')
      .select('debate_id, position')
      .in('debate_id', debateIds);

    if (data) {
      const counts: Record<string, { supporting: number; opposing: number }> = {};
      for (const row of data) {
        if (!counts[row.debate_id]) counts[row.debate_id] = { supporting: 0, opposing: 0 };
        if (row.position === 'supporting') counts[row.debate_id].supporting++;
        else counts[row.debate_id].opposing++;
      }
      setDebateArgCounts(counts);
    }
  }

  async function selectDebate(debate: Debate) {
    setSelectedDebate(debate);
    setSelectedTopic(null);
    setDebateArguments([]);
    setArgsLoading(true);
    setDebateSummary(null);
    setArgSortMode('new');
    setSelectedMediaFiles([]);

    const { data, error } = await supabase
      .from('arguments')
      .select(`*, users:user_id (username, profile_picture_url, reputation_score), argument_media(*)`)
      .eq('debate_id', debate.debate_id)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error loading arguments:', error);
      addToast('Failed to load arguments', 'error');
    } else {
      setDebateArguments(data || []);
    }
    setArgsLoading(false);
  }

  async function loadUserPreferences(userId: string) {
    const { data } = await supabase
      .from('user_topic_preferences')
      .select('category')
      .eq('user_id', userId);
    if (data) setUserPreferences(data.map(p => p.category));
  }

  // ── Argument submission ───────────────────────────────────────────────────
  async function handleSubmitArgument(e: React.FormEvent) {
    e.preventDefault();
    if (!newArgument.trim() || !selectedDebate?.debate_id || !currentUser) {
      if (!currentUser) setShowAuthModal(true);
      return;
    }
    if (newArgument.length > MAX_ARG_LENGTH) return;

    setSubmitting(true);
    const { data: insertedArg, error } = await supabase.from('arguments').insert({
      debate_id: selectedDebate.debate_id,
      user_id: currentUser.user_id,
      content: newArgument.trim(),
      position: selectedPosition,
      upvotes: 0,
      downvotes: 0,
      is_edited: false,
    }).select('*').single();

    if (error) {
      setSubmitting(false);
      addToast('Failed to post argument. Please try again.', 'error');
      return;
    }

    // Upload attached media files
    let uploadedMedia: ArgumentMedia[] = [];
    if (insertedArg && selectedMediaFiles.length > 0) {
      uploadedMedia = await uploadArgumentMedia(insertedArg.argument_id);
    }
    setSubmitting(false);

    if (insertedArg) {
      setDebateArguments(prev => {
        if (prev.some(a => a.argument_id === insertedArg.argument_id)) return prev;
        return [...prev, {
          ...insertedArg,
          argument_media: uploadedMedia,
          users: {
            username: currentUser.username,
            profile_picture_url: currentUser.profile_picture_url || null,
            reputation_score: currentUser.reputation_score,
          }
        }];
      });
    }
    setNewArgument('');
    setSelectedMediaFiles([]);
    if (mediaInputRef.current) mediaInputRef.current.value = '';
    addToast('Argument posted!', 'success');
    setDebateArgCounts(prev => {
      const cur = prev[selectedDebate.debate_id] || { supporting: 0, opposing: 0 };
      return {
        ...prev,
        [selectedDebate.debate_id]: {
          ...cur,
          [selectedPosition]: cur[selectedPosition] + 1,
        },
      };
    });
  }

  async function uploadArgumentMedia(argumentId: string): Promise<ArgumentMedia[]> {
    const uploaded: ArgumentMedia[] = [];
    for (const file of selectedMediaFiles) {
      try {
        const ext = file.name.split('.').pop() || 'bin';
        const path = `${currentUser!.user_id}/${argumentId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from('argument-media')
          .upload(path, file, { contentType: file.type });
        if (uploadError) { console.error('Upload error:', uploadError); continue; }
        const { data: urlData } = supabase.storage.from('argument-media').getPublicUrl(path);
        const { data: mediaRecord } = await supabase
          .from('argument_media')
          .insert({
            argument_id: argumentId,
            file_url: urlData.publicUrl,
            file_name: file.name,
            file_type: file.type,
            file_size: file.size,
          })
          .select()
          .single();
        if (mediaRecord) uploaded.push(mediaRecord as ArgumentMedia);
      } catch (err) {
        console.error('Media upload failed:', err);
      }
    }
    return uploaded;
  }

  function handleMediaSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    const remaining = 3 - selectedMediaFiles.length;
    const validated = files.slice(0, remaining).filter(file => {
      if (file.type.startsWith('image/') && file.size > 5 * 1024 * 1024) {
        addToast(`${file.name} exceeds 5 MB image limit`, 'error');
        return false;
      }
      if (file.type.startsWith('video/') && file.size > 50 * 1024 * 1024) {
        addToast(`${file.name} exceeds 50 MB video limit`, 'error');
        return false;
      }
      return true;
    });
    setSelectedMediaFiles(prev => [...prev, ...validated]);
    if (mediaInputRef.current) mediaInputRef.current.value = '';
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    const remaining = 3 - selectedMediaFiles.length;
    const validated = files.slice(0, remaining).filter(file => {
      if (file.size > 10 * 1024 * 1024) {
        addToast(`${file.name} exceeds 10 MB file limit`, 'error');
        return false;
      }
      return true;
    });
    setSelectedMediaFiles(prev => [...prev, ...validated]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeMediaFile(index: number) {
    setSelectedMediaFiles(prev => prev.filter((_, i) => i !== index));
  }

  // ── Vote on argument ──────────────────────────────────────────────────────
  async function handleVoteArgument(argId: string, voteType: 'up' | 'down') {
    if (!currentUser) { setShowAuthModal(true); return; }

    const currentVote = userArgVotes.get(argId);
    const arg = debateArguments.find(a => a.argument_id === argId);
    if (!arg) return;

    const upd = { ...arg };

    if (currentVote === voteType) {
      // Un-vote
      if (voteType === 'up') upd.upvotes = Math.max(0, upd.upvotes - 1);
      else upd.downvotes = Math.max(0, upd.downvotes - 1);

      await supabase.from('arguments')
        .update({ upvotes: upd.upvotes, downvotes: upd.downvotes })
        .eq('argument_id', argId);

      setUserArgVotes(prev => { const m = new Map(prev); m.delete(argId); return m; });
    } else {
      // Switch or new vote
      if (currentVote === 'up') upd.upvotes = Math.max(0, upd.upvotes - 1);
      if (currentVote === 'down') upd.downvotes = Math.max(0, upd.downvotes - 1);
      if (voteType === 'up') upd.upvotes = upd.upvotes + 1;
      else upd.downvotes = upd.downvotes + 1;

      await supabase.from('arguments')
        .update({ upvotes: upd.upvotes, downvotes: upd.downvotes })
        .eq('argument_id', argId);

      setUserArgVotes(prev => new Map(prev).set(argId, voteType));
    }

    setDebateArguments(prev => prev.map(a => a.argument_id === argId ? { ...a, upvotes: upd.upvotes, downvotes: upd.downvotes } : a));
  }

  // ── Share ─────────────────────────────────────────────────────────────────
  function handleShare() {
    navigator.clipboard.writeText(window.location.href).then(() => {
      addToast('Link copied to clipboard!', 'success');
    }).catch(() => {
      addToast('Could not copy link', 'error');
    });
  }

  // ── Auth handlers ─────────────────────────────────────────────────────────
  function handleLogout() {
    localStorage.removeItem('verbalarena_user');
    setCurrentUser(null);
    addToast('Logged out successfully', 'info');
  }

  function handleAuthSuccess() {
    const storedUser = localStorage.getItem('verbalarena_user');
    if (storedUser) {
      const user = JSON.parse(storedUser);
      setCurrentUser(user);
      loadUserPreferences(user.user_id);
      addToast(`Welcome back, ${user.username}!`, 'success');
    }
    setShowAuthModal(false);
  }

  function handleDebateCreated() {
    setShowCreateDebate(false);
    loadDebates();
    addToast('Debate created successfully!', 'success');
  }

  function handlePreferencesUpdated() {
    setShowTopicPreferences(false);
    if (currentUser) loadUserPreferences(currentUser.user_id);
    addToast('Preferences updated!', 'success');
  }

  function handleTopicCreated() {
    setShowCreateTopic(false);
    addToast('Topic created!', 'success');
  }

  // ── AI Debate Summary ───────────────────────────────────────────────
  async function handleGenerateSummary() {
    if (!selectedDebate || debateArguments.length < 2) return;
    setSummaryLoading(true);
    try {
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/summarize-debate`;
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        mode: 'cors',
        body: JSON.stringify({
          debateTitle: selectedDebate.title,
          debateDescription: selectedDebate.description,
          supportingLabel: selectedDebate.supporting_label,
          opposingLabel: selectedDebate.opposing_label,
          supportingArgs: debateArguments.filter(a => a.position === 'supporting').slice(0, 10).map(a => a.content),
          opposingArgs: debateArguments.filter(a => a.position === 'opposing').slice(0, 10).map(a => a.content),
        }),
      });
      if (!response.ok) throw new Error('Summary failed');
      const data = await response.json();
      setDebateSummary(data);
    } catch {
      addToast('Failed to generate summary. Please try again.', 'error');
    } finally {
      setSummaryLoading(false);
    }
  }

  // ── Derived data ──────────────────────────────────────────────────────────
  const filteredDebates = debates.filter(d =>
    !searchQuery ||
    d.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    d.description.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const sortArgs = (args: ArgumentWithUser[]) => {
    if (argSortMode === 'top') {
      return [...args].sort((a, b) => (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes));
    }
    return [...args].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  };
  const supportingArgs = sortArgs(debateArguments.filter(a => a.position === 'supporting'));
  const opposingArgs = sortArgs(debateArguments.filter(a => a.position === 'opposing'));
  const totalArgs = supportingArgs.length + opposingArgs.length;
  const supportingPct = totalArgs > 0 ? Math.round((supportingArgs.length / totalArgs) * 100) : 50;

  // ── Loading state ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center dark:bg-slate-900 transition-colors">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="w-20 h-20 border-4 border-slate-200 dark:border-slate-700 border-t-violet-500 rounded-full animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Swords className="w-7 h-7 text-violet-500" />
            </div>
          </div>
          <p className="text-lg font-bold text-slate-600 dark:text-slate-400">Loading VerbalArena...</p>
        </div>
      </div>
    );
  }

  // ── Argument card ─────────────────────────────────────────────────────────
  function ArgumentCard({ arg }: { arg: ArgumentWithUser }) {
    const isSupporting = arg.position === 'supporting';
    const userVote = userArgVotes.get(arg.argument_id);

    const netScore = arg.upvotes - arg.downvotes;

    return (
      <div className={`group rounded-2xl overflow-hidden transition-all duration-200 hover:-translate-y-0.5 card-shadow hover:card-shadow-hover border ${
        isSupporting
          ? 'bg-emerald-50/60 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-800/60'
          : 'bg-rose-50/60 dark:bg-rose-900/10 border-rose-200 dark:border-rose-800/60'
      }`}>
        {/* Thick coloured top bar */}
        <div className={`h-1 w-full ${isSupporting ? 'bg-gradient-to-r from-emerald-400 to-teal-400' : 'bg-gradient-to-r from-rose-400 to-pink-400'}`} />

        <div className="p-4">
          {/* User info row */}
          <div className="flex items-center gap-2.5 mb-3">
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold text-sm shadow-sm flex-shrink-0 ${
              isSupporting
                ? 'bg-gradient-to-br from-emerald-400 to-teal-500'
                : 'bg-gradient-to-br from-rose-400 to-pink-500'
            }`}>
              {arg.users.username[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-slate-800 dark:text-slate-100 text-sm leading-none mb-0.5">{arg.users.username}</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {arg.users.reputation_score} pts · {new Date(arg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
            {(arg.upvotes + arg.downvotes > 0) && (
              <span className={`text-xs font-bold px-2.5 py-1 rounded-full flex-shrink-0 ${
                netScore > 0 ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                : netScore < 0 ? 'bg-rose-100 dark:bg-rose-900/40 text-rose-600 dark:text-rose-300'
                : 'bg-slate-100 dark:bg-slate-700 text-slate-500'
              }`}>
                {netScore > 0 ? '+' : ''}{netScore}
              </span>
            )}
          </div>

          {/* Content */}
          <p className="text-slate-700 dark:text-slate-200 text-sm leading-relaxed mb-4">{arg.content}</p>

          {/* Media */}
          {arg.argument_media && arg.argument_media.length > 0 && (
            <div className="mb-4 space-y-2">
              {arg.argument_media.filter(m => m.file_type.startsWith('image/') || m.file_type.startsWith('video/')).length > 0 && (
                <div className={`grid gap-2 ${arg.argument_media.filter(m => m.file_type.startsWith('image/') || m.file_type.startsWith('video/')).length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                  {arg.argument_media.filter(m => m.file_type.startsWith('image/') || m.file_type.startsWith('video/')).map(media => (
                    <div key={media.media_id} className="relative rounded-xl overflow-hidden bg-slate-900">
                      {media.file_type.startsWith('video/') ? (
                        <video src={media.file_url} controls className="w-full max-h-48 object-contain" preload="metadata" />
                      ) : (
                        <a href={media.file_url} target="_blank" rel="noopener noreferrer">
                          <img src={media.file_url} alt={media.file_name} className="w-full max-h-48 object-cover hover:opacity-90 transition-opacity cursor-zoom-in" />
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {arg.argument_media.filter(m => !m.file_type.startsWith('image/') && !m.file_type.startsWith('video/')).map(media => (
                <a key={media.media_id} href={media.file_url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-600 bg-white/60 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-700 transition-colors group/file"
                >
                  <div className="w-8 h-8 rounded-lg bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center flex-shrink-0">
                    <FileText className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">{media.file_name}</p>
                    <p className="text-xs text-slate-400">{(media.file_size / 1024).toFixed(0)} KB</p>
                  </div>
                  <Download className="w-4 h-4 text-slate-400 group-hover/file:text-violet-500 transition-colors flex-shrink-0" />
                </a>
              ))}
            </div>
          )}

          {/* Vote row */}
          <div className={`flex items-center gap-2 pt-3 border-t ${isSupporting ? 'border-emerald-200/60 dark:border-emerald-800/40' : 'border-rose-200/60 dark:border-rose-800/40'}`}>
            <button
              onClick={() => handleVoteArgument(arg.argument_id, 'up')}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold transition-all hover:scale-105 active:scale-95 ${
                userVote === 'up'
                  ? 'bg-emerald-500 text-white shadow-md shadow-emerald-200 dark:shadow-emerald-900'
                  : 'bg-white dark:bg-slate-700/60 text-slate-500 dark:text-slate-400 hover:bg-emerald-100 hover:text-emerald-700 dark:hover:bg-emerald-900/30 dark:hover:text-emerald-300 border border-slate-200 dark:border-slate-600'
              }`}
            >
              <ThumbsUp className="w-3.5 h-3.5" />
              <span>{arg.upvotes}</span>
            </button>
            <button
              onClick={() => handleVoteArgument(arg.argument_id, 'down')}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold transition-all hover:scale-105 active:scale-95 ${
                userVote === 'down'
                  ? 'bg-rose-500 text-white shadow-md shadow-rose-200 dark:shadow-rose-900'
                  : 'bg-white dark:bg-slate-700/60 text-slate-500 dark:text-slate-400 hover:bg-rose-100 hover:text-rose-600 dark:hover:bg-rose-900/30 dark:hover:text-rose-300 border border-slate-200 dark:border-slate-600'
              }`}
            >
              <ThumbsDown className="w-3.5 h-3.5" />
              <span>{arg.downvotes}</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Debate card for grid ──────────────────────────────────────────────────
  function DebateCard({ debate }: { debate: Debate }) {
    const counts = debateArgCounts[debate.debate_id] || { supporting: 0, opposing: 0 };
    const total = counts.supporting + counts.opposing;
    const sPct = total > 0 ? Math.round((counts.supporting / total) * 100) : 50;
    const isHot = total >= 5;

    return (
      <div
        onClick={() => selectDebate(debate)}
        className="group relative cursor-pointer rounded-2xl bg-white dark:bg-slate-800/90 card-shadow hover:card-shadow-hover border border-slate-200/60 dark:border-slate-700/50 transition-all duration-300 hover:-translate-y-1.5 overflow-hidden"
      >
        {/* Top split strip — shows supporting vs opposing ratio */}
        <div
          className="debate-strip w-full flex-shrink-0"
          style={{ '--s-pct': `${sPct}%` } as React.CSSProperties}
        />

        {/* Subtle gradient on hover */}
        <div className="absolute inset-0 bg-gradient-to-br from-violet-500/0 via-transparent to-indigo-500/0 group-hover:from-violet-500/4 group-hover:to-indigo-500/4 transition-all pointer-events-none" />

        <div className="relative p-5">
          {/* Badges + date */}
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="flex items-center gap-2 flex-wrap">
              {isHot && (
                <span className="inline-flex items-center gap-1 bg-rose-100 dark:bg-rose-900/40 text-rose-600 dark:text-rose-400 px-2 py-1 rounded-full text-xs font-bold">
                  <Flame className="w-3 h-3" />
                  Hot
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500 flex-shrink-0">
              <Clock className="w-3.5 h-3.5" />
              {new Date(debate.created_at).toLocaleDateString()}
            </div>
          </div>

          {/* Title */}
          <h3 className="font-bold text-slate-900 dark:text-slate-100 text-lg leading-snug mb-1.5 line-clamp-2 group-hover:text-violet-700 dark:group-hover:text-violet-300 transition-colors">
            {debate.title}
          </h3>

          {/* Description */}
          <p className="text-sm text-slate-500 dark:text-slate-400 line-clamp-2 leading-relaxed mb-5">
            {debate.description}
          </p>

          {/* Split score bar */}
          <div className="mb-4">
            <div className="flex justify-between text-xs font-semibold mb-1.5">
              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
                {debate.supporting_label} · {counts.supporting}
              </span>
              <span className="flex items-center gap-1 text-rose-500 dark:text-rose-400">
                {counts.opposing} · {debate.opposing_label}
                <span className="w-2 h-2 rounded-full bg-rose-500 inline-block" />
              </span>
            </div>
            <div className="h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden flex">
              <div className="h-full bg-emerald-500 rounded-l-full transition-all duration-700 bar-animate" style={{ width: `${sPct}%` }} />
              <div className="h-full bg-rose-400 rounded-r-full flex-1 transition-all duration-700" />
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500">
              <MessageSquare className="w-3.5 h-3.5" />
              <span>{total} argument{total !== 1 ? 's' : ''}</span>
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-violet-600 dark:text-violet-400 group-hover:gap-2.5 transition-all">
              Enter debate
              <span className="text-base leading-none group-hover:translate-x-0.5 transition-transform inline-block">→</span>
            </span>
          </div>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen transition-colors duration-300 dark:bg-slate-900">
      {/* Animated background blobs */}
      <div className="fixed inset-0 -z-10 pointer-events-none overflow-hidden">
        <div className="absolute -top-32 -left-32 w-[600px] h-[600px] bg-violet-400/15 dark:bg-violet-900/20 rounded-full blur-3xl animate-float" />
        <div className="absolute top-1/3 right-0 w-[400px] h-[400px] bg-indigo-400/10 dark:bg-indigo-900/15 rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }} />
        <div className="absolute bottom-0 left-1/3 w-[500px] h-[500px] bg-emerald-300/10 dark:bg-emerald-900/15 rounded-full blur-3xl animate-float" style={{ animationDelay: '4s' }} />
        <div className="absolute -bottom-20 right-1/4 w-[350px] h-[350px] bg-rose-300/10 dark:bg-rose-900/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '1s' }} />
      </div>

      <div className="py-6 px-4 max-w-[1600px] mx-auto">
        {/* ── HEADER ─────────────────────────────────────────────────────── */}
        <header className="bg-white/95 dark:bg-slate-800/95 backdrop-blur-xl border border-slate-200/50 dark:border-slate-700/50 smooth-shadow mb-6 px-6 py-4 rounded-2xl animate-slide-down">
          <div className="flex flex-wrap gap-3 justify-between items-center">
            {/* Logo */}
            <button
              onClick={() => { setSelectedDebate(null); setSelectedTopic(null); }}
              className="flex items-center gap-3 hover:opacity-80 transition-opacity"
            >
              <div className="relative">
                <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-xl blur opacity-60" />
                <div className="relative bg-gradient-to-br from-violet-600 to-indigo-600 p-2.5 rounded-xl shadow-lg">
                  <Swords className="w-6 h-6 text-white" />
                </div>
              </div>
              <div>
                <h1 className="text-2xl font-bold text-slate-900 dark:text-white">VerbalArena</h1>
                <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">Where Ideas Collide</p>
              </div>
            </button>

            {/* Right side */}
            <div className="flex items-center gap-2 flex-wrap">
              {/* Dark mode toggle */}
              <button
                onClick={() => setIsDarkMode(!isDarkMode)}
                className="p-2.5 rounded-xl bg-white/80 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-300 transition-all hover:scale-110 smooth-shadow"
                title="Toggle dark mode"
              >
                {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>

              {currentUser ? (
                <>
                  {/* User badge */}
                  <div className={`relative smooth-shadow px-4 py-2 rounded-xl transition-all ${
                    currentUser.role === 'master'
                      ? 'bg-gradient-to-r from-amber-400 via-orange-500 to-amber-500'
                      : 'bg-white/80 dark:bg-slate-700 border border-slate-200 dark:border-slate-600'
                  }`}>
                    <div className="flex items-center gap-2.5">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm ${
                        currentUser.role === 'master'
                          ? 'bg-white/20 text-white'
                          : 'bg-gradient-to-br from-slate-600 to-slate-700 text-white'
                      }`}>
                        {currentUser.username[0].toUpperCase()}
                      </div>
                      <div>
                        <div className={`font-bold text-sm flex items-center gap-1 ${
                          currentUser.role === 'master' ? 'text-white' : 'text-slate-900 dark:text-white'
                        }`}>
                          {currentUser.username}
                          {currentUser.role === 'master' && <Sparkles className="w-3.5 h-3.5" />}
                        </div>
                        <div className={`text-xs font-medium ${
                          currentUser.role === 'master' ? 'text-white/90' : 'text-slate-500 dark:text-slate-400'
                        }`}>
                          {currentUser.reputation_score} pts
                        </div>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => setShowTopicPreferences(true)}
                    className="p-2.5 rounded-xl bg-white/80 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-300 transition-all hover:scale-110 smooth-shadow"
                    title="Topic Preferences"
                  >
                    <Settings className="w-4 h-4" />
                  </button>

                  <button
                    onClick={() => setShowCreateDebate(true)}
                    className="bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white px-4 py-2.5 rounded-xl font-bold smooth-shadow hover:scale-105 transition-all flex items-center gap-2 text-sm"
                  >
                    <Plus className="w-4 h-4" />
                    New Debate
                  </button>

                  <button
                    onClick={handleLogout}
                    className="p-2.5 rounded-xl bg-white/80 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 hover:bg-rose-50 dark:hover:bg-rose-900/30 hover:text-rose-600 text-slate-600 dark:text-slate-300 transition-all hover:scale-110 smooth-shadow"
                    title="Logout"
                  >
                    <LogOut className="w-4 h-4" />
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setShowAuthModal(true)}
                  className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white px-6 py-2.5 rounded-xl font-bold smooth-shadow hover:scale-105 transition-all text-sm"
                >
                  Sign In / Sign Up
                </button>
              )}
            </div>
          </div>
        </header>

        {/* ── MAIN LAYOUT ────────────────────────────────────────────────── */}
        <div className="flex gap-4">
          {/* ── CONTENT AREA ─────────────────────────────────────────────── */}
          <div className="flex-1 min-w-0">

            {/* ── TOPIC VIEW ───────────────────────────────────────────────── */}
            {selectedTopic && (
              <TopicDebateView
                topic={selectedTopic}
                userId={currentUser?.user_id}
                onClose={() => setSelectedTopic(null)}
              />
            )}

            {/* ── DEBATE DETAIL VIEW ───────────────────────────────────────── */}
            {!selectedTopic && selectedDebate && (
              <div className="animate-slide-up">
                {/* Back + share bar */}
                <div className="flex items-center justify-between mb-5">
                  <button
                    onClick={() => { setSelectedDebate(null); setDebateArguments([]); }}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/80 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 font-semibold text-sm transition-all smooth-shadow"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    All Debates
                  </button>
                  <button
                    onClick={handleShare}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/80 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 font-semibold text-sm transition-all smooth-shadow"
                  >
                    <Share2 className="w-4 h-4" />
                    Share
                  </button>
                </div>

                {/* Debate header card */}
                <div className="relative overflow-hidden rounded-3xl mb-6 smooth-shadow-lg">
                  {/* Dark gradient background */}
                  <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #1e1b4b 100%)' }} />
                  <div className="absolute inset-0 overflow-hidden pointer-events-none">
                    <div className="absolute -top-20 -right-20 w-80 h-80 bg-violet-500/20 rounded-full blur-3xl" />
                    <div className="absolute -bottom-20 -left-20 w-80 h-80 bg-indigo-500/20 rounded-full blur-3xl" />
                  </div>
                  {/* Split colour strip at very top */}
                  <div className="relative z-10 flex h-1.5">
                    <div className="bg-emerald-400 transition-all duration-700" style={{ width: `${supportingPct}%` }} />
                    <div className="bg-rose-400 flex-1" />
                  </div>
                  <div className="relative z-10 px-8 py-7">
                    <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="inline-flex items-center gap-2 bg-white/20 backdrop-blur-sm border border-white/20 px-3 py-1.5 rounded-full">
                          <Swords className="w-3.5 h-3.5 text-white" />
                          <span className="text-xs font-bold text-white">Live Debate</span>
                        </span>
                        <span className="inline-flex items-center gap-1.5 bg-white/10 border border-white/15 px-3 py-1.5 rounded-full text-xs font-bold text-white/80">
                          <Users className="w-3.5 h-3.5" />
                          {viewerCount} watching
                        </span>
                      </div>
                      <div className="flex items-center gap-1 text-xs text-white/50">
                        <Clock className="w-3.5 h-3.5" />
                        {new Date(selectedDebate.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    <h2 className="text-3xl font-bold text-white mb-2 leading-tight">
                      {selectedDebate.title}
                    </h2>
                    <p className="text-white/60 leading-relaxed mb-7 text-sm">
                      {selectedDebate.description}
                    </p>

                    {/* Live stats bar */}
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm font-bold">
                        <span className="text-emerald-300 flex items-center gap-1.5">
                          <Trophy className="w-4 h-4" />
                          {selectedDebate.supporting_label}: {supportingArgs.length}
                        </span>
                        <span className="text-white/40 text-xs font-medium flex items-center gap-1">
                          <BarChart2 className="w-3.5 h-3.5" />
                          {totalArgs} total
                        </span>
                        <span className="text-rose-300 flex items-center gap-1.5">
                          {opposingArgs.length}: {selectedDebate.opposing_label}
                          <Trophy className="w-4 h-4" />
                        </span>
                      </div>
                      <div className="h-2.5 bg-white/10 rounded-full overflow-hidden flex">
                        <div className="h-full bg-emerald-400 rounded-l-full transition-all duration-500 bar-animate" style={{ width: `${supportingPct}%` }} />
                        <div className="h-full bg-rose-400 flex-1 rounded-r-full" />
                      </div>
                      <div className="flex justify-between text-xs text-white/40 font-medium">
                        <span>{supportingPct}%</span>
                        <span>{100 - supportingPct}%</span>
                      </div>
                    </div>

                    {totalArgs >= 2 && (
                      <div className="mt-5 pt-5 border-t border-white/10">
                        <button
                          onClick={handleGenerateSummary}
                          disabled={summaryLoading}
                          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/15 hover:bg-white/25 border border-white/20 text-white text-sm font-bold transition-all hover:scale-105 disabled:opacity-60 disabled:cursor-not-allowed disabled:scale-100"
                        >
                          <Brain className="w-4 h-4" />
                          {summaryLoading ? 'Generating AI Summary...' : debateSummary ? 'Regenerate Summary' : 'AI Debate Summary'}
                          {!summaryLoading && <Zap className="w-3.5 h-3.5 text-yellow-300" />}
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* AI Debate Summary Card */}
                {debateSummary && (
                  <div className="bg-gradient-to-br from-violet-50 to-purple-50 dark:from-violet-900/20 dark:to-purple-900/20 border-2 border-violet-200 dark:border-violet-800 rounded-3xl p-6 mb-6 animate-fade-in">
                    <div className="flex items-center gap-2 mb-4 flex-wrap">
                      <Brain className="w-5 h-5 text-violet-600 dark:text-violet-400" />
                      <h3 className="font-bold text-violet-900 dark:text-violet-300 text-lg">AI Debate Summary</h3>
                      <span className={`ml-auto px-3 py-1 rounded-full text-xs font-bold ${
                        debateSummary.dominantSide === 'supporting'
                          ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400'
                          : debateSummary.dominantSide === 'opposing'
                          ? 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-400'
                          : 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300'
                      }`}>
                        {debateSummary.dominantSide === 'tied'
                          ? '⚖️ Evenly matched'
                          : debateSummary.dominantSide === 'supporting'
                          ? `✅ ${selectedDebate.supporting_label} leading`
                          : `⚡ ${selectedDebate.opposing_label} leading`}
                      </span>
                    </div>
                    <div className="grid md:grid-cols-2 gap-4 mb-4">
                      <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-4 border border-emerald-200 dark:border-emerald-800">
                        <h4 className="font-bold text-emerald-700 dark:text-emerald-400 text-sm mb-2">{selectedDebate.supporting_label} Key Points</h4>
                        <ul className="space-y-1.5">
                          {debateSummary.supportingPoints.map((pt, i) => (
                            <li key={i} className="text-xs text-slate-700 dark:text-slate-300 flex gap-2">
                              <span className="text-emerald-500 font-bold mt-0.5">•</span>{pt}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="bg-rose-50 dark:bg-rose-900/20 rounded-xl p-4 border border-rose-200 dark:border-rose-800">
                        <h4 className="font-bold text-rose-700 dark:text-rose-400 text-sm mb-2">{selectedDebate.opposing_label} Key Points</h4>
                        <ul className="space-y-1.5">
                          {debateSummary.opposingPoints.map((pt, i) => (
                            <li key={i} className="text-xs text-slate-700 dark:text-slate-300 flex gap-2">
                              <span className="text-rose-500 font-bold mt-0.5">•</span>{pt}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                    <div className="bg-white/70 dark:bg-slate-800/50 rounded-xl p-4 border border-violet-100 dark:border-violet-800">
                      <p className="text-xs font-bold text-violet-700 dark:text-violet-400 mb-1">AI Assessment</p>
                      <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">{debateSummary.assessment}</p>
                    </div>
                  </div>
                )}

                {/* Sort toggle */}
                <div className="flex items-center justify-between mb-3 px-1">
                  <p className="text-sm font-bold text-slate-600 dark:text-slate-400">Arguments</p>
                  <div className="flex items-center gap-1 bg-white/90 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-1">
                    <button
                      onClick={() => setArgSortMode('new')}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                        argSortMode === 'new'
                          ? 'bg-slate-800 dark:bg-slate-600 text-white'
                          : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                      }`}
                    >
                      <Clock className="w-3 h-3" />
                      New
                    </button>
                    <button
                      onClick={() => setArgSortMode('top')}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                        argSortMode === 'top'
                          ? 'bg-slate-800 dark:bg-slate-600 text-white'
                          : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                      }`}
                    >
                      <SortAsc className="w-3 h-3" />
                      Top
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 mb-6">
                  {/* Supporting column */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-3 px-1 py-2 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800">
                      <Trophy className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 ml-1" />
                      <h3 className="font-bold text-emerald-700 dark:text-emerald-400 text-sm flex-1">
                        {selectedDebate.supporting_label}
                      </h3>
                      <span className="text-xs font-bold bg-emerald-500 text-white px-2 py-0.5 rounded-full mr-1">{supportingArgs.length}</span>
                    </div>
                    {argsLoading ? (
                      <SkeletonArgs />
                    ) : supportingArgs.length === 0 ? (
                      <EmptyArgCol label={selectedDebate.supporting_label} position="supporting" onPost={() => setSelectedPosition('supporting')} />
                    ) : (
                      <div className="space-y-3">
                        {supportingArgs.map(arg => <ArgumentCard key={arg.argument_id} arg={arg} />)}
                      </div>
                    )}
                  </div>

                  {/* Opposing column */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-3 px-1 py-2 rounded-xl bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800">
                      <Trophy className="w-3.5 h-3.5 text-rose-500 dark:text-rose-400 ml-1" />
                      <h3 className="font-bold text-rose-600 dark:text-rose-400 text-sm flex-1">
                        {selectedDebate.opposing_label}
                      </h3>
                      <span className="text-xs font-bold bg-rose-500 text-white px-2 py-0.5 rounded-full mr-1">{opposingArgs.length}</span>
                    </div>
                    {argsLoading ? (
                      <SkeletonArgs />
                    ) : opposingArgs.length === 0 ? (
                      <EmptyArgCol label={selectedDebate.opposing_label} position="opposing" onPost={() => setSelectedPosition('opposing')} />
                    ) : (
                      <div className="space-y-3">
                        {opposingArgs.map(arg => <ArgumentCard key={arg.argument_id} arg={arg} />)}
                      </div>
                    )}
                  </div>
                </div>

                {/* Post argument form */}
                <div className="bg-white/95 dark:bg-slate-800/95 backdrop-blur-xl border border-slate-200/50 dark:border-slate-700/50 smooth-shadow-lg rounded-3xl p-7">
                  <h3 className="text-xl font-bold text-slate-800 dark:text-white mb-6 flex items-center gap-2">
                    <MessageSquare className="w-5 h-5 text-violet-500" />
                    Share Your Perspective
                  </h3>

                  {!currentUser && (
                    <div className="bg-violet-50 dark:bg-violet-900/20 border-2 border-violet-200 dark:border-violet-800 rounded-2xl p-5 mb-5 text-center">
                      <UserIcon className="w-10 h-10 text-violet-500 mx-auto mb-3" />
                      <p className="font-bold text-slate-900 dark:text-white mb-1">Join the Discussion</p>
                      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Sign in to post arguments</p>
                      <button
                        onClick={() => setShowAuthModal(true)}
                        className="bg-gradient-to-r from-blue-500 to-blue-600 text-white px-6 py-2.5 rounded-xl font-bold text-sm hover:scale-105 transition-all smooth-shadow"
                      >
                        Sign In / Sign Up
                      </button>
                    </div>
                  )}

                  <form onSubmit={handleSubmitArgument} className="space-y-5">
                    {/* Position selector */}
                    <div>
                      <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-3">Your Position</label>
                      <div className="grid grid-cols-2 gap-3">
                        {(['supporting', 'opposing'] as const).map(pos => (
                          <button
                            key={pos}
                            type="button"
                            onClick={() => setSelectedPosition(pos)}
                            disabled={!currentUser}
                            className={`relative py-4 px-5 rounded-2xl font-bold text-sm transition-all hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed ${
                              selectedPosition === pos
                                ? pos === 'supporting'
                                  ? 'bg-gradient-to-br from-emerald-500 to-green-600 text-white shadow-lg'
                                  : 'bg-gradient-to-br from-rose-500 to-red-600 text-white shadow-lg'
                                : 'bg-slate-50 dark:bg-slate-700 text-slate-700 dark:text-slate-300 border-2 border-slate-200 dark:border-slate-600'
                            }`}
                          >
                            {pos === 'supporting' ? selectedDebate.supporting_label : selectedDebate.opposing_label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Textarea + char counter */}
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Your Argument</label>
                        <span className={`text-xs font-semibold ${
                          newArgument.length > MAX_ARG_LENGTH * 0.9
                            ? 'text-rose-500'
                            : 'text-slate-400 dark:text-slate-500'
                        }`}>
                          {newArgument.length}/{MAX_ARG_LENGTH}
                        </span>
                      </div>
                      <textarea
                        value={newArgument}
                        onChange={e => setNewArgument(e.target.value)}
                        placeholder="Share your thoughts, arguments, and perspectives..."
                        rows={5}
                        disabled={!currentUser}
                        maxLength={MAX_ARG_LENGTH}
                        className="w-full px-4 py-3 rounded-2xl border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-400 dark:focus:border-blue-500 focus:ring-4 focus:ring-blue-100 dark:focus:ring-blue-900/30 outline-none transition-all resize-none disabled:opacity-60 disabled:cursor-not-allowed font-medium"
                      />
                    </div>

                    {/* Media picker */}
                    {currentUser && (
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <button
                            type="button"
                            onClick={() => mediaInputRef.current?.click()}
                            disabled={selectedMediaFiles.length >= 3}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:border-blue-400 dark:hover:border-blue-500 hover:text-blue-500 dark:hover:text-blue-400 transition-all text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Image className="w-4 h-4" />
                            <Video className="w-4 h-4" />
                            Add photo / video
                            {selectedMediaFiles.length > 0 && (
                              <span className="ml-1 bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded-full text-xs">
                                {selectedMediaFiles.length}/3
                              </span>
                            )}
                          </button>
                          <input
                            ref={mediaInputRef}
                            type="file"
                            accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime"
                            multiple
                            className="hidden"
                            onChange={handleMediaSelect}
                          />
                          <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={selectedMediaFiles.length >= 3}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:border-blue-400 dark:hover:border-blue-500 hover:text-blue-500 dark:hover:text-blue-400 transition-all text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Paperclip className="w-4 h-4" />
                            Add file
                          </button>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept=".pdf,.doc,.docx,.txt,.csv,.xls,.xlsx,.ppt,.pptx,.zip,.md"
                            multiple
                            className="hidden"
                            onChange={handleFileSelect}
                          />
                        </div>
                        {selectedMediaFiles.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {selectedMediaFiles.map((file, idx) => (
                              <div key={idx} className="relative group">
                                {file.type.startsWith('video/') ? (
                                  <div className="w-16 h-16 bg-slate-800 rounded-xl flex flex-col items-center justify-center gap-1">
                                    <Video className="w-6 h-6 text-slate-300" />
                                    <span className="text-[10px] text-slate-400">video</span>
                                  </div>
                                ) : file.type.startsWith('image/') ? (
                                  <img
                                    src={URL.createObjectURL(file)}
                                    alt={file.name}
                                    className="w-16 h-16 rounded-xl object-cover"
                                  />
                                ) : (
                                  <div className="w-16 h-16 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-xl flex flex-col items-center justify-center gap-1 px-1">
                                    <FileText className="w-6 h-6 text-blue-500" />
                                    <span className="text-[9px] text-blue-500 truncate w-full text-center">{file.name.split('.').pop()?.toUpperCase()}</span>
                                  </div>
                                )}
                                <button
                                  type="button"
                                  onClick={() => removeMediaFile(idx)}
                                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                                <p className="text-[10px] text-slate-400 truncate max-w-[64px] mt-0.5 text-center">
                                  {(file.size / 1024).toFixed(0)} KB
                                </p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={!currentUser || submitting || newArgument.length === 0 || newArgument.length > MAX_ARG_LENGTH}
                      className="w-full bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white font-bold py-4 px-6 rounded-2xl transition-all flex items-center justify-center gap-3 smooth-shadow-lg hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed disabled:scale-100 disabled:hover:scale-100"
                    >
                      <Send className="w-5 h-5" />
                      {submitting ? 'Posting...' : 'Post Argument'}
                    </button>
                  </form>
                </div>
              </div>
            )}

            {/* ── DEBATE GRID VIEW ─────────────────────────────────────────── */}
            {!selectedTopic && !selectedDebate && (
              <div className="animate-slide-up">
                {/* ── HERO BANNER ──────────────────────────────────────────── */}
                {!searchQuery && (
                  <div className="relative overflow-hidden rounded-3xl mb-8">
                    <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #4f46e5 55%, #6d28d9 100%)' }} />
                    {/* Decorative glows */}
                    <div className="absolute inset-0 overflow-hidden pointer-events-none">
                      <div className="absolute -top-24 -right-24 w-96 h-96 bg-white/10 rounded-full blur-3xl" />
                      <div className="absolute -bottom-24 -left-24 w-[28rem] h-[28rem] bg-indigo-400/20 rounded-full blur-3xl" />
                      <div className="absolute top-0 left-1/3 w-64 h-64 bg-purple-300/10 rounded-full blur-3xl" />
                    </div>
                    <div className="relative z-10 px-8 py-10 md:px-12 md:py-14 flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
                      {/* Left: copy + stats */}
                      <div className="text-white">
                        <div className="inline-flex items-center gap-2 bg-white/20 backdrop-blur-sm border border-white/20 px-3 py-1.5 rounded-full text-xs font-bold mb-5">
                          <Sparkles className="w-3.5 h-3.5" />
                          AI-Powered Public Debate Platform
                        </div>
                        <h2 className="text-4xl md:text-5xl font-black leading-tight mb-3 text-white">
                          Where Ideas<br />
                          <span className="text-white/90 italic">Collide &amp; Evolve</span>
                        </h2>
                        <p className="text-white/75 text-base leading-relaxed max-w-md mb-8">
                          Pick a side, argue your case with evidence, and let AI reveal who's winning the room.
                        </p>
                        <div className="flex items-center gap-8 flex-wrap">
                          <div>
                            <div className="text-3xl font-black tabular-nums">{debates.length}</div>
                            <div className="text-white/60 text-xs font-semibold uppercase tracking-widest mt-0.5">Live&nbsp;Debates</div>
                          </div>
                          <div className="w-px h-12 bg-white/20" />
                          <div>
                            <div className="text-3xl font-black tabular-nums">
                              {Object.values(debateArgCounts).reduce((sum, c) => sum + c.supporting + c.opposing, 0)}
                            </div>
                            <div className="text-white/60 text-xs font-semibold uppercase tracking-widest mt-0.5">Arguments</div>
                          </div>
                        </div>
                      </div>
                      {/* Right: CTA */}
                      <div className="flex flex-col gap-3 flex-shrink-0 w-full md:w-auto">
                        {currentUser ? (
                          <button
                            onClick={() => setShowCreateDebate(true)}
                            className="bg-white text-violet-700 hover:bg-white/90 px-8 py-4 rounded-2xl font-bold text-sm transition-all shadow-2xl hover:scale-105 flex items-center justify-center gap-2"
                          >
                            <Plus className="w-5 h-5" />
                            Start a Debate
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={() => setShowAuthModal(true)}
                              className="bg-white text-violet-700 hover:bg-white/90 px-8 py-4 rounded-2xl font-bold text-sm transition-all shadow-2xl hover:scale-105 text-center"
                            >
                              Join the Arena
                            </button>
                            <p className="text-white/50 text-xs text-center">Sign in to post arguments</p>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Search + stats bar */}
                <div className="flex flex-wrap gap-3 items-center mb-6">
                  <div className="relative flex-1 min-w-[200px]">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      placeholder="Search debates..."
                      className="w-full pl-11 pr-4 py-3 rounded-2xl border-2 border-slate-200 dark:border-slate-600 bg-white/95 dark:bg-slate-800 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:border-blue-400 dark:focus:border-blue-500 focus:ring-4 focus:ring-blue-100 dark:focus:ring-blue-900/30 outline-none transition-all font-medium smooth-shadow"
                    />
                  </div>
                  <div className="flex items-center gap-2 px-4 py-3 rounded-2xl bg-white/95 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 smooth-shadow">
                    <BarChart2 className="w-4 h-4 text-violet-500" />
                    <span className="text-sm font-bold text-slate-700 dark:text-slate-300">
                      {filteredDebates.length} debate{filteredDebates.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>

                {/* Debate grid */}
                {filteredDebates.length === 0 ? (
                  <div className="bg-white/95 dark:bg-slate-800/95 backdrop-blur-xl border-2 border-slate-200/50 dark:border-slate-700/50 smooth-shadow-lg rounded-3xl p-16 text-center">
                    <div className="w-20 h-20 bg-gradient-to-br from-violet-100 to-indigo-200 dark:from-violet-900/40 dark:to-indigo-800/40 rounded-2xl flex items-center justify-center mx-auto mb-6">
                      <MessageSquare className="w-10 h-10 text-violet-500" />
                    </div>
                    <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-3">
                      {searchQuery ? 'No debates match your search' : 'No debates yet — start the conversation!'}
                    </h3>
                    <p className="text-slate-500 dark:text-slate-400 mb-7 max-w-sm mx-auto">
                      {searchQuery ? 'Try a different search term.' : 'Create the first debate and ignite meaningful discussion.'}
                    </p>
                    {!searchQuery && (
                      currentUser ? (
                        <button
                          onClick={() => setShowCreateDebate(true)}
                          className="bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white px-8 py-4 rounded-2xl font-bold smooth-shadow-lg hover:scale-105 transition-all inline-flex items-center gap-3"
                        >
                          <Plus className="w-5 h-5" />
                          Create First Debate
                        </button>
                      ) : (
                        <button
                          onClick={() => setShowAuthModal(true)}
                          className="bg-gradient-to-r from-blue-500 to-blue-600 text-white px-8 py-4 rounded-2xl font-bold smooth-shadow-lg hover:scale-105 transition-all"
                        >
                          Sign In to Create Debate
                        </button>
                      )
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {filteredDebates.map((debate, i) => (
                      <div key={debate.debate_id} className="animate-fade-in" style={{ animationDelay: `${i * 0.05}s` }}>
                        <DebateCard debate={debate} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── SIDEBAR ───────────────────────────────────────────────────── */}
          <div className={`flex-shrink-0 transition-all duration-300 ${sidebarCollapsed ? 'w-16' : 'w-72'}`}>
            <TopicSidebar
              userId={currentUser?.user_id}
              userPreferences={userPreferences}
              onCreateTopic={() => {
                if (!currentUser) { setShowAuthModal(true); return; }
                setShowCreateTopic(true);
              }}
              onTopicSelect={topic => {
                setSelectedTopic(topic);
                setSelectedDebate(null);
              }}
              selectedTopicId={selectedTopic?.topic_id}
              isCollapsed={sidebarCollapsed}
              onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
            />
          </div>
        </div>
      </div>

      {/* ── MODALS ─────────────────────────────────────────────────────────── */}
      {showAuthModal && (
        <AuthModal onClose={() => setShowAuthModal(false)} onSuccess={handleAuthSuccess} />
      )}
      {showCreateDebate && currentUser && (
        <CreateDebateModal
          userId={currentUser.user_id}
          onClose={() => setShowCreateDebate(false)}
          onSuccess={handleDebateCreated}
        />
      )}
      {showTopicPreferences && currentUser && (
        <TopicPreferencesModal
          userId={currentUser.user_id}
          onClose={() => setShowTopicPreferences(false)}
          onSuccess={handlePreferencesUpdated}
        />
      )}
      {showCreateTopic && currentUser && (
        <CreateTopicModal
          userId={currentUser.user_id}
          onClose={() => setShowCreateTopic(false)}
          onSuccess={handleTopicCreated}
        />
      )}

      {/* ── TOAST NOTIFICATIONS ────────────────────────────────────────────── */}
      <Toast toasts={toasts} onRemove={removeToast} />
    </div>
  );
}

// ── Helper sub-components ───────────────────────────────────────────────────
function SkeletonArgs() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map(i => (
        <div key={i} className="rounded-2xl border-2 border-slate-200 dark:border-slate-700 p-4 animate-pulse">
          <div className="flex gap-2 mb-3">
            <div className="w-9 h-9 bg-slate-200 dark:bg-slate-700 rounded-xl" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-1/3" />
              <div className="h-2.5 bg-slate-100 dark:bg-slate-800 rounded w-1/2" />
            </div>
          </div>
          <div className="space-y-2">
            <div className="h-2.5 bg-slate-100 dark:bg-slate-800 rounded" />
            <div className="h-2.5 bg-slate-100 dark:bg-slate-800 rounded w-4/5" />
            <div className="h-2.5 bg-slate-100 dark:bg-slate-800 rounded w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyArgCol({ label, position, onPost }: { label: string; position: string; onPost: () => void }) {
  const isSupporting = position === 'supporting';
  return (
    <div className={`rounded-2xl border-2 border-dashed p-6 text-center ${
      isSupporting
        ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/30 dark:bg-emerald-900/10'
        : 'border-rose-200 dark:border-rose-800 bg-rose-50/30 dark:bg-rose-900/10'
    }`}>
      <p className={`font-bold text-sm mb-1 ${isSupporting ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
        No {label} arguments yet
      </p>
      <p className="text-xs text-slate-400 dark:text-slate-500 mb-3">Be the first to argue this side!</p>
      <button
        onClick={onPost}
        className={`text-xs font-bold px-3 py-1.5 rounded-lg transition-all hover:scale-105 ${
          isSupporting
            ? 'bg-emerald-500 hover:bg-emerald-600 text-white'
            : 'bg-rose-500 hover:bg-rose-600 text-white'
        }`}
      >
        Post First Argument
      </button>
    </div>
  );
}

export default App;
