import { useState, useEffect, useRef, useMemo } from 'react';
import { ArrowLeft, Send, ArrowUp, Paperclip, FileText, Trash2, Check, AlertTriangle, ChevronDown, Clock, User } from 'lucide-react';
import { supabase } from '../lib/supabase';

type Topic = {
  topic_id: string;
  title: string;
  description: string;
  category: string;
  source: string;
  external_url?: string;
  vote_count: number;
};

type EvidenceFile = {
  evidence_id: string;
  opinion_id: string;
  file_name: string;
  file_url: string;
  file_type: string;
  file_size: number;
  description: string;
  uploaded_at: string;
};

type FactCheckResult = {
  verdict: 'true' | 'false' | 'mixed' | 'unverifiable';
  explanation: string;
  sources?: string[];
};

type Opinion = {
  opinion_id: string;
  topic_id: string;
  user_id: string;
  position: 'supporting' | 'opposing';
  content: string;
  upvotes: number;
  downvotes: number;
  created_at: string;
  fact_check_result?: FactCheckResult;
  fact_checked_at?: string;
  users: {
    username: string;
    reputation_score: number;
  };
  opinion_evidence?: EvidenceFile[];
};

type TopicDebateViewProps = {
  topic: Topic;
  userId?: string;
  onClose: () => void;
};

