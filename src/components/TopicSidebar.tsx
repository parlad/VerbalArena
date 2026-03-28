import { useState, useEffect } from 'react';
import { TrendingUp, Plus, ThumbsUp, ExternalLink, ChevronLeft, ChevronRight } from 'lucide-react';
import { supabase } from '../lib/supabase';

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

type TopicSidebarProps = {
  userId?: string;
  userPreferences: string[];
  onCreateTopic: () => void;
  onTopicSelect: (topic: Topic) => void;
  selectedTopicId?: string;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
};

export function TopicSidebar({ userId, userPreferences, onCreateTopic, onTopicSelect, selectedTopicId, isCollapsed, onToggleCollapse }: TopicSidebarProps) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [userVotes, setUserVotes] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadTopics();
    if (userId) {
      loadUserVotes();
    }
  }, [userPreferences, userId]);

  async function loadTopics() {
    let query = supabase
      .from('topics')
      .select('*')
      .eq('status', 'approved')
      .order('vote_count', { ascending: false })
      .limit(20);

    if (userPreferences.length > 0) {
      query = query.in('category', userPreferences);
    }

    const { data } = await query;
    setTopics(data || []);
    setLoading(false);
  }

  async function loadUserVotes() {
    if (!userId) return;

    const { data } = await supabase
      .from('topic_votes')
      .select('topic_id')
      .eq('user_id', userId);

    if (data) {
      setUserVotes(new Set(data.map(v => v.topic_id)));
    }
  }

  async function handleVote(topicId: string) {
    if (!userId) return;

    const hasVoted = userVotes.has(topicId);

    if (hasVoted) {
      await supabase
        .from('topic_votes')
        .delete()
        .eq('user_id', userId)
        .eq('topic_id', topicId);

      await supabase.rpc('decrement_topic_votes', { topic_id: topicId });

      setUserVotes(prev => {
        const next = new Set(prev);
        next.delete(topicId);
        return next;
      });

      setTopics(prev => prev.map(t =>
        t.topic_id === topicId ? { ...t, vote_count: t.vote_count - 1 } : t
      ));
    } else {
      await supabase
        .from('topic_votes')
        .insert({ user_id: userId, topic_id: topicId });

      await supabase.rpc('increment_topic_votes', { topic_id: topicId });

      setUserVotes(prev => new Set(prev).add(topicId));

      setTopics(prev => prev.map(t =>
        t.topic_id === topicId ? { ...t, vote_count: t.vote_count + 1 } : t
      ));
    }
  }

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
    <div className={`relative group animate-slide-down transition-all duration-300 ${isCollapsed ? 'w-16' : 'w-full'}`}>
      <div className="absolute inset-0 bg-gradient-to-br from-blue-200/20 to-slate-200/20 rounded-3xl blur-xl"></div>
      <div className="relative glass-effect smooth-shadow rounded-3xl p-4 h-full overflow-hidden flex flex-col">
        <div className="flex items-center justify-between mb-4">
          {!isCollapsed && (
            <>
              <div className="flex items-center gap-2">
                <div className="p-1.5 bg-gradient-to-br from-orange-500 to-pink-600 rounded-lg">
                  <TrendingUp className="w-4 h-4 text-white" />
                </div>
                <div>
                  <h2 className="text-base font-bold bg-gradient-to-r from-slate-900 to-slate-700 dark:from-white dark:to-slate-300 bg-clip-text text-transparent">
                    Trending Topics
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">Hot discussions</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={onCreateTopic}
                  className="p-2 bg-gradient-to-br from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white rounded-lg smooth-shadow hover:scale-110 transition-all"
                  title="Create New Topic"
                >
                  <Plus className="w-4 h-4" />
                </button>
                <button
                  onClick={onToggleCollapse}
                  className="p-2 glass-effect hover:bg-white text-slate-600 hover:text-slate-900 rounded-lg smooth-shadow hover:scale-110 transition-all"
                  title="Collapse Sidebar"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
              </div>
            </>
          )}
          {isCollapsed && (
            <div className="flex flex-col items-center gap-3 mx-auto">
              <button
                onClick={onToggleCollapse}
                className="p-3 glass-effect hover:bg-white text-slate-600 hover:text-slate-900 rounded-xl smooth-shadow hover:scale-110 transition-all"
                title="Expand Sidebar"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
              <button
                onClick={onCreateTopic}
                className="p-3 bg-gradient-to-br from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white rounded-xl smooth-shadow hover:scale-110 transition-all"
                title="Create New Topic"
              >
                <Plus className="w-5 h-5" />
              </button>
              <div className="p-2 bg-gradient-to-br from-orange-500 to-pink-600 rounded-xl">
                <TrendingUp className="w-5 h-5 text-white" />
              </div>
            </div>
          )}
        </div>

        {!isCollapsed && (loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-12 h-12 border-4 border-slate-200 dark:border-slate-700 border-t-violet-500 rounded-full animate-spin mx-auto mb-3"></div>
              <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">Loading topics...</p>
            </div>
          </div>
        ) : topics.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center p-6">
              <div className="w-20 h-20 bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-700 dark:to-slate-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <TrendingUp className="w-10 h-10 text-slate-400 dark:text-slate-500" />
              </div>
              <p className="text-slate-600 dark:text-slate-400 font-medium mb-4">No topics found for your interests.</p>
              <button
                onClick={onCreateTopic}
                className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white px-6 py-3 rounded-xl font-bold smooth-shadow hover:scale-105 transition-all"
              >
                Create the first one!
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto pr-2 space-y-2">
            {topics.map((topic, index) => (
              <div
                key={topic.topic_id}
                className={`relative group/item cursor-pointer transition-all animate-fade-in ${
                  selectedTopicId === topic.topic_id
                    ? 'scale-[1.02]'
                    : 'hover:scale-[1.02]'
                }`}
                style={{ animationDelay: `${index * 0.05}s` }}
                onClick={() => onTopicSelect(topic)}
              >
                <div className={`absolute inset-0 rounded-2xl blur-lg transition-all ${
                  selectedTopicId === topic.topic_id
                    ? 'bg-violet-400/25 dark:bg-violet-500/20'
                    : 'bg-slate-200/20 dark:bg-transparent group-hover/item:bg-slate-300/30 dark:group-hover/item:bg-slate-700/30'
                }`}></div>
                <div className={`relative border-2 rounded-xl p-3 transition-all ${
                  selectedTopicId === topic.topic_id
                    ? 'border-violet-400 dark:border-violet-500 bg-gradient-to-br from-violet-50 to-white dark:from-violet-900/25 dark:to-slate-800 shadow-lg'
                    : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/80 hover:border-slate-300 dark:hover:border-slate-600 hover:shadow-md'
                }`}>
                  <div className="flex items-start gap-2 mb-2">
                    <div className="w-8 h-8 bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-700 dark:to-slate-600 rounded-lg flex items-center justify-center text-base flex-shrink-0">
                      {getCategoryEmoji(topic.category)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-bold text-slate-900 dark:text-slate-100 text-sm leading-tight mb-0.5">
                        {topic.title}
                      </h3>
                      {topic.description && (
                        <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed">
                          {topic.description}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100 dark:border-slate-700">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleVote(topic.topic_id);
                      }}
                      disabled={!userId}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                        userVotes.has(topic.topic_id)
                          ? 'bg-gradient-to-r from-violet-500 to-violet-600 text-white shadow-md scale-105'
                          : 'glass-effect text-slate-700 dark:text-slate-300 hover:scale-105'
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      <ThumbsUp className="w-3 h-3" />
                      <span>{topic.vote_count}</span>
                    </button>
                    <div className="flex items-center gap-1.5">
                      {topic.source !== 'user_created' && (
                        <span className="text-xs text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded font-medium">
                          {topic.source}
                        </span>
                      )}
                      {topic.external_url && (
                        <a
                          href={topic.external_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="p-2 glass-effect hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 transition-all"
                          title="View source"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
