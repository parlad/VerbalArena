import { useState, useEffect, useRef } from 'react';
import { X, Send, ThumbsUp, ThumbsDown, ExternalLink, Paperclip, FileIcon, Trash2, Handshake, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react';
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

type Agreement = {
  agreement_id: string;
  topic_id: string;
  content: string;
  created_by: string;
  created_at: string;
  is_active: boolean;
  supporting_opinion_id?: string;
  opposing_opinion_id?: string;
  display_position: number;
  users: {
    username: string;
  };
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
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [newAgreement, setNewAgreement] = useState('');
  const [showAgreementForm, setShowAgreementForm] = useState<{ supporting?: string; opposing?: string } | null>(null);
  const [factCheckingOpinion, setFactCheckingOpinion] = useState<string | null>(null);
  const [collapsedFactChecks, setCollapsedFactChecks] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadOpinions();
    loadUserVotes();
    loadAgreements();
    subscribeToOpinions();
    subscribeToAgreements();
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
      setCollapsedFactChecks(new Set(
        (data || [])
          .filter(opinion => opinion.fact_check_result)
          .map(opinion => opinion.opinion_id)
      ));
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

  async function loadAgreements() {
    const { data, error } = await supabase
      .from('topic_agreements')
      .select(`
        *,
        users:created_by (
          username
        )
      `)
      .eq('topic_id', topic.topic_id)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error loading agreements:', error);
    } else {
      setAgreements(data || []);
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
            .eq('user_id', (payload.new as any).user_id)
            .single();

          if (userData) {
            setOpinions((current) => [
              ...current,
              { ...payload.new as any, users: userData }
            ]);
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'topic_opinions', filter: `topic_id=eq.${topic.topic_id}` },
        async (payload) => {
          const newOpinion = payload.new as any;
          if (newOpinion.fact_check_result) {
            setCollapsedFactChecks(prev => new Set(prev).add(newOpinion.opinion_id));
          }
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

  function subscribeToAgreements() {
    const channel = supabase
      .channel(`topic_agreements_${topic.topic_id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'topic_agreements', filter: `topic_id=eq.${topic.topic_id}` },
        async (payload) => {
          const { data: userData } = await supabase
            .from('users')
            .select('username')
            .eq('user_id', (payload.new as any).created_by)
            .single();

          if (userData) {
            setAgreements((current) => [
              { ...payload.new as any, users: userData },
              ...current
            ]);
          }
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

      console.log('=== OPINION SUBMISSION ===');
      console.log('Opinion Text:', opinionText);
      console.log('Topic:', topic.title);

      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/detect-opinion-position`;
      const headers = {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      };

      console.log('Calling AI classification API...');

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
        const errorText = await aiResponse.text();
        console.error('AI API Error Response:', errorText);
        throw new Error(`AI classification failed: ${errorText}`);
      }

      const result = await aiResponse.json();
      console.log('AI Classification Result:', result);

      if (result.error || !result.position) {
        console.error('Error in AI response:', result);
        throw new Error(`AI classification error: ${result.error || 'No position returned'}`);
      }

      const detectedPosition = result.position === 'opposing' ? 'opposing' : 'supporting';
      console.log('✓ AI Classification Success:', detectedPosition);

      console.log('=== FINAL CLASSIFICATION ===');
      console.log('Opinion:', opinionText);
      console.log('Position:', detectedPosition);
      console.log('==========================');

      console.log('>>>>>> ABOUT TO INSERT INTO DATABASE <<<<<<');
      console.log('Position being inserted:', detectedPosition);

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
        console.error('ERROR POSTING OPINION:', error);
        alert(`Failed to post opinion: ${error.message}`);
        setSubmitting(false);
        return;
      }

      console.log('>>>>>> DATABASE INSERT SUCCESSFUL <<<<<<');
      console.log('Data returned from database:', data);
      console.log('Position in returned data:', data?.position);

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

  function getSentimentColors(content: string, position: 'supporting' | 'opposing') {
    const text = content.toLowerCase();

    const veryPositive = ['amazing', 'excellent', 'love', 'best', 'perfect', 'wonderful', 'fantastic'];
    const positive = ['good', 'helpful', 'useful', 'beneficial', 'great', 'better', 'fast', 'easy'];
    const veryNegative = ['terrible', 'horrible', 'worst', 'hate', 'awful', 'disaster'];
    const negative = ['bad', 'harmful', 'dangerous', 'wrong', 'problem', 'lie', 'lies', 'false', 'fail', 'worse'];

    const hasVeryPositive = veryPositive.some(w => text.includes(w));
    const hasPositive = positive.some(w => text.includes(w));
    const hasVeryNegative = veryNegative.some(w => text.includes(w));
    const hasNegative = negative.some(w => text.includes(w));

    if (position === 'supporting') {
      if (hasVeryPositive) return { bg: 'bg-green-100', border: 'border-green-300', text: 'text-green-900', badge: 'bg-green-300 text-green-900', avatar: 'bg-green-700', accent: 'text-green-700' };
      if (hasPositive) return { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-900', badge: 'bg-emerald-200 text-emerald-800', avatar: 'bg-emerald-600', accent: 'text-emerald-700' };
      return { bg: 'bg-teal-50', border: 'border-teal-100', text: 'text-teal-900', badge: 'bg-teal-200 text-teal-800', avatar: 'bg-teal-600', accent: 'text-teal-600' };
    } else {
      if (hasVeryNegative) return { bg: 'bg-red-100', border: 'border-red-300', text: 'text-red-900', badge: 'bg-red-300 text-red-900', avatar: 'bg-red-700', accent: 'text-red-700' };
      if (hasNegative) return { bg: 'bg-rose-50', border: 'border-rose-200', text: 'text-rose-900', badge: 'bg-rose-200 text-rose-800', avatar: 'bg-rose-600', accent: 'text-rose-700' };
      return { bg: 'bg-orange-50', border: 'border-orange-100', text: 'text-orange-900', badge: 'bg-orange-200 text-orange-800', avatar: 'bg-orange-600', accent: 'text-orange-600' };
    }
  }

  async function handleSubmitAgreement(e: React.FormEvent) {
    e.preventDefault();

    if (!newAgreement.trim() || !userId || !showAgreementForm) return;

    const maxPosition = Math.max(
      ...opinions.map(o => new Date(o.created_at).getTime()),
      0
    );

    const { data, error } = await supabase
      .from('topic_agreements')
      .insert({
        topic_id: topic.topic_id,
        content: newAgreement.trim(),
        created_by: userId,
        is_active: true,
        supporting_opinion_id: showAgreementForm.supporting,
        opposing_opinion_id: showAgreementForm.opposing,
        display_position: maxPosition + 1
      })
      .select(`
        *,
        users:created_by (
          username
        )
      `)
      .single();

    if (error) {
      console.error('Error posting agreement:', error);
    } else if (data) {
      setAgreements((current) => [...current, data]);
      setNewAgreement('');
      setShowAgreementForm(null);
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

      console.log('Calling fact-check API...');

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
        const errorText = await response.text();
        console.error('Fact-check API Error:', errorText);
        throw new Error('Fact-check failed');
      }

      const factCheckResult = await response.json();
      console.log('Fact-check result:', factCheckResult);

      const { error: updateError } = await supabase
        .from('topic_opinions')
        .update({
          fact_check_result: factCheckResult,
          fact_checked_at: new Date().toISOString()
        })
        .eq('opinion_id', opinionId);

      if (updateError) {
        console.error('Error saving fact-check:', updateError);
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

  const supportingOpinions = opinions.filter(o => o.position === 'supporting');
  const opposingOpinions = opinions.filter(o => o.position === 'opposing');

  type TimelineItem =
    | { type: 'opinion'; data: Opinion; timestamp: number }
    | { type: 'agreement'; data: Agreement; timestamp: number };

  const buildTimeline = (): TimelineItem[] => {
    const items: TimelineItem[] = [
      ...opinions.map(o => ({ type: 'opinion' as const, data: o, timestamp: new Date(o.created_at).getTime() })),
      ...agreements.map(a => ({ type: 'agreement' as const, data: a, timestamp: a.display_position }))
    ];

    return items.sort((a, b) => a.timestamp - b.timestamp);
  };

  const timeline = buildTimeline();

  const getCategoryEmoji = (category: string) => {
    const emojiMap: Record<string, string> = {
      politics: '🏛️',
      ai: '🤖',
      crime: '⚖️',
      nature: '🌿',
      science: '🔬',
      space: '🚀',
      technology: '💻',
      health: '⚕️',
      economics: '💰',
      education: '📚',
      sports: '⚽',
      entertainment: '🎬'
    };
    return emojiMap[category] || '💬';
  };

  return (
    <div className="w-full">
      <div className="glass-effect smooth-shadow rounded-2xl p-5 mb-4 animate-slide-down">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-start gap-4 flex-1">
            <span className="text-4xl">{getCategoryEmoji(topic.category)}</span>
            <div className="flex-1">
              <h2 className="text-2xl font-bold text-slate-900 mb-1.5">
                {topic.title}
              </h2>
              {topic.description && (
                <p className="text-sm text-slate-600 mb-2 leading-relaxed">
                  {topic.description}
                </p>
              )}
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="bg-slate-100 px-2 py-0.5 rounded-full capitalize font-medium">
                  {topic.category}
                </span>
                {topic.source !== 'user_created' && (
                  <span className="bg-slate-100 px-2 py-0.5 rounded-full font-medium">
                    {topic.source}
                  </span>
                )}
                <span className="font-medium">{topic.vote_count} votes</span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 glass-effect hover:bg-rose-50 hover:text-rose-600 text-slate-400 rounded-xl transition-all"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {topic.external_url && (
          <a
            href={topic.external_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 glass-effect hover:bg-blue-50 text-blue-600 hover:text-blue-700 text-xs font-bold px-3 py-1.5 rounded-lg transition-all mt-3"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            View Source
          </a>
        )}
      </div>

      {loading ? (
        <div className="text-center text-slate-600 py-8">Loading opinions...</div>
      ) : (
        <>
          <div className="space-y-3">
            {timeline.map((item, index) => {
              if (item.type === 'agreement') {
                const agreement = item.data;
                const supportingOpinion = opinions.find(o => o.opinion_id === agreement.supporting_opinion_id);
                const opposingOpinion = opinions.find(o => o.opinion_id === agreement.opposing_opinion_id);

                return (
                  <div key={`agreement-${agreement.agreement_id}`} className="relative">
                    <div className="bg-gradient-to-r from-amber-50 to-yellow-50 rounded-2xl shadow-lg p-6 border-2 border-amber-300">
                      <div className="flex items-center gap-3 mb-4">
                        <Handshake className="w-6 h-6 text-amber-600" />
                        <h3 className="text-lg font-bold text-amber-900">Common Ground Found</h3>
                      </div>
                      <p className="text-slate-800 leading-relaxed mb-3 text-lg">{agreement.content}</p>

                      {(supportingOpinion || opposingOpinion) && (
                        <div className="grid md:grid-cols-2 gap-4 mt-4">
                          {supportingOpinion && (
                            <div className="bg-emerald-50 rounded-lg p-3 border border-emerald-200">
                              <div className="text-xs font-semibold text-emerald-700 mb-1">Supporting View</div>
                              <p className="text-sm text-slate-700">{supportingOpinion.content}</p>
                            </div>
                          )}
                          {opposingOpinion && (
                            <div className="bg-rose-50 rounded-lg p-3 border border-rose-200">
                              <div className="text-xs font-semibold text-rose-700 mb-1">Opposing View</div>
                              <p className="text-sm text-slate-700">{opposingOpinion.content}</p>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="flex items-center justify-between text-xs text-amber-700 mt-3">
                        <span>Suggested by {agreement.users.username}</span>
                        <span>{new Date(agreement.created_at).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                );
              } else {
                const opinion = item.data;
                const isSupporting = opinion.position === 'supporting';
                // Note: relatedAgreements available for future "linked agreements" feature
                void agreements.filter(
                  a => a.supporting_opinion_id === opinion.opinion_id || a.opposing_opinion_id === opinion.opinion_id
                );

                const colors = getSentimentColors(opinion.content, opinion.position);

                return (
                  <div key={`opinion-${opinion.opinion_id}`} className="grid md:grid-cols-2 gap-3 animate-fade-in" style={{ animationDelay: `${index * 0.05}s` }}>
                    {isSupporting ? (
                      <>
                        <div className={`${colors.bg} rounded-xl p-3 border ${colors.border} shadow-sm hover:shadow-md transition-all`}>
                          <div className="flex items-center gap-2 mb-2">
                            <div className={`w-7 h-7 ${colors.avatar} rounded-lg flex items-center justify-center text-white font-bold text-xs`}>
                              {opinion.users.username[0].toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className={`font-bold ${colors.text} text-xs truncate`}>{opinion.users.username}</span>
                                <span className={`text-xs ${colors.badge} px-1.5 py-0.5 rounded text-xs font-bold`}>
                                  Support
                                </span>
                              </div>
                              <div className="flex items-center gap-2 text-xs">
                                <span className={`${colors.accent} font-medium`}>{opinion.users.reputation_score} pts</span>
                                <span className="text-slate-400">•</span>
                                <span className="text-slate-500">{new Date(opinion.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                              </div>
                            </div>
                          </div>
                          <p className="text-slate-700 leading-relaxed text-sm mb-2.5">{opinion.content}</p>

                          {opinion.opinion_evidence && opinion.opinion_evidence.length > 0 && (
                            <div className="mb-2 space-y-1">
                              <p className={`text-xs font-bold ${colors.accent}`}>Evidence:</p>
                              {opinion.opinion_evidence.map((evidence) => (
                                <a
                                  key={evidence.evidence_id}
                                  href={evidence.file_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={`flex items-center gap-1.5 text-xs ${colors.accent} hover:opacity-80 bg-white px-2 py-1 rounded border ${colors.border} transition-all`}
                                >
                                  <FileIcon className="w-3 h-3" />
                                  <span className="flex-1 truncate font-medium">{evidence.file_name}</span>
                                  <span className="text-slate-500 text-xs">{formatFileSize(evidence.file_size)}</span>
                                </a>
                              ))}
                            </div>
                          )}

                          {opinion.fact_check_result && (
                            <div className={`mb-2 rounded-lg border ${
                              opinion.fact_check_result.verdict === 'true' ? 'bg-green-50 border-green-200' :
                              opinion.fact_check_result.verdict === 'false' ? 'bg-red-50 border-red-200' :
                              opinion.fact_check_result.verdict === 'mixed' ? 'bg-yellow-50 border-yellow-200' :
                              'bg-gray-50 border-gray-200'
                            }`}>
                              <button
                                onClick={() => {
                                  setCollapsedFactChecks(prev => {
                                    const next = new Set(prev);
                                    if (next.has(opinion.opinion_id)) {
                                      next.delete(opinion.opinion_id);
                                    } else {
                                      next.add(opinion.opinion_id);
                                    }
                                    return next;
                                  });
                                }}
                                className="w-full flex items-center justify-between p-2 hover:opacity-80 transition-opacity"
                              >
                                <div className="flex items-center gap-1.5">
                                  <CheckCircle2 className={`w-3.5 h-3.5 ${
                                    opinion.fact_check_result.verdict === 'true' ? 'text-green-700' :
                                    opinion.fact_check_result.verdict === 'false' ? 'text-red-700' :
                                    opinion.fact_check_result.verdict === 'mixed' ? 'text-yellow-700' :
                                    'text-gray-700'
                                  }`} />
                                  <span className={`text-xs font-bold uppercase ${
                                    opinion.fact_check_result.verdict === 'true' ? 'text-green-700' :
                                    opinion.fact_check_result.verdict === 'false' ? 'text-red-700' :
                                    opinion.fact_check_result.verdict === 'mixed' ? 'text-yellow-700' :
                                    'text-gray-700'
                                  }`}>
                                    Fact Check: {opinion.fact_check_result.verdict}
                                  </span>
                                </div>
                                {collapsedFactChecks.has(opinion.opinion_id) ? (
                                  <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                                ) : (
                                  <ChevronUp className="w-3.5 h-3.5 text-slate-500" />
                                )}
                              </button>
                              {!collapsedFactChecks.has(opinion.opinion_id) && (
                                <div className="px-2 pb-2">
                                  <p className="text-xs text-slate-700 mb-1 leading-relaxed">{opinion.fact_check_result.explanation}</p>
                                  {opinion.fact_check_result.sources && opinion.fact_check_result.sources.length > 0 && (
                                    <div className="text-xs text-slate-600 mt-1 pt-1 border-t border-slate-200">
                                      <p className="font-bold mb-0.5">Sources:</p>
                                      <ul className="list-disc list-inside space-y-0.5 text-xs">
                                        {opinion.fact_check_result.sources.map((source, idx) => (
                                          <li key={idx} className="leading-tight">{source}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          <div className="flex items-center gap-1.5 flex-wrap">
                            <button
                              onClick={() => handleVote(opinion.opinion_id, 'upvote')}
                              disabled={!userId}
                              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                                userVotes.get(opinion.opinion_id) === 'upvote'
                                  ? 'bg-emerald-100 text-emerald-900 scale-105'
                                  : 'text-emerald-700 hover:bg-emerald-50'
                              }`}
                            >
                              <ThumbsUp className="w-3 h-3" />
                              {opinion.upvotes}
                            </button>
                            <button
                              onClick={() => handleVote(opinion.opinion_id, 'downvote')}
                              disabled={!userId}
                              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                                userVotes.get(opinion.opinion_id) === 'downvote'
                                  ? 'bg-slate-200 text-slate-900 scale-105'
                                  : 'text-slate-500 hover:bg-slate-100'
                              }`}
                            >
                              <ThumbsDown className="w-3 h-3" />
                              {opinion.downvotes}
                            </button>
                            {userId && !opinion.fact_check_result && (
                              <button
                                onClick={() => handleFactCheck(opinion.opinion_id)}
                                disabled={factCheckingOpinion === opinion.opinion_id}
                                className="text-xs text-blue-700 hover:text-blue-900 font-bold flex items-center gap-1 bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded-lg border border-blue-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <CheckCircle2 className="w-3 h-3" />
                                {factCheckingOpinion === opinion.opinion_id ? 'Checking...' : 'Check'}
                              </button>
                            )}
                            {userId && opposingOpinions.length > 0 && (
                              <button
                                onClick={() => setShowAgreementForm({ supporting: opinion.opinion_id })}
                                className="ml-auto text-xs text-amber-700 hover:text-amber-900 font-bold flex items-center gap-1 bg-amber-50 hover:bg-amber-100 px-2 py-1 rounded-lg border border-amber-200 transition-all"
                              >
                                <Handshake className="w-3 h-3" />
                                Agreement
                              </button>
                            )}
                          </div>
                        </div>
                        <div></div>
                      </>
                    ) : (
                      <>
                        <div></div>
                        <div className={`${colors.bg} rounded-xl p-3 border ${colors.border} shadow-sm hover:shadow-md transition-all`}>
                          <div className="flex items-center gap-2 mb-2">
                            <div className={`w-7 h-7 ${colors.avatar} rounded-lg flex items-center justify-center text-white font-bold text-xs`}>
                              {opinion.users.username[0].toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className={`font-bold ${colors.text} text-xs truncate`}>{opinion.users.username}</span>
                                <span className={`text-xs ${colors.badge} px-1.5 py-0.5 rounded text-xs font-bold`}>
                                  Oppose
                                </span>
                              </div>
                              <div className="flex items-center gap-2 text-xs">
                                <span className={`${colors.accent} font-medium`}>{opinion.users.reputation_score} pts</span>
                                <span className="text-slate-400">•</span>
                                <span className="text-slate-500">{new Date(opinion.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                              </div>
                            </div>
                          </div>
                          <p className="text-slate-700 leading-relaxed text-sm mb-2.5">{opinion.content}</p>

                          {opinion.opinion_evidence && opinion.opinion_evidence.length > 0 && (
                            <div className="mb-2 space-y-1">
                              <p className={`text-xs font-bold ${colors.accent}`}>Evidence:</p>
                              {opinion.opinion_evidence.map((evidence) => (
                                <a
                                  key={evidence.evidence_id}
                                  href={evidence.file_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={`flex items-center gap-1.5 text-xs ${colors.accent} hover:opacity-80 bg-white px-2 py-1 rounded border ${colors.border} transition-all`}
                                >
                                  <FileIcon className="w-3 h-3" />
                                  <span className="flex-1 truncate font-medium">{evidence.file_name}</span>
                                  <span className="text-slate-500 text-xs">{formatFileSize(evidence.file_size)}</span>
                                </a>
                              ))}
                            </div>
                          )}

                          {opinion.fact_check_result && (
                            <div className={`mb-2 rounded-lg border ${
                              opinion.fact_check_result.verdict === 'true' ? 'bg-green-50 border-green-200' :
                              opinion.fact_check_result.verdict === 'false' ? 'bg-red-50 border-red-200' :
                              opinion.fact_check_result.verdict === 'mixed' ? 'bg-yellow-50 border-yellow-200' :
                              'bg-gray-50 border-gray-200'
                            }`}>
                              <button
                                onClick={() => {
                                  setCollapsedFactChecks(prev => {
                                    const next = new Set(prev);
                                    if (next.has(opinion.opinion_id)) {
                                      next.delete(opinion.opinion_id);
                                    } else {
                                      next.add(opinion.opinion_id);
                                    }
                                    return next;
                                  });
                                }}
                                className="w-full flex items-center justify-between p-2 hover:opacity-80 transition-opacity"
                              >
                                <div className="flex items-center gap-1.5">
                                  <CheckCircle2 className={`w-3.5 h-3.5 ${
                                    opinion.fact_check_result.verdict === 'true' ? 'text-green-700' :
                                    opinion.fact_check_result.verdict === 'false' ? 'text-red-700' :
                                    opinion.fact_check_result.verdict === 'mixed' ? 'text-yellow-700' :
                                    'text-gray-700'
                                  }`} />
                                  <span className={`text-xs font-bold uppercase ${
                                    opinion.fact_check_result.verdict === 'true' ? 'text-green-700' :
                                    opinion.fact_check_result.verdict === 'false' ? 'text-red-700' :
                                    opinion.fact_check_result.verdict === 'mixed' ? 'text-yellow-700' :
                                    'text-gray-700'
                                  }`}>
                                    Fact Check: {opinion.fact_check_result.verdict}
                                  </span>
                                </div>
                                {collapsedFactChecks.has(opinion.opinion_id) ? (
                                  <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                                ) : (
                                  <ChevronUp className="w-3.5 h-3.5 text-slate-500" />
                                )}
                              </button>
                              {!collapsedFactChecks.has(opinion.opinion_id) && (
                                <div className="px-2 pb-2">
                                  <p className="text-xs text-slate-700 mb-1 leading-relaxed">{opinion.fact_check_result.explanation}</p>
                                  {opinion.fact_check_result.sources && opinion.fact_check_result.sources.length > 0 && (
                                    <div className="text-xs text-slate-600 mt-1 pt-1 border-t border-slate-200">
                                      <p className="font-bold mb-0.5">Sources:</p>
                                      <ul className="list-disc list-inside space-y-0.5 text-xs">
                                        {opinion.fact_check_result.sources.map((source, idx) => (
                                          <li key={idx} className="leading-tight">{source}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleVote(opinion.opinion_id, 'upvote')}
                              disabled={!userId}
                              className={`flex items-center gap-1 text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                                userVotes.get(opinion.opinion_id) === 'upvote'
                                  ? `${colors.text} font-bold`
                                  : `${colors.accent} hover:opacity-80`
                              }`}
                            >
                              <ThumbsUp className="w-3 h-3" />
                              {opinion.upvotes}
                            </button>
                            <button
                              onClick={() => handleVote(opinion.opinion_id, 'downvote')}
                              disabled={!userId}
                              className={`flex items-center gap-1 text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                                userVotes.get(opinion.opinion_id) === 'downvote'
                                  ? 'text-slate-900 font-bold'
                                  : 'text-slate-500 hover:text-slate-700'
                              }`}
                            >
                              <ThumbsDown className="w-3 h-3" />
                              {opinion.downvotes}
                            </button>
                            {userId && !opinion.fact_check_result && (
                              <button
                                onClick={() => handleFactCheck(opinion.opinion_id)}
                                disabled={factCheckingOpinion === opinion.opinion_id}
                                className="text-xs text-blue-700 hover:text-blue-900 flex items-center gap-1 bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded border border-blue-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <CheckCircle2 className="w-3 h-3" />
                                {factCheckingOpinion === opinion.opinion_id ? 'Checking...' : 'Fact Check'}
                              </button>
                            )}
                            {userId && supportingOpinions.length > 0 && (
                              <button
                                onClick={() => setShowAgreementForm({ opposing: opinion.opinion_id })}
                                className="ml-auto text-xs text-amber-700 hover:text-amber-900 font-bold flex items-center gap-1 bg-amber-50 hover:bg-amber-100 px-2 py-1 rounded-lg border border-amber-200 transition-all"
                              >
                                <Handshake className="w-3 h-3" />
                                Agreement
                              </button>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                );
              }
            })}
          </div>

          <div className="bg-white rounded-2xl shadow-xl p-5 mt-6">
            <h3 className="text-lg font-bold text-slate-900 mb-4">Share Your Opinion</h3>

            {!userId ? (
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-center">
                <p className="text-sm text-slate-700">You need to sign in to share your opinion</p>
              </div>
            ) : (
              <form onSubmit={handleSubmitOpinion} className="space-y-4">
                <div>
                  <label htmlFor="opinion" className="block text-sm font-medium text-slate-700 mb-1.5">
                    Share Your Perspective
                  </label>
                  <p className="text-xs text-slate-500 mb-2">AI will automatically detect if you're supporting or opposing the topic</p>
                  <textarea
                    id="opinion"
                    name="opinion"
                    value={newOpinion}
                    onChange={(e) => setNewOpinion(e.target.value)}
                    placeholder="Share your thoughts and reasoning..."
                    rows={4}
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 outline-none transition-all resize-none text-sm"
                    required
                  />
                </div>

                <div>
                  <label htmlFor="evidence-files" className="block text-sm font-medium text-slate-700 mb-1.5">
                    Evidence Files (Optional)
                  </label>
                  <div className="space-y-2">
                    <input
                      id="evidence-files"
                      ref={fileInputRef}
                      type="file"
                      onChange={handleFileSelect}
                      multiple
                      className="hidden"
                      accept=".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png,.gif"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2.5 border-2 border-dashed border-slate-300 rounded-lg hover:border-slate-400 hover:bg-slate-50 transition-colors text-slate-600 text-sm"
                    >
                      <Paperclip className="w-4 h-4" />
                      <span>Attach Files (Max 10MB each)</span>
                    </button>

                    {selectedFiles.length > 0 && (
                      <div className="space-y-1.5">
                        {selectedFiles.map((file, index) => (
                          <div
                            key={index}
                            className="flex items-center gap-2 bg-slate-50 px-2.5 py-1.5 rounded-lg border border-slate-200"
                          >
                            <FileIcon className="w-3.5 h-3.5 text-slate-500" />
                            <span className="flex-1 text-xs text-slate-700 truncate">{file.name}</span>
                            <span className="text-xs text-slate-500">{formatFileSize(file.size)}</span>
                            <button
                              type="button"
                              onClick={() => removeFile(index)}
                              className="text-slate-400 hover:text-red-600 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting || !newOpinion.trim()}
                  className="w-full bg-slate-900 hover:bg-slate-800 text-white font-semibold py-3 px-4 rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                >
                  <Send className="w-4 h-4" />
                  {submitting ? 'Analyzing & Posting...' : 'Post Opinion'}
                </button>
              </form>
            )}
          </div>

          {showAgreementForm && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
              <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full p-8">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <Handshake className="w-6 h-6 text-amber-600" />
                    <h3 className="text-xl font-bold text-amber-900">Add Common Ground</h3>
                  </div>
                  <button
                    onClick={() => {
                      setShowAgreementForm(null);
                      setNewAgreement('');
                    }}
                    className="text-slate-400 hover:text-slate-600 transition-colors"
                  >
                    <X className="w-6 h-6" />
                  </button>
                </div>

                {showAgreementForm.supporting && (
                  <div className="mb-4 p-3 bg-emerald-50 rounded-lg border border-emerald-200">
                    <div className="text-xs font-semibold text-emerald-700 mb-1">Supporting Opinion</div>
                    <p className="text-sm text-slate-700">
                      {opinions.find(o => o.opinion_id === showAgreementForm.supporting)?.content}
                    </p>
                  </div>
                )}

                {showAgreementForm.opposing && (
                  <div className="mb-4 p-3 bg-rose-50 rounded-lg border border-rose-200">
                    <div className="text-xs font-semibold text-rose-700 mb-1">Opposing Opinion</div>
                    <p className="text-sm text-slate-700">
                      {opinions.find(o => o.opinion_id === showAgreementForm.opposing)?.content}
                    </p>
                  </div>
                )}

                <form onSubmit={handleSubmitAgreement} className="space-y-4">
                  <div>
                    <label htmlFor="agreement" className="block text-sm font-medium text-amber-900 mb-2">
                      Select the opposing opinion this agrees with:
                    </label>
                    {showAgreementForm.supporting && (
                      <select
                        onChange={(e) => setShowAgreementForm({ ...showAgreementForm, opposing: e.target.value })}
                        value={showAgreementForm.opposing || ''}
                        className="w-full px-4 py-3 rounded-xl border border-amber-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition-all bg-white mb-4"
                        required
                      >
                        <option value="">Select an opposing opinion...</option>
                        {opposingOpinions.map(opinion => (
                          <option key={opinion.opinion_id} value={opinion.opinion_id}>
                            {opinion.content.substring(0, 100)}...
                          </option>
                        ))}
                      </select>
                    )}
                    {showAgreementForm.opposing && (
                      <select
                        onChange={(e) => setShowAgreementForm({ ...showAgreementForm, supporting: e.target.value })}
                        value={showAgreementForm.supporting || ''}
                        className="w-full px-4 py-3 rounded-xl border border-amber-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition-all bg-white mb-4"
                        required
                      >
                        <option value="">Select a supporting opinion...</option>
                        {supportingOpinions.map(opinion => (
                          <option key={opinion.opinion_id} value={opinion.opinion_id}>
                            {opinion.content.substring(0, 100)}...
                          </option>
                        ))}
                      </select>
                    )}

                    <label htmlFor="agreement" className="block text-sm font-medium text-amber-900 mb-2">
                      What do these opinions agree on?
                    </label>
                    <textarea
                      id="agreement"
                      name="agreement"
                      value={newAgreement}
                      onChange={(e) => setNewAgreement(e.target.value)}
                      placeholder="Describe the common ground between these two viewpoints..."
                      rows={6}
                      className="w-full px-4 py-3 rounded-xl border border-amber-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition-all resize-none bg-white"
                      required
                    />
                  </div>

                  <div className="flex gap-3">
                    <button
                      type="submit"
                      disabled={!newAgreement.trim() || !showAgreementForm.supporting || !showAgreementForm.opposing}
                      className="flex-1 bg-amber-500 hover:bg-amber-600 text-white font-semibold py-3 px-6 rounded-xl transition-all flex items-center justify-center gap-2 shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Handshake className="w-5 h-5" />
                      Add Agreement
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAgreementForm(null);
                        setNewAgreement('');
                      }}
                      className="px-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium rounded-xl transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