export function TopicDebateView({ topic, userId, onClose }: TopicDebateViewProps) {
  const [opinions, setOpinions] = useState<Opinion[]>([]);
  const [newOpinion, setNewOpinion] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [userVotes, setUserVotes] = useState<Map<string, 'upvote' | 'downvote'>>(new Map());
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [factCheckingOpinion, setFactCheckingOpinion] = useState<string | null>(null);
  const [expandedFactChecks, setExpandedFactChecks] = useState<Set<string>>(new Set());
  const [expandedAuthors, setExpandedAuthors] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadOpinions();
    loadUserVotes();
    subscribeToOpinions();
  }, [topic.topic_id]);

  async function loadOpinions() {
    const { data, error } = await supabase
      .from('topic_opinions')
      .select(`
        *,
        users:user_id (
          username,
          reputation_score
        ),
        opinion_evidence (
          evidence_id,
          file_name,
          file_url,
          file_type,
          file_size,
          description,
          uploaded_at
        )
      `)
      .eq('topic_id', topic.topic_id)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error loading opinions:', error);
    } else {
      setOpinions(data || []);
    }
    setLoading(false);
  }

  async function loadUserVotes() {
    if (!userId) return;

    const { data } = await supabase
      .from('topic_opinion_votes')
      .select('opinion_id, vote_type')
      .eq('user_id', userId);

    if (data) {
      const votesMap = new Map<string, 'upvote' | 'downvote'>();
      data.forEach(vote => {
        votesMap.set(vote.opinion_id, vote.vote_type as 'upvote' | 'downvote');
      });
      setUserVotes(votesMap);
    }
  }

  function subscribeToOpinions() {
    const channel = supabase
      .channel(`topic_opinions_${topic.topic_id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'topic_opinions', filter: `topic_id=eq.${topic.topic_id}` },
        async (payload) => {
          const { data: userData } = await supabase
            .from('users')
            .select('username, reputation_score')
            .eq('user_id', (payload.new as Opinion).user_id)
            .single();

          if (userData) {
            setOpinions((current) => [
              ...current,
              { ...payload.new as Opinion, users: userData }
            ]);
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'topic_opinions', filter: `topic_id=eq.${topic.topic_id}` },
        async (payload) => {
          const newOpinion = payload.new as Opinion;
          setOpinions((current) =>
            current.map((opinion) =>
              opinion.opinion_id === newOpinion.opinion_id
                ? { ...opinion, ...newOpinion }
                : opinion
            )
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }

  async function handleSubmitOpinion(e: React.FormEvent) {
    e.preventDefault();
    if (!newOpinion.trim() || !userId) return;

    setSubmitting(true);

    try {
      const opinionText = newOpinion.trim();
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/detect-opinion-position`;
      const headers = {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      };

      const aiResponse = await fetch(apiUrl, {
        method: 'POST',
        headers,
        mode: 'cors',
        body: JSON.stringify({
          topicTitle: topic.title,
          topicDescription: topic.description,
          opinionText: opinionText
        })
      });

      if (!aiResponse.ok) {
        throw new Error('AI classification failed');
      }

      const result = await aiResponse.json();
      const detectedPosition = result.position === 'opposing' ? 'opposing' : 'supporting';

      const { data, error } = await supabase
        .from('topic_opinions')
        .insert({
          topic_id: topic.topic_id,
          user_id: userId,
          content: newOpinion.trim(),
          position: detectedPosition,
          upvotes: 0,
          downvotes: 0
        })
        .select(`
          *,
          users:user_id (
            username,
            reputation_score
          )
        `)
        .single();

      if (error) {
        alert(`Failed to post opinion: ${error.message}`);
        setSubmitting(false);
        return;
      }

      if (data && selectedFiles.length > 0) {
        await uploadEvidenceFiles(data.opinion_id);
        const { data: updatedOpinion } = await supabase
          .from('topic_opinions')
          .select(`
            *,
            users:user_id (
              username,
              reputation_score
            ),
            opinion_evidence (
              evidence_id,
              file_name,
              file_url,
              file_type,
              file_size,
              description,
              uploaded_at
            )
          `)
          .eq('opinion_id', data.opinion_id)
          .single();

        if (updatedOpinion) {
          setOpinions((current) => [...current, updatedOpinion]);
        }
      } else if (data) {
        setOpinions((current) => [...current, data]);
      }

      setNewOpinion('');
      setSelectedFiles([]);
      setSubmitting(false);
    } catch (error) {
      console.error('Error submitting opinion:', error);
      alert('Failed to submit opinion. Please try again.');
      setSubmitting(false);
    }
  }

  async function uploadEvidenceFiles(opinionId: string) {
    const uploadPromises = selectedFiles.map(async (file) => {
      const fileUrl = URL.createObjectURL(file);
      await supabase.from('opinion_evidence').insert({
        opinion_id: opinionId,
        file_name: file.name,
        file_url: fileUrl,
        file_type: file.type,
        file_size: file.size,
        description: ''
      });
    });
    await Promise.all(uploadPromises);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    const validFiles = files.filter(file => {
      const maxSize = 10 * 1024 * 1024;
      if (file.size > maxSize) {
        alert(`File ${file.name} is too large. Maximum size is 10MB.`);
        return false;
      }
      return true;
    });
    setSelectedFiles((prev) => [...prev, ...validFiles]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function removeFile(index: number) {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  async function handleVote(opinionId: string, voteType: 'upvote' | 'downvote') {
    if (!userId) return;

    const currentVote = userVotes.get(opinionId);

    if (currentVote === voteType) {
      await supabase
        .from('topic_opinion_votes')
        .delete()
        .eq('user_id', userId)
        .eq('opinion_id', opinionId);

      if (voteType === 'upvote') {
        await supabase.rpc('decrement_opinion_upvotes', { opinion_id_param: opinionId });
      } else {
        await supabase.rpc('decrement_opinion_downvotes', { opinion_id_param: opinionId });
      }

      setUserVotes(prev => {
        const next = new Map(prev);
        next.delete(opinionId);
        return next;
      });

      setOpinions(prev => prev.map(o => {
        if (o.opinion_id === opinionId) {
          return {
            ...o,
            upvotes: voteType === 'upvote' ? o.upvotes - 1 : o.upvotes,
            downvotes: voteType === 'downvote' ? o.downvotes - 1 : o.downvotes
          };
        }
        return o;
      }));
    } else {
      if (currentVote) {
        await supabase
          .from('topic_opinion_votes')
          .update({ vote_type: voteType })
          .eq('user_id', userId)
          .eq('opinion_id', opinionId);

        if (currentVote === 'upvote') {
          await supabase.rpc('decrement_opinion_upvotes', { opinion_id_param: opinionId });
          await supabase.rpc('increment_opinion_downvotes', { opinion_id_param: opinionId });
        } else {
          await supabase.rpc('decrement_opinion_downvotes', { opinion_id_param: opinionId });
          await supabase.rpc('increment_opinion_upvotes', { opinion_id_param: opinionId });
        }

        setOpinions(prev => prev.map(o => {
          if (o.opinion_id === opinionId) {
            return {
              ...o,
              upvotes: voteType === 'upvote' ? o.upvotes + 1 : o.upvotes - 1,
              downvotes: voteType === 'downvote' ? o.downvotes + 1 : o.downvotes - 1
            };
          }
          return o;
        }));
      } else {
        await supabase
          .from('topic_opinion_votes')
          .insert({ user_id: userId, opinion_id: opinionId, vote_type: voteType });

        if (voteType === 'upvote') {
          await supabase.rpc('increment_opinion_upvotes', { opinion_id_param: opinionId });
        } else {
          await supabase.rpc('increment_opinion_downvotes', { opinion_id_param: opinionId });
        }

        setOpinions(prev => prev.map(o => {
          if (o.opinion_id === opinionId) {
            return {
              ...o,
              upvotes: voteType === 'upvote' ? o.upvotes + 1 : o.upvotes,
              downvotes: voteType === 'downvote' ? o.downvotes + 1 : o.downvotes
            };
          }
          return o;
        }));
      }

      setUserVotes(prev => {
        const next = new Map(prev);
        next.set(opinionId, voteType);
        return next;
      });
    }
  }

  async function handleFactCheck(opinionId: string) {
    if (!userId) return;

    setFactCheckingOpinion(opinionId);

    const opinion = opinions.find(o => o.opinion_id === opinionId);
    if (!opinion) {
      setFactCheckingOpinion(null);
      return;
    }

    try {
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fact-check-opinion`;
      const headers = {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      };

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        mode: 'cors',
        body: JSON.stringify({
          opinionText: opinion.content,
          topicTitle: topic.title,
          topicDescription: topic.description
        })
      });

      if (!response.ok) {
        throw new Error('Fact-check failed');
      }

      const factCheckResult = await response.json();

      const { error: updateError } = await supabase
        .from('topic_opinions')
        .update({
          fact_check_result: factCheckResult,
          fact_checked_at: new Date().toISOString()
        })
        .eq('opinion_id', opinionId);

      if (updateError) {
        throw updateError;
      }

      setOpinions(prev => prev.map(o => {
        if (o.opinion_id === opinionId) {
          return {
            ...o,
            fact_check_result: factCheckResult,
            fact_checked_at: new Date().toISOString()
          };
        }
        return o;
      }));

    } catch (error) {
      console.error('Fact-check error:', error);
      alert('Failed to fact-check opinion. Please try again.');
    } finally {
      setFactCheckingOpinion(null);
    }
  }

  function getRelativeTime(dateString: string): string {
    const now = new Date();
    const date = new Date(dateString);
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  const processedOpinions = useMemo(() => {
    const authorOpinions = new Map<string, Opinion[]>();

    opinions.forEach(opinion => {
      const key = `${opinion.user_id}-${opinion.position}`;
      if (!authorOpinions.has(key)) {
        authorOpinions.set(key, []);
      }
      authorOpinions.get(key)!.push(opinion);
    });

    const result: { opinion: Opinion; collapsed: Opinion[]; isCollapsed: boolean }[] = [];
    const processedIds = new Set<string>();

    opinions.forEach(opinion => {
      if (processedIds.has(opinion.opinion_id)) return;

      const key = `${opinion.user_id}-${opinion.position}`;
      const authorOps = authorOpinions.get(key)!;

      if (authorOps.length > 1) {
        const sorted = [...authorOps].sort((a, b) =>
          (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes)
        );
        const best = sorted[0];
        const rest = sorted.slice(1);

        authorOps.forEach(op => processedIds.add(op.opinion_id));

        const isExpanded = expandedAuthors.has(key);

        if (isExpanded) {
          sorted.forEach((op, idx) => {
            result.push({
              opinion: op,
              collapsed: idx === 0 ? rest : [],
              isCollapsed: false
            });
          });
        } else {
          result.push({ opinion: best, collapsed: rest, isCollapsed: true });
        }
      } else {
        processedIds.add(opinion.opinion_id);
        result.push({ opinion, collapsed: [], isCollapsed: false });
      }
    });

    return result.sort((a, b) =>
      new Date(a.opinion.created_at).getTime() - new Date(b.opinion.created_at).getTime()
    );
  }, [opinions, expandedAuthors]);

  const supportCount = opinions.filter(o => o.position === 'supporting').length;
  const opposeCount = opinions.filter(o => o.position === 'opposing').length;

  const toggleAuthorExpand = (userId: string, position: string) => {
    const key = `${userId}-${position}`;
    setExpandedAuthors(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div className="w-full max-w-2xl mx-auto">
      <button
        onClick={onClose}
        className="flex items-center gap-2 text-stone-500 hover:text-stone-900 mb-8 group transition-colors"
      >
        <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
        <span className="text-sm font-medium">Back to topics</span>
      </button>

      <header className="mb-12">
        <h1 className="text-3xl md:text-4xl font-bold text-stone-900 leading-tight mb-4 tracking-tight">
          {topic.title}
        </h1>
        {topic.description && (
          <p className="text-lg text-stone-600 leading-relaxed">
            {topic.description}
          </p>
        )}

        <div className="flex items-center gap-6 mt-8">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-teal-500"></div>
            <span className="text-sm font-medium text-stone-700">
              {supportCount} supporting
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-amber-500"></div>
            <span className="text-sm font-medium text-stone-700">
              {opposeCount} opposing
            </span>
          </div>
        </div>
      </header>

      {loading ? (
        <div className="py-20 text-center">
          <div className="w-8 h-8 border-2 border-stone-200 border-t-stone-600 rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-sm text-stone-500">Loading arguments...</p>
        </div>
      ) : (
        <>
          <div className="space-y-8">
            {processedOpinions.length === 0 ? (
              <div className="py-20 text-center border-t border-stone-200">
                <p className="text-stone-500 mb-2">No arguments yet</p>
                <p className="text-sm text-stone-400">Be the first to share your perspective</p>
              </div>
            ) : (
              processedOpinions.map(({ opinion, collapsed, isCollapsed }) => {
                const isSupporting = opinion.position === 'supporting';
                const score = opinion.upvotes - opinion.downvotes;
                const isLowQuality = score < -2 || (opinion.content.length < 50 && score < 1);
                const hasVoted = userVotes.get(opinion.opinion_id);

                return (
                  <article
                    key={opinion.opinion_id}
                    className={`group ${isLowQuality ? 'opacity-60' : ''}`}
                  >
                    <div className="flex gap-4">
                      <div className="flex flex-col items-center">
                        <div className={`w-1 h-full rounded-full ${
                          isSupporting ? 'bg-teal-200' : 'bg-amber-200'
                        }`}></div>
                      </div>

                      <div className="flex-1 pb-8">
                        <div className="flex items-center gap-3 mb-3">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${
                            isSupporting
                              ? 'bg-teal-100 text-teal-700'
                              : 'bg-amber-100 text-amber-700'
                          }`}>
                            {opinion.users.username[0].toUpperCase()}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-stone-900 text-sm">
                              {opinion.users.username}
                            </span>
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                              isSupporting
                                ? 'bg-teal-50 text-teal-700 border border-teal-200'
                                : 'bg-amber-50 text-amber-700 border border-amber-200'
                            }`}>
                              {isSupporting ? 'supports' : 'opposes'}
                            </span>
                          </div>
                          <span className="text-xs text-stone-400 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {getRelativeTime(opinion.created_at)}
                          </span>
                        </div>

                        <div className="prose prose-stone prose-lg max-w-none">
                          <p className="text-stone-700 leading-relaxed whitespace-pre-wrap">
                            {opinion.content}
                          </p>
                        </div>

                        {opinion.opinion_evidence && opinion.opinion_evidence.length > 0 && (
                          <div className="mt-4 space-y-2">
                            {opinion.opinion_evidence.map((evidence) => (
                              <a
                                key={evidence.evidence_id}
                                href={evidence.file_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-2 text-sm text-stone-600 hover:text-stone-900 bg-stone-50 hover:bg-stone-100 px-3 py-2 rounded-lg transition-colors"
                              >
                                <FileText className="w-4 h-4" />
                                <span>{evidence.file_name}</span>
                                <span className="text-stone-400 text-xs">
                                  {formatFileSize(evidence.file_size)}
                                </span>
                              </a>
                            ))}
                          </div>
                        )}

                        {opinion.fact_check_result && (
                          <div className="mt-4">
                            <button
                              onClick={() => {
                                setExpandedFactChecks(prev => {
                                  const next = new Set(prev);
                                  if (next.has(opinion.opinion_id)) {
                                    next.delete(opinion.opinion_id);
                                  } else {
                                    next.add(opinion.opinion_id);
                                  }
                                  return next;
                                });
                              }}
                              className={`inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg transition-colors ${
                                opinion.fact_check_result.verdict === 'true'
                                  ? 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                                  : opinion.fact_check_result.verdict === 'false'
                                  ? 'text-rose-700 bg-rose-50 hover:bg-rose-100'
                                  : opinion.fact_check_result.verdict === 'mixed'
                                  ? 'text-amber-700 bg-amber-50 hover:bg-amber-100'
                                  : 'text-stone-600 bg-stone-100 hover:bg-stone-200'
                              }`}
                            >
                              {opinion.fact_check_result.verdict === 'true' ? (
                                <Check className="w-3.5 h-3.5" />
                              ) : opinion.fact_check_result.verdict === 'false' ? (
                                <AlertTriangle className="w-3.5 h-3.5" />
                              ) : (
                                <AlertTriangle className="w-3.5 h-3.5" />
                              )}
                              <span className="font-medium capitalize">
                                {opinion.fact_check_result.verdict}
                              </span>
                              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${
                                expandedFactChecks.has(opinion.opinion_id) ? 'rotate-180' : ''
                              }`} />
                            </button>

                            {expandedFactChecks.has(opinion.opinion_id) && (
                              <div className="mt-3 pl-4 border-l-2 border-stone-200">
                                <p className="text-sm text-stone-600 leading-relaxed">
                                  {opinion.fact_check_result.explanation}
                                </p>
                                {opinion.fact_check_result.sources && opinion.fact_check_result.sources.length > 0 && (
                                  <div className="mt-2 text-xs text-stone-500">
                                    <span className="font-medium">Sources: </span>
                                    {opinion.fact_check_result.sources.join(', ')}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        <div className="flex items-center gap-4 mt-4">
                          <button
                            onClick={() => handleVote(opinion.opinion_id, 'upvote')}
                            disabled={!userId}
                            className={`flex items-center gap-1.5 text-sm transition-colors disabled:opacity-50 ${
                              hasVoted === 'upvote'
                                ? 'text-teal-600 font-medium'
                                : 'text-stone-400 hover:text-stone-600'
                            }`}
                          >
                            <ArrowUp className={`w-4 h-4 ${hasVoted === 'upvote' ? 'fill-current' : ''}`} />
                            <span>{opinion.upvotes}</span>
                          </button>

                          {userId && !opinion.fact_check_result && (
                            <button
                              onClick={() => handleFactCheck(opinion.opinion_id)}
                              disabled={factCheckingOpinion === opinion.opinion_id}
                              className="text-sm text-stone-400 hover:text-stone-600 transition-colors disabled:opacity-50"
                            >
                              {factCheckingOpinion === opinion.opinion_id ? 'Checking...' : 'Fact check'}
                            </button>
                          )}
                        </div>

                        {collapsed.length > 0 && isCollapsed && (
                          <button
                            onClick={() => toggleAuthorExpand(opinion.user_id, opinion.position)}
                            className="mt-4 text-sm text-stone-500 hover:text-stone-700 flex items-center gap-2 transition-colors"
                          >
                            <User className="w-3.5 h-3.5" />
                            <span>{collapsed.length} more from {opinion.users.username}</span>
                            <ChevronDown className="w-3.5 h-3.5" />
                          </button>
                        )}

                        {collapsed.length > 0 && !isCollapsed && (
                          <button
                            onClick={() => toggleAuthorExpand(opinion.user_id, opinion.position)}
                            className="mt-4 text-sm text-stone-500 hover:text-stone-700 flex items-center gap-2 transition-colors"
                          >
                            <span>Show less from {opinion.users.username}</span>
                            <ChevronDown className="w-3.5 h-3.5 rotate-180" />
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>

          <div className="mt-16 pt-8 border-t border-stone-200">
            <h2 className="text-lg font-semibold text-stone-900 mb-6">
              Add your perspective
            </h2>

            {!userId ? (
              <div className="bg-stone-50 rounded-xl p-8 text-center">
                <p className="text-stone-600 mb-2">Sign in to join the discussion</p>
                <p className="text-sm text-stone-500">
                  Your position will be detected automatically from your argument
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmitOpinion} className="space-y-4">
                <div>
                  <textarea
                    value={newOpinion}
                    onChange={(e) => setNewOpinion(e.target.value)}
                    placeholder="State your position clearly, then explain why..."
                    rows={6}
                    className="w-full px-4 py-4 rounded-xl border border-stone-200 focus:border-stone-400 focus:ring-0 outline-none transition-colors resize-none text-stone-800 placeholder:text-stone-400 text-base leading-relaxed"
                    required
                  />
                  <p className="text-xs text-stone-400 mt-2">
                    AI will automatically detect whether you're supporting or opposing
                  </p>
                </div>

                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    onChange={handleFileSelect}
                    multiple
                    className="hidden"
                    accept=".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png"
                  />

                  {selectedFiles.length > 0 && (
                    <div className="space-y-2 mb-4">
                      {selectedFiles.map((file, index) => (
                        <div
                          key={index}
                          className="flex items-center gap-3 bg-stone-50 px-3 py-2 rounded-lg"
                        >
                          <FileText className="w-4 h-4 text-stone-500" />
                          <span className="flex-1 text-sm text-stone-700 truncate">
                            {file.name}
                          </span>
                          <span className="text-xs text-stone-400">
                            {formatFileSize(file.size)}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeFile(index)}
                            className="text-stone-400 hover:text-rose-600 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-2 px-4 py-2.5 text-stone-600 hover:text-stone-900 hover:bg-stone-100 rounded-lg transition-colors text-sm font-medium"
                  >
                    <Paperclip className="w-4 h-4" />
                    <span>Attach evidence</span>
                  </button>

                  <button
                    type="submit"
                    disabled={submitting || !newOpinion.trim()}
                    className="flex items-center gap-2 bg-stone-900 hover:bg-stone-800 disabled:bg-stone-300 text-white px-6 py-2.5 rounded-lg transition-colors text-sm font-medium disabled:cursor-not-allowed ml-auto"
                  >
                    <Send className="w-4 h-4" />
                    <span>{submitting ? 'Posting...' : 'Post argument'}</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        </>
      )}
    </div>
  );
}
