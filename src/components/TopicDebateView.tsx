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
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'topic_opinions', filter: `topic_id=eq.${topic.topic_id}` },
        async (payload) => {
          const { data: userData } = await supabase.from('users').select('username, reputation_score').eq('user_id', (payload.new as Opinion).user_id).single();
          if (userData) {
            setOpinions((current) => [...current, { ...payload.new as Opinion, users: userData }]);
          }
        }
      )
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'topic_opinions', filter: `topic_id=eq.${topic.topic_id}` },
        async (payload) => {
          const newOp = payload.new as Opinion;
          setOpinions((current) => current.map((op) => op.opinion_id === newOp.opinion_id ? { ...op, ...newOp } : op));
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }

  async function handleSubmitOpinion(e: React.FormEvent) {
    e.preventDefault();
    if (!newOpinion.trim() || !userId) return;
    setSubmitting(true);
    try {
      const opinionText = newOpinion.trim();
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/detect-opinion-position`;
      const aiResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
        mode: 'cors',
        body: JSON.stringify({ topicTitle: topic.title, topicDescription: topic.description, opinionText })
      });
      if (!aiResponse.ok) throw new Error('AI classification failed');
      const result = await aiResponse.json();
      const detectedPosition = result.position === 'opposing' ? 'opposing' : 'supporting';
      const { data, error } = await supabase.from('topic_opinions').insert({ topic_id: topic.topic_id, user_id: userId, content: newOpinion.trim(), position: detectedPosition, upvotes: 0, downvotes: 0 }).select(`*, users:user_id (username, reputation_score)`).single();
      if (error) { alert(`Failed to post opinion: ${error.message}`); setSubmitting(false); return; }
      if (data && selectedFiles.length > 0) {
        await uploadEvidenceFiles(data.opinion_id);
        const { data: updatedOpinion } = await supabase.from('topic_opinions').select(`*, users:user_id (username, reputation_score), opinion_evidence (*)`).eq('opinion_id', data.opinion_id).single();
        if (updatedOpinion) setOpinions((current) => [...current, updatedOpinion]);
      } else if (data) {
        setOpinions((current) => [...current, data]);
      }
      setNewOpinion('');
      setSelectedFiles([]);
    } catch (error) {
      console.error('Error submitting opinion:', error);
      alert('Failed to submit opinion.');
    }
    setSubmitting(false);
  }

  async function uploadEvidenceFiles(opinionId: string) {
    await Promise.all(selectedFiles.map(async (file) => {
      const fileUrl = URL.createObjectURL(file);
      await supabase.from('opinion_evidence').insert({ opinion_id: opinionId, file_name: file.name, file_url: fileUrl, file_type: file.type, file_size: file.size, description: '' });
    }));
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []).filter(file => {
      if (file.size > 10 * 1024 * 1024) { alert(`File ${file.name} is too large.`); return false; }
      return true;
    });
    setSelectedFiles((prev) => [...prev, ...files]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeFile(index: number) { setSelectedFiles((prev) => prev.filter((_, i) => i !== index)); }
  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  async function handleVote(opinionId: string, voteType: 'upvote' | 'downvote') {
    if (!userId) return;
    const currentVote = userVotes.get(opinionId);
    if (currentVote === voteType) {
      await supabase.from('topic_opinion_votes').delete().eq('user_id', userId).eq('opinion_id', opinionId);
      await supabase.rpc(voteType === 'upvote' ? 'decrement_opinion_upvotes' : 'decrement_opinion_downvotes', { opinion_id_param: opinionId });
      setUserVotes(prev => { const next = new Map(prev); next.delete(opinionId); return next; });
      setOpinions(prev => prev.map(o => o.opinion_id === opinionId ? { ...o, upvotes: voteType === 'upvote' ? o.upvotes - 1 : o.upvotes, downvotes: voteType === 'downvote' ? o.downvotes - 1 : o.downvotes } : o));
    } else {
      if (currentVote) {
        await supabase.from('topic_opinion_votes').update({ vote_type: voteType }).eq('user_id', userId).eq('opinion_id', opinionId);
        await supabase.rpc(currentVote === 'upvote' ? 'decrement_opinion_upvotes' : 'decrement_opinion_downvotes', { opinion_id_param: opinionId });
        await supabase.rpc(voteType === 'upvote' ? 'increment_opinion_upvotes' : 'increment_opinion_downvotes', { opinion_id_param: opinionId });
        setOpinions(prev => prev.map(o => o.opinion_id === opinionId ? { ...o, upvotes: voteType === 'upvote' ? o.upvotes + 1 : o.upvotes - 1, downvotes: voteType === 'downvote' ? o.downvotes + 1 : o.downvotes - 1 } : o));
      } else {
        await supabase.from('topic_opinion_votes').insert({ user_id: userId, opinion_id: opinionId, vote_type: voteType });
        await supabase.rpc(voteType === 'upvote' ? 'increment_opinion_upvotes' : 'increment_opinion_downvotes', { opinion_id_param: opinionId });
        setOpinions(prev => prev.map(o => o.opinion_id === opinionId ? { ...o, upvotes: voteType === 'upvote' ? o.upvotes + 1 : o.upvotes, downvotes: voteType === 'downvote' ? o.downvotes + 1 : o.downvotes } : o));
      }
      setUserVotes(prev => { const next = new Map(prev); next.set(opinionId, voteType); return next; });
    }
  }

  async function handleFactCheck(opinionId: string) {
    if (!userId) return;
    setFactCheckingOpinion(opinionId);
    const opinion = opinions.find(o => o.opinion_id === opinionId);
    if (!opinion) { setFactCheckingOpinion(null); return; }
    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fact-check-opinion`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
        mode: 'cors',
        body: JSON.stringify({ opinionText: opinion.content, topicTitle: topic.title, topicDescription: topic.description })
      });
      if (!response.ok) throw new Error('Fact-check failed');
      const factCheckResult = await response.json();
      await supabase.from('topic_opinions').update({ fact_check_result: factCheckResult, fact_checked_at: new Date().toISOString() }).eq('opinion_id', opinionId);
      setOpinions(prev => prev.map(o => o.opinion_id === opinionId ? { ...o, fact_check_result: factCheckResult, fact_checked_at: new Date().toISOString() } : o));
    } catch (error) {
      console.error('Fact-check error:', error);
      alert('Failed to fact-check.');
    }
    setFactCheckingOpinion(null);
  }

  function getRelativeTime(dateString: string): string {
    const diffMs = Date.now() - new Date(dateString).getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'now';
    if (diffMins < 60) return `${diffMins}m`;
    const diffHours = Math.floor(diffMs / 3600000);
    if (diffHours < 24) return `${diffHours}h`;
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays < 7) return `${diffDays}d`;
    return new Date(dateString).toLocaleDateString();
  }

  const processedOpinions = useMemo(() => {
    const authorOpinions = new Map<string, Opinion[]>();
    opinions.forEach(op => {
      const key = `${op.user_id}-${op.position}`;
      if (!authorOpinions.has(key)) authorOpinions.set(key, []);
      authorOpinions.get(key)!.push(op);
    });
    const result: { opinion: Opinion; collapsed: Opinion[]; isCollapsed: boolean }[] = [];
    const processedIds = new Set<string>();
    opinions.forEach(op => {
      if (processedIds.has(op.opinion_id)) return;
      const key = `${op.user_id}-${op.position}`;
      const authorOps = authorOpinions.get(key)!;
      if (authorOps.length > 1) {
        const sorted = [...authorOps].sort((a, b) => (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes));
        authorOps.forEach(o => processedIds.add(o.opinion_id));
        const isExpanded = expandedAuthors.has(key);
        if (isExpanded) {
          sorted.forEach((o, idx) => result.push({ opinion: o, collapsed: idx === 0 ? sorted.slice(1) : [], isCollapsed: false }));
        } else {
          result.push({ opinion: sorted[0], collapsed: sorted.slice(1), isCollapsed: true });
        }
      } else {
        processedIds.add(op.opinion_id);
        result.push({ opinion: op, collapsed: [], isCollapsed: false });
      }
    });
    return result.sort((a, b) => new Date(a.opinion.created_at).getTime() - new Date(b.opinion.created_at).getTime());
  }, [opinions, expandedAuthors]);

  const supportCount = opinions.filter(o => o.position === 'supporting').length;
  const opposeCount = opinions.filter(o => o.position === 'opposing').length;

  const toggleAuthorExpand = (odUserId: string, position: string) => {
    const key = `${odUserId}-${position}`;
    setExpandedAuthors(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next; });
  };

  return (
    <div style={{ backgroundColor: '#ffffff', minHeight: '100vh', width: '100%' }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '32px 24px' }}>
        <button
          onClick={onClose}
          style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#6b7280', marginBottom: '32px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '15px', fontWeight: 500 }}
        >
          <ArrowLeft style={{ width: '18px', height: '18px' }} />
          Back to topics
        </button>

        <header style={{ marginBottom: '40px' }}>
          <h1 style={{ fontSize: '36px', fontWeight: 700, color: '#111827', lineHeight: 1.2, marginBottom: '16px' }}>
            {topic.title}
          </h1>
          {topic.description && (
            <p style={{ fontSize: '18px', color: '#4b5563', lineHeight: 1.6 }}>
              {topic.description}
            </p>
          )}
          <div style={{ display: 'flex', gap: '24px', marginTop: '24px', paddingTop: '20px', borderTop: '1px solid #e5e7eb' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#10b981' }}></div>
              <span style={{ fontSize: '15px', fontWeight: 600, color: '#374151' }}>{supportCount} supporting</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#f97316' }}></div>
              <span style={{ fontSize: '15px', fontWeight: 600, color: '#374151' }}>{opposeCount} opposing</span>
            </div>
          </div>
        </header>

        {loading ? (
          <div style={{ padding: '60px 0', textAlign: 'center' }}>
            <p style={{ color: '#6b7280', fontSize: '16px' }}>Loading arguments...</p>
          </div>
        ) : (
          <>
            <div>
              {processedOpinions.length === 0 ? (
                <div style={{ padding: '60px 0', textAlign: 'center' }}>
                  <p style={{ color: '#6b7280', fontSize: '18px', marginBottom: '8px' }}>No arguments yet</p>
                  <p style={{ color: '#9ca3af', fontSize: '15px' }}>Be the first to share your perspective</p>
                </div>
              ) : (
                processedOpinions.map(({ opinion, collapsed, isCollapsed }) => {
                  const isSupporting = opinion.position === 'supporting';
                  const score = opinion.upvotes - opinion.downvotes;
                  const isLowQuality = score < -2 || (opinion.content.length < 50 && score < 1);
                  const hasVoted = userVotes.get(opinion.opinion_id);

                  return (
                    <div
                      key={opinion.opinion_id}
                      style={{
                        padding: '20px 0',
                        borderBottom: '1px solid #f3f4f6',
                        opacity: isLowQuality ? 0.5 : 1
                      }}
                    >
                      <div style={{ display: 'flex', gap: '16px' }}>
                        <div
                          style={{
                            width: '44px',
                            height: '44px',
                            borderRadius: '50%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '18px',
                            fontWeight: 700,
                            flexShrink: 0,
                            backgroundColor: isSupporting ? '#d1fae5' : '#ffedd5',
                            color: isSupporting ? '#047857' : '#c2410c'
                          }}
                        >
                          {opinion.users.username[0].toUpperCase()}
                        </div>

                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                            <span style={{ fontSize: '16px', fontWeight: 700, color: '#111827' }}>
                              {opinion.users.username}
                            </span>
                            <span
                              style={{
                                fontSize: '13px',
                                padding: '3px 10px',
                                borderRadius: '12px',
                                fontWeight: 600,
                                backgroundColor: isSupporting ? '#d1fae5' : '#ffedd5',
                                color: isSupporting ? '#047857' : '#c2410c'
                              }}
                            >
                              {isSupporting ? 'supports' : 'opposes'}
                            </span>
                            <span style={{ fontSize: '13px', color: '#9ca3af', display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <Clock style={{ width: '14px', height: '14px' }} />
                              {getRelativeTime(opinion.created_at)}
                            </span>
                          </div>

                          <p style={{ fontSize: '16px', color: '#1f2937', lineHeight: 1.7, marginBottom: '12px', whiteSpace: 'pre-wrap' }}>
                            {opinion.content}
                          </p>

                          {opinion.opinion_evidence && opinion.opinion_evidence.length > 0 && (
                            <div style={{ marginBottom: '12px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                              {opinion.opinion_evidence.map((evidence) => (
                                <a
                                  key={evidence.evidence_id}
                                  href={evidence.file_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '14px', color: '#374151', backgroundColor: '#f3f4f6', padding: '6px 12px', borderRadius: '8px', textDecoration: 'none' }}
                                >
                                  <FileText style={{ width: '14px', height: '14px' }} />
                                  {evidence.file_name}
                                </a>
                              ))}
                            </div>
                          )}

                          {opinion.fact_check_result && (
                            <div style={{ marginBottom: '12px' }}>
                              <button
                                onClick={() => setExpandedFactChecks(prev => { const next = new Set(prev); next.has(opinion.opinion_id) ? next.delete(opinion.opinion_id) : next.add(opinion.opinion_id); return next; })}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '6px',
                                  fontSize: '13px',
                                  padding: '6px 12px',
                                  borderRadius: '8px',
                                  border: 'none',
                                  cursor: 'pointer',
                                  fontWeight: 600,
                                  backgroundColor: opinion.fact_check_result.verdict === 'true' ? '#d1fae5' : opinion.fact_check_result.verdict === 'false' ? '#fee2e2' : '#fef3c7',
                                  color: opinion.fact_check_result.verdict === 'true' ? '#047857' : opinion.fact_check_result.verdict === 'false' ? '#b91c1c' : '#b45309'
                                }}
                              >
                                {opinion.fact_check_result.verdict === 'true' ? <Check style={{ width: '14px', height: '14px' }} /> : <AlertTriangle style={{ width: '14px', height: '14px' }} />}
                                {opinion.fact_check_result.verdict.toUpperCase()}
                                <ChevronDown style={{ width: '14px', height: '14px', transform: expandedFactChecks.has(opinion.opinion_id) ? 'rotate(180deg)' : 'none' }} />
                              </button>
                              {expandedFactChecks.has(opinion.opinion_id) && (
                                <div style={{ marginTop: '12px', padding: '12px', backgroundColor: '#f9fafb', borderRadius: '8px', border: '1px solid #e5e7eb' }}>
                                  <p style={{ fontSize: '14px', color: '#374151', lineHeight: 1.6 }}>{opinion.fact_check_result.explanation}</p>
                                  {opinion.fact_check_result.sources && opinion.fact_check_result.sources.length > 0 && (
                                    <p style={{ fontSize: '13px', color: '#6b7280', marginTop: '8px' }}>Sources: {opinion.fact_check_result.sources.join(', ')}</p>
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                            <button
                              onClick={() => handleVote(opinion.opinion_id, 'upvote')}
                              disabled={!userId}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                fontSize: '14px',
                                fontWeight: 600,
                                background: 'none',
                                border: 'none',
                                cursor: userId ? 'pointer' : 'default',
                                color: hasVoted === 'upvote' ? '#10b981' : '#9ca3af',
                                opacity: userId ? 1 : 0.5
                              }}
                            >
                              <ArrowUp style={{ width: '18px', height: '18px' }} />
                              {opinion.upvotes}
                            </button>

                            {userId && !opinion.fact_check_result && (
                              <button
                                onClick={() => handleFactCheck(opinion.opinion_id)}
                                disabled={factCheckingOpinion === opinion.opinion_id}
                                style={{ fontSize: '14px', color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer' }}
                              >
                                {factCheckingOpinion === opinion.opinion_id ? 'Checking...' : 'Fact check'}
                              </button>
                            )}
                          </div>

                          {collapsed.length > 0 && isCollapsed && (
                            <button
                              onClick={() => toggleAuthorExpand(opinion.user_id, opinion.position)}
                              style={{ marginTop: '12px', fontSize: '14px', color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
                            >
                              <User style={{ width: '14px', height: '14px' }} />
                              {collapsed.length} more from {opinion.users.username}
                              <ChevronDown style={{ width: '14px', height: '14px' }} />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div style={{ marginTop: '48px', paddingTop: '32px', borderTop: '2px solid #e5e7eb' }}>
              <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#111827', marginBottom: '20px' }}>
                Add your perspective
              </h2>

              {!userId ? (
                <div style={{ backgroundColor: '#f9fafb', borderRadius: '12px', padding: '32px', textAlign: 'center', border: '1px solid #e5e7eb' }}>
                  <p style={{ fontSize: '16px', color: '#374151', marginBottom: '8px', fontWeight: 500 }}>Sign in to join the discussion</p>
                  <p style={{ fontSize: '14px', color: '#6b7280' }}>Your position will be detected automatically</p>
                </div>
              ) : (
                <div>
                  <textarea
                    value={newOpinion}
                    onChange={(e) => setNewOpinion(e.target.value)}
                    placeholder="State your position clearly, then explain why..."
                    rows={5}
                    style={{
                      width: '100%',
                      padding: '16px',
                      borderRadius: '12px',
                      border: '2px solid #e5e7eb',
                      fontSize: '16px',
                      color: '#1f2937',
                      lineHeight: 1.6,
                      resize: 'none',
                      outline: 'none',
                      boxSizing: 'border-box',
                      backgroundColor: '#ffffff'
                    }}
                  />
                  <p style={{ fontSize: '13px', color: '#9ca3af', marginTop: '8px' }}>
                    AI will automatically detect whether you're supporting or opposing
                  </p>

                  <input ref={fileInputRef} type="file" onChange={handleFileSelect} multiple style={{ display: 'none' }} accept=".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png" />

                  {selectedFiles.length > 0 && (
                    <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {selectedFiles.map((file, index) => (
                        <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '12px', backgroundColor: '#f3f4f6', padding: '10px 14px', borderRadius: '8px' }}>
                          <FileText style={{ width: '18px', height: '18px', color: '#6b7280' }} />
                          <span style={{ flex: 1, fontSize: '14px', color: '#374151' }}>{file.name}</span>
                          <span style={{ fontSize: '13px', color: '#9ca3af' }}>{formatFileSize(file.size)}</span>
                          <button onClick={() => removeFile(index)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}>
                            <Trash2 style={{ width: '16px', height: '16px' }} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '16px' }}>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px', fontSize: '14px', fontWeight: 600, color: '#6b7280', backgroundColor: 'transparent', border: 'none', cursor: 'pointer', borderRadius: '8px' }}
                    >
                      <Paperclip style={{ width: '18px', height: '18px' }} />
                      Attach evidence
                    </button>

                    <button
                      onClick={handleSubmitOpinion}
                      disabled={submitting || !newOpinion.trim()}
                      style={{
                        marginLeft: 'auto',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '12px 24px',
                        fontSize: '15px',
                        fontWeight: 600,
                        color: '#ffffff',
                        backgroundColor: submitting || !newOpinion.trim() ? '#d1d5db' : '#111827',
                        border: 'none',
                        borderRadius: '10px',
                        cursor: submitting || !newOpinion.trim() ? 'not-allowed' : 'pointer'
                      }}
                    >
                      <Send style={{ width: '18px', height: '18px' }} />
                      {submitting ? 'Posting...' : 'Post argument'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
