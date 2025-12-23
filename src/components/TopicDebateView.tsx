import { useState, useEffect, useRef, useMemo } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, FileText, Trash2, ExternalLink } from 'lucide-react';
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

type GroupedAuthor = {
  userId: string;
  username: string;
  position: 'supporting' | 'opposing';
  primaryOpinion: Opinion;
  additionalOpinions: Opinion[];
};

export function TopicDebateView({ topic, userId, onClose }: TopicDebateViewProps) {
  const [opinions, setOpinions] = useState<Opinion[]>([]);
  const [newArgument, setNewArgument] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [userVotes, setUserVotes] = useState<Map<string, 'agree' | 'disagree'>>(new Map());
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [expandedAuthors, setExpandedAuthors] = useState<Set<string>>(new Set());
  const [expandedFactChecks, setExpandedFactChecks] = useState<Set<string>>(new Set());
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());
  const [detectedPosition, setDetectedPosition] = useState<'supporting' | 'opposing' | null>(null);
  const [detectingPosition, setDetectingPosition] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    loadOpinions();
    loadUserVotes();
    const cleanup = subscribeToOpinions();
    return cleanup;
  }, [topic.topic_id]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (newArgument.trim().length > 20) {
      debounceRef.current = setTimeout(() => detectPosition(newArgument), 800);
    } else {
      setDetectedPosition(null);
    }
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [newArgument]);

  async function detectPosition(text: string) {
    setDetectingPosition(true);
    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/detect-opinion-position`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ topicTitle: topic.title, topicDescription: topic.description, opinionText: text })
      });
      if (response.ok) {
        const result = await response.json();
        setDetectedPosition(result.position === 'opposing' ? 'opposing' : 'supporting');
      }
    } catch (e) {
      console.error('Position detection failed:', e);
    }
    setDetectingPosition(false);
  }

  async function loadOpinions() {
    const { data, error } = await supabase
      .from('topic_opinions')
      .select(`*, users:user_id (username, reputation_score), opinion_evidence (*)`)
      .eq('topic_id', topic.topic_id)
      .order('created_at', { ascending: true });
    if (!error) setOpinions(data || []);
    setLoading(false);
  }

  async function loadUserVotes() {
    if (!userId) return;
    const { data } = await supabase.from('topic_opinion_votes').select('opinion_id, vote_type').eq('user_id', userId);
    if (data) {
      const votesMap = new Map<string, 'agree' | 'disagree'>();
      data.forEach(v => votesMap.set(v.opinion_id, v.vote_type === 'upvote' ? 'agree' : 'disagree'));
      setUserVotes(votesMap);
    }
  }

  function subscribeToOpinions() {
    const channel = supabase
      .channel(`opinions_${topic.topic_id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'topic_opinions', filter: `topic_id=eq.${topic.topic_id}` },
        () => loadOpinions()
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }

  async function handleSubmit() {
    if (!newArgument.trim() || !userId || !detectedPosition) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.from('topic_opinions')
        .insert({ topic_id: topic.topic_id, user_id: userId, content: newArgument.trim(), position: detectedPosition, upvotes: 0, downvotes: 0 })
        .select(`*, users:user_id (username, reputation_score)`)
        .single();
      if (error) throw error;
      if (data && selectedFiles.length > 0) {
        await Promise.all(selectedFiles.map(file =>
          supabase.from('opinion_evidence').insert({ opinion_id: data.opinion_id, file_name: file.name, file_url: URL.createObjectURL(file), file_type: file.type, file_size: file.size, description: '' })
        ));
      }
      setNewArgument('');
      setSelectedFiles([]);
      setDetectedPosition(null);
      await loadOpinions();
    } catch (e) {
      console.error('Submit failed:', e);
    }
    setSubmitting(false);
  }

  async function handleVote(opinionId: string, voteType: 'agree' | 'disagree') {
    if (!userId) return;
    const dbVoteType = voteType === 'agree' ? 'upvote' : 'downvote';
    const current = userVotes.get(opinionId);

    if (current === voteType) {
      await supabase.from('topic_opinion_votes').delete().eq('user_id', userId).eq('opinion_id', opinionId);
      await supabase.rpc(voteType === 'agree' ? 'decrement_opinion_upvotes' : 'decrement_opinion_downvotes', { opinion_id_param: opinionId });
      setUserVotes(prev => { const n = new Map(prev); n.delete(opinionId); return n; });
      setOpinions(prev => prev.map(o => o.opinion_id === opinionId ? { ...o, upvotes: voteType === 'agree' ? o.upvotes - 1 : o.upvotes, downvotes: voteType === 'disagree' ? o.downvotes - 1 : o.downvotes } : o));
    } else {
      if (current) {
        await supabase.from('topic_opinion_votes').update({ vote_type: dbVoteType }).eq('user_id', userId).eq('opinion_id', opinionId);
        const oldType = current === 'agree' ? 'upvote' : 'downvote';
        await supabase.rpc(oldType === 'upvote' ? 'decrement_opinion_upvotes' : 'decrement_opinion_downvotes', { opinion_id_param: opinionId });
        await supabase.rpc(dbVoteType === 'upvote' ? 'increment_opinion_upvotes' : 'increment_opinion_downvotes', { opinion_id_param: opinionId });
      } else {
        await supabase.from('topic_opinion_votes').insert({ user_id: userId, opinion_id: opinionId, vote_type: dbVoteType });
        await supabase.rpc(dbVoteType === 'upvote' ? 'increment_opinion_upvotes' : 'increment_opinion_downvotes', { opinion_id_param: opinionId });
      }
      setUserVotes(prev => { const n = new Map(prev); n.set(opinionId, voteType); return n; });
      setOpinions(prev => prev.map(o => {
        if (o.opinion_id !== opinionId) return o;
        let upvotes = o.upvotes, downvotes = o.downvotes;
        if (current === 'agree') upvotes--;
        if (current === 'disagree') downvotes--;
        if (voteType === 'agree') upvotes++;
        if (voteType === 'disagree') downvotes++;
        return { ...o, upvotes, downvotes };
      }));
    }
  }

  async function requestFactCheck(opinionId: string) {
    const opinion = opinions.find(o => o.opinion_id === opinionId);
    if (!opinion) return;
    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fact-check-opinion`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ opinionText: opinion.content, topicTitle: topic.title, topicDescription: topic.description })
      });
      if (!response.ok) throw new Error('Failed');
      const result = await response.json();
      await supabase.from('topic_opinions').update({ fact_check_result: result, fact_checked_at: new Date().toISOString() }).eq('opinion_id', opinionId);
      setOpinions(prev => prev.map(o => o.opinion_id === opinionId ? { ...o, fact_check_result: result, fact_checked_at: new Date().toISOString() } : o));
      setExpandedFactChecks(prev => new Set(prev).add(opinionId));
    } catch (e) {
      console.error('Fact check failed:', e);
    }
  }

  const groupedArguments = useMemo((): GroupedAuthor[] => {
    const byAuthorPosition = new Map<string, Opinion[]>();
    opinions.forEach(op => {
      const key = `${op.user_id}-${op.position}`;
      if (!byAuthorPosition.has(key)) byAuthorPosition.set(key, []);
      byAuthorPosition.get(key)!.push(op);
    });

    const groups: GroupedAuthor[] = [];
    byAuthorPosition.forEach((ops, key) => {
      const sorted = [...ops].sort((a, b) => (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes));
      groups.push({
        userId: sorted[0].user_id,
        username: sorted[0].users.username,
        position: sorted[0].position,
        primaryOpinion: sorted[0],
        additionalOpinions: sorted.slice(1)
      });
    });

    return groups.sort((a, b) => new Date(a.primaryOpinion.created_at).getTime() - new Date(b.primaryOpinion.created_at).getTime());
  }, [opinions]);

  const stats = useMemo(() => {
    const supporting = opinions.filter(o => o.position === 'supporting');
    const opposing = opinions.filter(o => o.position === 'opposing');
    return {
      supportCount: supporting.length,
      opposeCount: opposing.length,
      supportVotes: supporting.reduce((sum, o) => sum + o.upvotes, 0),
      opposeVotes: opposing.reduce((sum, o) => sum + o.upvotes, 0)
    };
  }, [opinions]);

  const totalArguments = stats.supportCount + stats.opposeCount;
  const supportPercent = totalArguments > 0 ? Math.round((stats.supportCount / totalArguments) * 100) : 50;

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function getFactCheckLabel(result?: FactCheckResult): { label: string; color: string; bg: string } {
    if (!result) return { label: 'Unchecked', color: '#6b7280', bg: '#f3f4f6' };
    switch (result.verdict) {
      case 'true': return { label: 'Verified', color: '#047857', bg: '#d1fae5' };
      case 'false': return { label: 'Disputed', color: '#b91c1c', bg: '#fee2e2' };
      case 'mixed': return { label: 'Mixed', color: '#b45309', bg: '#fef3c7' };
      default: return { label: 'Unverifiable', color: '#6b7280', bg: '#f3f4f6' };
    }
  }

  function renderArgumentCard(opinion: Opinion, isNested = false) {
    const isSupporting = opinion.position === 'supporting';
    const factCheck = getFactCheckLabel(opinion.fact_check_result);
    const currentVote = userVotes.get(opinion.opinion_id);
    const hasEvidence = opinion.opinion_evidence && opinion.opinion_evidence.length > 0;
    const isSourcesExpanded = expandedSources.has(opinion.opinion_id);
    const isFactCheckExpanded = expandedFactChecks.has(opinion.opinion_id);

    return (
      <article
        key={opinion.opinion_id}
        style={{
          padding: isNested ? '20px 0 20px 24px' : '32px 0',
          borderLeft: isNested ? '2px solid #e5e7eb' : 'none',
          marginLeft: isNested ? '20px' : '0'
        }}
      >
        <div style={{
          borderLeft: `3px solid ${isSupporting ? '#10b981' : '#f97316'}`,
          paddingLeft: '24px'
        }}>
          <p style={{
            fontSize: '18px',
            lineHeight: 1.75,
            color: '#1f2937',
            margin: '0 0 20px 0',
            fontFamily: 'Georgia, serif'
          }}>
            {opinion.content}
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '16px', marginBottom: '16px' }}>
            <span style={{
              fontSize: '13px',
              fontWeight: 600,
              color: isSupporting ? '#047857' : '#c2410c',
              textTransform: 'uppercase',
              letterSpacing: '0.5px'
            }}>
              {isSupporting ? 'Supports' : 'Opposes'}
            </span>
            <span style={{ fontSize: '14px', color: '#6b7280' }}>
              {opinion.users.username}
            </span>
            <button
              onClick={() => {
                if (!opinion.fact_check_result && userId) {
                  requestFactCheck(opinion.opinion_id);
                } else if (opinion.fact_check_result) {
                  setExpandedFactChecks(prev => {
                    const n = new Set(prev);
                    n.has(opinion.opinion_id) ? n.delete(opinion.opinion_id) : n.add(opinion.opinion_id);
                    return n;
                  });
                }
              }}
              style={{
                fontSize: '12px',
                fontWeight: 600,
                padding: '4px 10px',
                borderRadius: '4px',
                border: 'none',
                cursor: opinion.fact_check_result || userId ? 'pointer' : 'default',
                backgroundColor: factCheck.bg,
                color: factCheck.color
              }}
            >
              {factCheck.label}
            </button>
          </div>

          {isFactCheckExpanded && opinion.fact_check_result && (
            <div style={{
              backgroundColor: '#f9fafb',
              padding: '16px',
              borderRadius: '8px',
              marginBottom: '16px',
              fontSize: '14px',
              color: '#374151',
              lineHeight: 1.6
            }}>
              {opinion.fact_check_result.explanation}
              {opinion.fact_check_result.sources && opinion.fact_check_result.sources.length > 0 && (
                <p style={{ marginTop: '12px', fontSize: '13px', color: '#6b7280' }}>
                  Sources: {opinion.fact_check_result.sources.join(', ')}
                </p>
              )}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button
              onClick={() => userId && handleVote(opinion.opinion_id, 'agree')}
              disabled={!userId}
              style={{
                fontSize: '13px',
                padding: '6px 12px',
                borderRadius: '4px',
                border: '1px solid #e5e7eb',
                cursor: userId ? 'pointer' : 'default',
                backgroundColor: currentVote === 'agree' ? '#d1fae5' : '#fff',
                color: currentVote === 'agree' ? '#047857' : '#6b7280',
                opacity: userId ? 1 : 0.5
              }}
            >
              Agree {opinion.upvotes > 0 && `(${opinion.upvotes})`}
            </button>
            <button
              onClick={() => userId && handleVote(opinion.opinion_id, 'disagree')}
              disabled={!userId}
              style={{
                fontSize: '13px',
                padding: '6px 12px',
                borderRadius: '4px',
                border: '1px solid #e5e7eb',
                cursor: userId ? 'pointer' : 'default',
                backgroundColor: currentVote === 'disagree' ? '#fee2e2' : '#fff',
                color: currentVote === 'disagree' ? '#b91c1c' : '#6b7280',
                opacity: userId ? 1 : 0.5
              }}
            >
              Disagree {opinion.downvotes > 0 && `(${opinion.downvotes})`}
            </button>
            {hasEvidence && (
              <button
                onClick={() => setExpandedSources(prev => {
                  const n = new Set(prev);
                  n.has(opinion.opinion_id) ? n.delete(opinion.opinion_id) : n.add(opinion.opinion_id);
                  return n;
                })}
                style={{
                  fontSize: '13px',
                  padding: '6px 12px',
                  borderRadius: '4px',
                  border: '1px solid #e5e7eb',
                  cursor: 'pointer',
                  backgroundColor: isSourcesExpanded ? '#f3f4f6' : '#fff',
                  color: '#6b7280',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                <ExternalLink style={{ width: '14px', height: '14px' }} />
                Sources ({opinion.opinion_evidence!.length})
              </button>
            )}
          </div>

          {isSourcesExpanded && hasEvidence && (
            <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {opinion.opinion_evidence!.map(ev => (
                <a
                  key={ev.evidence_id}
                  href={ev.file_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontSize: '13px',
                    color: '#2563eb',
                    textDecoration: 'none'
                  }}
                >
                  <FileText style={{ width: '14px', height: '14px' }} />
                  {ev.file_name}
                </a>
              ))}
            </div>
          )}
        </div>
      </article>
    );
  }

  return (
    <div style={{ backgroundColor: '#fafafa', minHeight: '100vh' }}>
      <div style={{ maxWidth: '680px', margin: '0 auto', padding: '48px 24px' }}>
        <button
          onClick={onClose}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            color: '#6b7280',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: '14px',
            marginBottom: '48px',
            padding: 0
          }}
        >
          <ArrowLeft style={{ width: '16px', height: '16px' }} />
          Back
        </button>

        <header style={{ marginBottom: '48px' }}>
          <h1 style={{
            fontSize: '42px',
            fontWeight: 700,
            color: '#111827',
            lineHeight: 1.15,
            margin: '0 0 16px 0',
            fontFamily: 'Georgia, serif',
            letterSpacing: '-0.5px'
          }}>
            {topic.title}
          </h1>
          {topic.description && (
            <p style={{
              fontSize: '18px',
              color: '#4b5563',
              lineHeight: 1.6,
              margin: '0 0 32px 0'
            }}>
              {topic.description}
            </p>
          )}

          <div style={{
            backgroundColor: '#fff',
            borderRadius: '8px',
            padding: '20px 24px',
            border: '1px solid #e5e7eb'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#047857' }}>
                {stats.supportCount} supporting
              </span>
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#c2410c' }}>
                {stats.opposeCount} opposing
              </span>
            </div>
            <div style={{
              height: '6px',
              backgroundColor: '#f97316',
              borderRadius: '3px',
              overflow: 'hidden'
            }}>
              <div style={{
                height: '100%',
                width: `${supportPercent}%`,
                backgroundColor: '#10b981',
                transition: 'width 0.3s ease'
              }} />
            </div>
          </div>
        </header>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: '#6b7280' }}>
            Loading arguments...
          </div>
        ) : (
          <>
            <section>
              {groupedArguments.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '64px 0' }}>
                  <p style={{ fontSize: '18px', color: '#6b7280', marginBottom: '8px' }}>No arguments yet</p>
                  <p style={{ fontSize: '15px', color: '#9ca3af' }}>Be the first to share your perspective</p>
                </div>
              ) : (
                groupedArguments.map(group => {
                  const isExpanded = expandedAuthors.has(`${group.userId}-${group.position}`);
                  return (
                    <div
                      key={`${group.userId}-${group.position}`}
                      style={{ borderBottom: '1px solid #e5e7eb' }}
                    >
                      {renderArgumentCard(group.primaryOpinion)}

                      {group.additionalOpinions.length > 0 && (
                        <>
                          {!isExpanded ? (
                            <button
                              onClick={() => setExpandedAuthors(prev => new Set(prev).add(`${group.userId}-${group.position}`))}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                fontSize: '13px',
                                color: '#6b7280',
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: '0 0 24px 27px',
                                marginTop: '-16px'
                              }}
                            >
                              <ChevronRight style={{ width: '14px', height: '14px' }} />
                              {group.additionalOpinions.length} more from {group.username}
                            </button>
                          ) : (
                            <>
                              {group.additionalOpinions.map(op => renderArgumentCard(op, true))}
                              <button
                                onClick={() => setExpandedAuthors(prev => {
                                  const n = new Set(prev);
                                  n.delete(`${group.userId}-${group.position}`);
                                  return n;
                                })}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '6px',
                                  fontSize: '13px',
                                  color: '#6b7280',
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                  padding: '0 0 24px 27px'
                                }}
                              >
                                <ChevronDown style={{ width: '14px', height: '14px', transform: 'rotate(180deg)' }} />
                                Show less
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </section>

            <section style={{
              marginTop: '64px',
              backgroundColor: '#fff',
              borderRadius: '12px',
              padding: '32px',
              border: '1px solid #e5e7eb'
            }}>
              <h2 style={{
                fontSize: '20px',
                fontWeight: 600,
                color: '#111827',
                margin: '0 0 8px 0'
              }}>
                Add your argument
              </h2>
              <p style={{
                fontSize: '14px',
                color: '#6b7280',
                margin: '0 0 24px 0'
              }}>
                Make one clear argument. Explain your reasoning.
              </p>

              {!userId ? (
                <div style={{
                  backgroundColor: '#f9fafb',
                  borderRadius: '8px',
                  padding: '24px',
                  textAlign: 'center'
                }}>
                  <p style={{ fontSize: '15px', color: '#374151' }}>Sign in to contribute to this debate</p>
                </div>
              ) : (
                <>
                  <textarea
                    value={newArgument}
                    onChange={(e) => setNewArgument(e.target.value)}
                    placeholder="State your position and explain why you believe it..."
                    rows={5}
                    style={{
                      width: '100%',
                      padding: '16px',
                      borderRadius: '8px',
                      border: '1px solid #d1d5db',
                      fontSize: '16px',
                      color: '#1f2937',
                      lineHeight: 1.6,
                      resize: 'vertical',
                      outline: 'none',
                      boxSizing: 'border-box',
                      fontFamily: 'inherit'
                    }}
                  />

                  {(detectedPosition || detectingPosition) && (
                    <div style={{
                      marginTop: '16px',
                      padding: '12px 16px',
                      backgroundColor: detectedPosition === 'supporting' ? '#d1fae5' : detectedPosition === 'opposing' ? '#ffedd5' : '#f3f4f6',
                      borderRadius: '8px',
                      fontSize: '14px',
                      color: detectedPosition === 'supporting' ? '#047857' : detectedPosition === 'opposing' ? '#c2410c' : '#6b7280'
                    }}>
                      {detectingPosition ? 'Detecting position...' : (
                        <>
                          Your argument will be classified as <strong>{detectedPosition === 'supporting' ? 'SUPPORTING' : 'OPPOSING'}</strong> this topic.
                        </>
                      )}
                    </div>
                  )}

                  {detectedPosition && newArgument.trim().length > 20 && (
                    <div style={{
                      marginTop: '16px',
                      padding: '20px',
                      backgroundColor: '#f9fafb',
                      borderRadius: '8px',
                      borderLeft: `3px solid ${detectedPosition === 'supporting' ? '#10b981' : '#f97316'}`
                    }}>
                      <p style={{ fontSize: '12px', color: '#6b7280', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        Preview
                      </p>
                      <p style={{
                        fontSize: '16px',
                        color: '#1f2937',
                        lineHeight: 1.6,
                        margin: 0,
                        fontFamily: 'Georgia, serif'
                      }}>
                        {newArgument.trim()}
                      </p>
                    </div>
                  )}

                  <input
                    ref={fileInputRef}
                    type="file"
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []).filter(f => f.size <= 10 * 1024 * 1024);
                      setSelectedFiles(prev => [...prev, ...files]);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                    multiple
                    style={{ display: 'none' }}
                    accept=".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png"
                  />

                  {selectedFiles.length > 0 && (
                    <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {selectedFiles.map((file, i) => (
                        <div key={i} style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '12px',
                          padding: '10px 12px',
                          backgroundColor: '#f3f4f6',
                          borderRadius: '6px',
                          fontSize: '14px'
                        }}>
                          <FileText style={{ width: '16px', height: '16px', color: '#6b7280' }} />
                          <span style={{ flex: 1, color: '#374151' }}>{file.name}</span>
                          <span style={{ color: '#9ca3af', fontSize: '13px' }}>{formatFileSize(file.size)}</span>
                          <button
                            onClick={() => setSelectedFiles(prev => prev.filter((_, idx) => idx !== i))}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: '4px' }}
                          >
                            <Trash2 style={{ width: '14px', height: '14px' }} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '20px' }}>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      style={{
                        fontSize: '14px',
                        color: '#6b7280',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '8px 0'
                      }}
                    >
                      + Add source
                    </button>
                    <button
                      onClick={handleSubmit}
                      disabled={submitting || !newArgument.trim() || !detectedPosition}
                      style={{
                        marginLeft: 'auto',
                        padding: '12px 28px',
                        fontSize: '15px',
                        fontWeight: 600,
                        color: '#fff',
                        backgroundColor: (submitting || !newArgument.trim() || !detectedPosition) ? '#d1d5db' : '#111827',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: (submitting || !newArgument.trim() || !detectedPosition) ? 'not-allowed' : 'pointer'
                      }}
                    >
                      {submitting ? 'Publishing...' : 'Publish argument'}
                    </button>
                  </div>
                </>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
