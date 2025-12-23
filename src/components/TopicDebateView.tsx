import { useState, useEffect, useRef, useMemo } from 'react';
import { ArrowLeft, ChevronDown, FileText, Trash2, ExternalLink, Check, AlertCircle, Minus } from 'lucide-react';
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

type AuthorGroup = {
  id: string;
  username: string;
  position: 'supporting' | 'opposing';
  primary: Opinion;
  additional: Opinion[];
};

export function TopicDebateView({ topic, userId, onClose }: TopicDebateViewProps) {
  const [opinions, setOpinions] = useState<Opinion[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [votes, setVotes] = useState<Map<string, 'agree' | 'disagree'>>(new Map());
  const [files, setFiles] = useState<File[]>([]);
  const [expandedAuthors, setExpandedAuthors] = useState<Set<string>>(new Set());
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(new Set());
  const [detectedStance, setDetectedStance] = useState<'supporting' | 'opposing' | null>(null);
  const [detecting, setDetecting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const detectTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    loadData();
    const cleanup = subscribe();
    return cleanup;
  }, [topic.topic_id]);

  useEffect(() => {
    if (detectTimer.current) clearTimeout(detectTimer.current);
    if (draft.trim().length > 30) {
      detectTimer.current = setTimeout(() => runDetection(draft), 600);
    } else {
      setDetectedStance(null);
    }
    return () => { if (detectTimer.current) clearTimeout(detectTimer.current); };
  }, [draft]);

  async function runDetection(text: string) {
    setDetecting(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/detect-opinion-position`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ topicTitle: topic.title, topicDescription: topic.description, opinionText: text })
      });
      if (res.ok) {
        const data = await res.json();
        setDetectedStance(data.position === 'opposing' ? 'opposing' : 'supporting');
      }
    } catch (e) { console.error(e); }
    setDetecting(false);
  }

  async function loadData() {
    const [opinionsRes, votesRes] = await Promise.all([
      supabase.from('topic_opinions').select(`*, users:user_id (username, reputation_score), opinion_evidence (*)`).eq('topic_id', topic.topic_id).order('created_at', { ascending: true }),
      userId ? supabase.from('topic_opinion_votes').select('opinion_id, vote_type').eq('user_id', userId) : Promise.resolve({ data: null })
    ]);
    if (opinionsRes.data) setOpinions(opinionsRes.data);
    if (votesRes.data) {
      const m = new Map<string, 'agree' | 'disagree'>();
      votesRes.data.forEach((v: { opinion_id: string; vote_type: string }) => m.set(v.opinion_id, v.vote_type === 'upvote' ? 'agree' : 'disagree'));
      setVotes(m);
    }
    setLoading(false);
  }

  function subscribe() {
    const ch = supabase.channel(`debate_${topic.topic_id}`).on('postgres_changes', { event: '*', schema: 'public', table: 'topic_opinions', filter: `topic_id=eq.${topic.topic_id}` }, () => loadData()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }

  async function publish() {
    if (!draft.trim() || !userId || !detectedStance) return;
    setPublishing(true);
    try {
      const { data, error } = await supabase.from('topic_opinions').insert({ topic_id: topic.topic_id, user_id: userId, content: draft.trim(), position: detectedStance, upvotes: 0, downvotes: 0 }).select(`*, users:user_id (username, reputation_score)`).single();
      if (error) throw error;
      if (data && files.length > 0) {
        await Promise.all(files.map(f => supabase.from('opinion_evidence').insert({ opinion_id: data.opinion_id, file_name: f.name, file_url: URL.createObjectURL(f), file_type: f.type, file_size: f.size, description: '' })));
      }
      setDraft('');
      setFiles([]);
      setDetectedStance(null);
      await loadData();
    } catch (e) { console.error(e); }
    setPublishing(false);
  }

  async function vote(opinionId: string, type: 'agree' | 'disagree') {
    if (!userId) return;
    const dbType = type === 'agree' ? 'upvote' : 'downvote';
    const current = votes.get(opinionId);
    if (current === type) {
      await supabase.from('topic_opinion_votes').delete().eq('user_id', userId).eq('opinion_id', opinionId);
      await supabase.rpc(type === 'agree' ? 'decrement_opinion_upvotes' : 'decrement_opinion_downvotes', { opinion_id_param: opinionId });
      setVotes(p => { const n = new Map(p); n.delete(opinionId); return n; });
      setOpinions(p => p.map(o => o.opinion_id === opinionId ? { ...o, [type === 'agree' ? 'upvotes' : 'downvotes']: Math.max(0, o[type === 'agree' ? 'upvotes' : 'downvotes'] - 1) } : o));
    } else {
      if (current) {
        await supabase.from('topic_opinion_votes').update({ vote_type: dbType }).eq('user_id', userId).eq('opinion_id', opinionId);
        await supabase.rpc(current === 'agree' ? 'decrement_opinion_upvotes' : 'decrement_opinion_downvotes', { opinion_id_param: opinionId });
      } else {
        await supabase.from('topic_opinion_votes').insert({ user_id: userId, opinion_id: opinionId, vote_type: dbType });
      }
      await supabase.rpc(type === 'agree' ? 'increment_opinion_upvotes' : 'increment_opinion_downvotes', { opinion_id_param: opinionId });
      setVotes(p => { const n = new Map(p); n.set(opinionId, type); return n; });
      setOpinions(p => p.map(o => {
        if (o.opinion_id !== opinionId) return o;
        let up = o.upvotes, down = o.downvotes;
        if (current === 'agree') up = Math.max(0, up - 1);
        if (current === 'disagree') down = Math.max(0, down - 1);
        if (type === 'agree') up++;
        if (type === 'disagree') down++;
        return { ...o, upvotes: up, downvotes: down };
      }));
    }
  }

  async function factCheck(opinionId: string) {
    const op = opinions.find(o => o.opinion_id === opinionId);
    if (!op) return;
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fact-check-opinion`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ opinionText: op.content, topicTitle: topic.title, topicDescription: topic.description })
      });
      if (!res.ok) throw new Error();
      const result = await res.json();
      await supabase.from('topic_opinions').update({ fact_check_result: result, fact_checked_at: new Date().toISOString() }).eq('opinion_id', opinionId);
      setOpinions(p => p.map(o => o.opinion_id === opinionId ? { ...o, fact_check_result: result, fact_checked_at: new Date().toISOString() } : o));
      setExpandedDetails(p => new Set(p).add(opinionId));
    } catch (e) { console.error(e); }
  }

  const groups = useMemo((): AuthorGroup[] => {
    const byKey = new Map<string, Opinion[]>();
    opinions.forEach(o => {
      const k = `${o.user_id}-${o.position}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(o);
    });
    const result: AuthorGroup[] = [];
    byKey.forEach((ops) => {
      const sorted = [...ops].sort((a, b) => (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes));
      result.push({ id: `${sorted[0].user_id}-${sorted[0].position}`, username: sorted[0].users.username, position: sorted[0].position, primary: sorted[0], additional: sorted.slice(1) });
    });
    return result.sort((a, b) => new Date(a.primary.created_at).getTime() - new Date(b.primary.created_at).getTime());
  }, [opinions]);

  const stats = useMemo(() => {
    const sup = opinions.filter(o => o.position === 'supporting').length;
    const opp = opinions.filter(o => o.position === 'opposing').length;
    return { support: sup, oppose: opp, total: sup + opp };
  }, [opinions]);

  function formatSize(b: number) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  function FactStatus({ result, opinionId }: { result?: FactCheckResult; opinionId: string }) {
    const isExpanded = expandedDetails.has(opinionId);
    if (!result) {
      return (
        <button onClick={() => userId && factCheck(opinionId)} className="fact-status unchecked">
          <Minus size={12} />
          <span>Unchecked</span>
        </button>
      );
    }
    const config = {
      'true': { icon: <Check size={12} />, label: 'Verified', cls: 'verified' },
      'false': { icon: <AlertCircle size={12} />, label: 'Disputed', cls: 'disputed' },
      'mixed': { icon: <Minus size={12} />, label: 'Mixed', cls: 'mixed' },
      'unverifiable': { icon: <Minus size={12} />, label: 'Unverifiable', cls: 'unchecked' }
    }[result.verdict];
    return (
      <div className="fact-wrapper">
        <button onClick={() => setExpandedDetails(p => { const n = new Set(p); isExpanded ? n.delete(opinionId) : n.add(opinionId); return n; })} className={`fact-status ${config.cls}`}>
          {config.icon}
          <span>{config.label}</span>
          <ChevronDown size={12} style={{ transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </button>
        {isExpanded && (
          <div className="fact-details">
            <p>{result.explanation}</p>
            {result.sources && result.sources.length > 0 && <p className="fact-sources">Sources: {result.sources.join(', ')}</p>}
          </div>
        )}
      </div>
    );
  }

  function ArgumentCard({ opinion, nested = false }: { opinion: Opinion; nested?: boolean }) {
    const isSupport = opinion.position === 'supporting';
    const userVote = votes.get(opinion.opinion_id);
    const hasEvidence = opinion.opinion_evidence && opinion.opinion_evidence.length > 0;
    const evidenceExpanded = expandedDetails.has(`evidence-${opinion.opinion_id}`);

    return (
      <article className={`argument-card ${nested ? 'nested' : ''} ${isSupport ? 'support' : 'oppose'}`}>
        <div className="argument-stance">
          <span className={`stance-indicator ${isSupport ? 'for' : 'against'}`}>
            {isSupport ? 'For' : 'Against'}
          </span>
        </div>

        <blockquote className="argument-content">
          {opinion.content}
        </blockquote>

        <footer className="argument-footer">
          <div className="argument-meta">
            <span className="author">{opinion.users.username}</span>
            <FactStatus result={opinion.fact_check_result} opinionId={opinion.opinion_id} />
          </div>

          <div className="argument-actions">
            <button onClick={() => userId && vote(opinion.opinion_id, 'agree')} className={`action-btn ${userVote === 'agree' ? 'active-agree' : ''}`} disabled={!userId}>
              Agree{opinion.upvotes > 0 && ` (${opinion.upvotes})`}
            </button>
            <button onClick={() => userId && vote(opinion.opinion_id, 'disagree')} className={`action-btn ${userVote === 'disagree' ? 'active-disagree' : ''}`} disabled={!userId}>
              Disagree{opinion.downvotes > 0 && ` (${opinion.downvotes})`}
            </button>
            {hasEvidence && (
              <button onClick={() => setExpandedDetails(p => { const n = new Set(p); const k = `evidence-${opinion.opinion_id}`; n.has(k) ? n.delete(k) : n.add(k); return n; })} className="action-btn sources-btn">
                <ExternalLink size={14} />
                Sources
              </button>
            )}
          </div>

          {evidenceExpanded && hasEvidence && (
            <div className="evidence-list">
              {opinion.opinion_evidence!.map(e => (
                <a key={e.evidence_id} href={e.file_url} target="_blank" rel="noopener noreferrer" className="evidence-link">
                  <FileText size={14} />
                  {e.file_name}
                </a>
              ))}
            </div>
          )}
        </footer>
      </article>
    );
  }

  return (
    <div className="debate-page">
      <style>{`
        .debate-page {
          min-height: 100vh;
          background: #f8f9fa;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        .debate-container {
          max-width: 720px;
          margin: 0 auto;
          padding: 64px 24px 96px;
        }
        .back-link {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          color: #64748b;
          font-size: 14px;
          font-weight: 500;
          text-decoration: none;
          background: none;
          border: none;
          cursor: pointer;
          padding: 0;
          margin-bottom: 56px;
          transition: color 0.15s;
        }
        .back-link:hover { color: #334155; }

        /* Header */
        .debate-header {
          margin-bottom: 64px;
        }
        .debate-title {
          font-family: 'Georgia', serif;
          font-size: 48px;
          font-weight: 400;
          line-height: 1.15;
          color: #0f172a;
          margin: 0 0 20px;
          letter-spacing: -0.5px;
        }
        .debate-description {
          font-size: 20px;
          line-height: 1.6;
          color: #475569;
          margin: 0 0 40px;
        }
        .debate-stats {
          display: flex;
          align-items: center;
          gap: 32px;
          padding: 24px 0;
          border-top: 1px solid #e2e8f0;
          border-bottom: 1px solid #e2e8f0;
        }
        .stat-item {
          display: flex;
          align-items: baseline;
          gap: 8px;
        }
        .stat-number {
          font-size: 28px;
          font-weight: 600;
          color: #0f172a;
        }
        .stat-label {
          font-size: 14px;
          color: #64748b;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .stat-label.for { color: #059669; }
        .stat-label.against { color: #dc2626; }
        .stat-divider {
          width: 1px;
          height: 32px;
          background: #e2e8f0;
        }

        /* Arguments */
        .arguments-section {
          margin-bottom: 80px;
        }
        .arguments-heading {
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: #94a3b8;
          margin-bottom: 32px;
        }
        .author-group {
          margin-bottom: 24px;
        }
        .argument-card {
          background: #fff;
          border-radius: 12px;
          padding: 32px;
          margin-bottom: 2px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.04);
          border-left: 4px solid transparent;
        }
        .argument-card.support { border-left-color: #10b981; }
        .argument-card.oppose { border-left-color: #f97316; }
        .argument-card.nested {
          margin-left: 24px;
          margin-top: 12px;
          background: #fafafa;
          border-radius: 8px;
          padding: 24px;
        }
        .argument-stance {
          margin-bottom: 16px;
        }
        .stance-indicator {
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          padding: 4px 10px;
          border-radius: 4px;
        }
        .stance-indicator.for {
          background: #ecfdf5;
          color: #059669;
        }
        .stance-indicator.against {
          background: #fff7ed;
          color: #ea580c;
        }
        .argument-content {
          font-family: 'Georgia', serif;
          font-size: 19px;
          line-height: 1.7;
          color: #1e293b;
          margin: 0 0 24px;
          padding: 0;
          border: none;
        }
        .argument-footer {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .argument-meta {
          display: flex;
          align-items: center;
          gap: 16px;
          flex-wrap: wrap;
        }
        .author {
          font-size: 14px;
          font-weight: 500;
          color: #64748b;
        }
        .argument-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .action-btn {
          font-size: 13px;
          font-weight: 500;
          padding: 8px 14px;
          border-radius: 6px;
          border: 1px solid #e2e8f0;
          background: #fff;
          color: #64748b;
          cursor: pointer;
          transition: all 0.15s;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .action-btn:hover:not(:disabled) {
          border-color: #cbd5e1;
          color: #475569;
        }
        .action-btn:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .action-btn.active-agree {
          background: #ecfdf5;
          border-color: #10b981;
          color: #059669;
        }
        .action-btn.active-disagree {
          background: #fef2f2;
          border-color: #f87171;
          color: #dc2626;
        }
        .evidence-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding-top: 12px;
          border-top: 1px solid #f1f5f9;
        }
        .evidence-link {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          color: #3b82f6;
          text-decoration: none;
        }
        .evidence-link:hover { text-decoration: underline; }

        /* Fact check */
        .fact-wrapper { display: flex; flex-direction: column; }
        .fact-status {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.3px;
          padding: 4px 10px;
          border-radius: 4px;
          border: none;
          cursor: pointer;
          transition: opacity 0.15s;
        }
        .fact-status:hover { opacity: 0.8; }
        .fact-status.unchecked { background: #f1f5f9; color: #64748b; }
        .fact-status.verified { background: #ecfdf5; color: #059669; }
        .fact-status.disputed { background: #fef2f2; color: #dc2626; }
        .fact-status.mixed { background: #fffbeb; color: #d97706; }
        .fact-details {
          margin-top: 12px;
          padding: 16px;
          background: #f8fafc;
          border-radius: 8px;
          font-size: 14px;
          line-height: 1.6;
          color: #475569;
        }
        .fact-details p { margin: 0; }
        .fact-sources { margin-top: 12px !important; font-size: 13px; color: #64748b; }

        /* Expand more */
        .expand-more {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
          font-weight: 500;
          color: #64748b;
          background: none;
          border: none;
          cursor: pointer;
          padding: 12px 0 12px 28px;
          transition: color 0.15s;
        }
        .expand-more:hover { color: #334155; }

        /* Empty state */
        .empty-state {
          text-align: center;
          padding: 80px 24px;
        }
        .empty-state h3 {
          font-size: 20px;
          font-weight: 500;
          color: #334155;
          margin: 0 0 8px;
        }
        .empty-state p {
          font-size: 15px;
          color: #94a3b8;
          margin: 0;
        }

        /* Compose */
        .compose-section {
          background: #fff;
          border-radius: 16px;
          padding: 40px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.04);
        }
        .compose-header {
          margin-bottom: 24px;
        }
        .compose-title {
          font-size: 20px;
          font-weight: 600;
          color: #0f172a;
          margin: 0 0 8px;
        }
        .compose-subtitle {
          font-size: 15px;
          color: #64748b;
          margin: 0;
        }
        .compose-editor {
          width: 100%;
          min-height: 160px;
          padding: 20px;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          font-family: 'Georgia', serif;
          font-size: 17px;
          line-height: 1.7;
          color: #1e293b;
          resize: vertical;
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
          box-sizing: border-box;
        }
        .compose-editor:focus {
          border-color: #94a3b8;
          box-shadow: 0 0 0 3px rgba(148,163,184,0.1);
        }
        .compose-editor::placeholder { color: #94a3b8; }
        .stance-preview {
          margin-top: 20px;
          padding: 16px 20px;
          border-radius: 10px;
          font-size: 14px;
          font-weight: 500;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .stance-preview.detecting {
          background: #f8fafc;
          color: #64748b;
        }
        .stance-preview.supporting {
          background: #ecfdf5;
          color: #059669;
        }
        .stance-preview.opposing {
          background: #fff7ed;
          color: #ea580c;
        }
        .live-preview {
          margin-top: 24px;
          padding: 24px;
          background: #f8fafc;
          border-radius: 12px;
          border-left: 4px solid;
        }
        .live-preview.supporting { border-left-color: #10b981; }
        .live-preview.opposing { border-left-color: #f97316; }
        .preview-label {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          color: #94a3b8;
          margin-bottom: 12px;
        }
        .preview-text {
          font-family: 'Georgia', serif;
          font-size: 17px;
          line-height: 1.7;
          color: #1e293b;
          margin: 0;
        }
        .compose-files {
          margin-top: 20px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .file-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          background: #f8fafc;
          border-radius: 8px;
          font-size: 14px;
        }
        .file-item span { flex: 1; color: #334155; }
        .file-item small { color: #94a3b8; }
        .file-item button {
          background: none;
          border: none;
          color: #94a3b8;
          cursor: pointer;
          padding: 4px;
        }
        .file-item button:hover { color: #64748b; }
        .compose-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-top: 24px;
          padding-top: 24px;
          border-top: 1px solid #f1f5f9;
        }
        .add-source {
          font-size: 14px;
          font-weight: 500;
          color: #64748b;
          background: none;
          border: none;
          cursor: pointer;
          padding: 0;
        }
        .add-source:hover { color: #334155; }
        .publish-btn {
          padding: 14px 32px;
          font-size: 15px;
          font-weight: 600;
          color: #fff;
          background: #0f172a;
          border: none;
          border-radius: 10px;
          cursor: pointer;
          transition: background 0.15s;
        }
        .publish-btn:hover:not(:disabled) { background: #1e293b; }
        .publish-btn:disabled {
          background: #cbd5e1;
          cursor: not-allowed;
        }
        .signin-prompt {
          text-align: center;
          padding: 32px;
          background: #f8fafc;
          border-radius: 12px;
          font-size: 15px;
          color: #64748b;
        }
        .loading-state {
          text-align: center;
          padding: 64px;
          color: #64748b;
          font-size: 15px;
        }
      `}</style>

      <div className="debate-container">
        <button onClick={onClose} className="back-link">
          <ArrowLeft size={16} />
          Back to topics
        </button>

        <header className="debate-header">
          <h1 className="debate-title">{topic.title}</h1>
          {topic.description && <p className="debate-description">{topic.description}</p>}
          <div className="debate-stats">
            <div className="stat-item">
              <span className="stat-number">{stats.support}</span>
              <span className="stat-label for">For</span>
            </div>
            <div className="stat-divider" />
            <div className="stat-item">
              <span className="stat-number">{stats.oppose}</span>
              <span className="stat-label against">Against</span>
            </div>
          </div>
        </header>

        {loading ? (
          <div className="loading-state">Loading arguments...</div>
        ) : (
          <>
            <section className="arguments-section">
              <h2 className="arguments-heading">Arguments</h2>
              {groups.length === 0 ? (
                <div className="empty-state">
                  <h3>No arguments yet</h3>
                  <p>Be the first to share your perspective on this topic.</p>
                </div>
              ) : (
                groups.map(g => {
                  const isExpanded = expandedAuthors.has(g.id);
                  return (
                    <div key={g.id} className="author-group">
                      <ArgumentCard opinion={g.primary} />
                      {g.additional.length > 0 && (
                        <>
                          {isExpanded ? (
                            <>
                              {g.additional.map(op => <ArgumentCard key={op.opinion_id} opinion={op} nested />)}
                              <button onClick={() => setExpandedAuthors(p => { const n = new Set(p); n.delete(g.id); return n; })} className="expand-more">
                                <ChevronDown size={14} style={{ transform: 'rotate(180deg)' }} />
                                Show less
                              </button>
                            </>
                          ) : (
                            <button onClick={() => setExpandedAuthors(p => new Set(p).add(g.id))} className="expand-more">
                              <ChevronDown size={14} />
                              {g.additional.length} more from {g.username}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </section>

            <section className="compose-section">
              <div className="compose-header">
                <h2 className="compose-title">Contribute your argument</h2>
                <p className="compose-subtitle">Make one clear argument. Explain your reasoning.</p>
              </div>

              {!userId ? (
                <div className="signin-prompt">Sign in to contribute to this debate.</div>
              ) : (
                <>
                  <textarea
                    className="compose-editor"
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    placeholder="State your position clearly, then explain why you believe it..."
                  />

                  {(detecting || detectedStance) && (
                    <div className={`stance-preview ${detecting ? 'detecting' : detectedStance}`}>
                      {detecting ? 'Analyzing your position...' : (
                        <>This argument will be classified as <strong>{detectedStance === 'supporting' ? 'FOR' : 'AGAINST'}</strong> the topic.</>
                      )}
                    </div>
                  )}

                  {detectedStance && draft.trim().length > 30 && (
                    <div className={`live-preview ${detectedStance}`}>
                      <div className="preview-label">Preview</div>
                      <p className="preview-text">{draft.trim()}</p>
                    </div>
                  )}

                  <input ref={fileRef} type="file" onChange={e => { const f = Array.from(e.target.files || []).filter(x => x.size <= 10485760); setFiles(p => [...p, ...f]); if (fileRef.current) fileRef.current.value = ''; }} multiple style={{ display: 'none' }} accept=".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png" />

                  {files.length > 0 && (
                    <div className="compose-files">
                      {files.map((f, i) => (
                        <div key={i} className="file-item">
                          <FileText size={16} color="#64748b" />
                          <span>{f.name}</span>
                          <small>{formatSize(f.size)}</small>
                          <button onClick={() => setFiles(p => p.filter((_, idx) => idx !== i))}><Trash2 size={14} /></button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="compose-footer">
                    <button onClick={() => fileRef.current?.click()} className="add-source">+ Add source</button>
                    <button onClick={publish} disabled={publishing || !draft.trim() || !detectedStance} className="publish-btn">
                      {publishing ? 'Publishing...' : 'Publish'}
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
