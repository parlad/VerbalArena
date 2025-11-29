import { useEffect, useState } from 'react';
import { MessageSquare, Plus, LogOut, Settings, TrendingUp, Sparkles, ThumbsUp, ThumbsDown, CheckCircle2, AlertCircle, Search, Filter, ChevronDown, ChevronRight } from 'lucide-react';
import { supabase, type Debate, type ArgumentWithUser } from './lib/supabase';
import { AuthModal } from './components/AuthModal';
import { CreateDebateModal } from './components/CreateDebateModal';
import { TopicPreferencesModal } from './components/TopicPreferencesModal';
import { TopicSidebar } from './components/TopicSidebar';
import { CreateTopicModal } from './components/CreateTopicModal';
import { TopicDebateView } from './components/TopicDebateView';

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

function App() {
  const [currentUser, setCurrentUser] = useState<LocalUser | null>(null);
  const [debate, setDebate] = useState<Debate | null>(null);
  const [debateArguments, setDebateArguments] = useState<ArgumentWithUser[]>([]);
  const [newArgument, setNewArgument] = useState('');
  const [selectedPosition, setSelectedPosition] = useState<'supporting' | 'opposing'>('supporting');
  const [loading, setLoading] = useState(true);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showCreateDebate, setShowCreateDebate] = useState(false);
  const [showTopicPreferences, setShowTopicPreferences] = useState(false);
  const [showCreateTopic, setShowCreateTopic] = useState(false);
  const [userPreferences, setUserPreferences] = useState<string[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<Topic | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [collapsedCards, setCollapsedCards] = useState<Set<string>>(new Set());

  const toggleCardCollapse = (argumentId: string) => {
    setCollapsedCards(prev => {
      const newSet = new Set(prev);
      if (newSet.has(argumentId)) {
        newSet.delete(argumentId);
      } else {
        newSet.add(argumentId);
      }
      return newSet;
    });
  };

  useEffect(() => {
    const storedUser = localStorage.getItem('verbalarena_user');
    if (storedUser) {
      const user = JSON.parse(storedUser);
      setCurrentUser(user);
      loadUserPreferences(user.user_id);
    }

    loadDebate();
    subscribeToArguments();
  }, []);

  useEffect(() => {
    if (debate) {
      loadArguments();
    }
  }, [debate]);

  async function loadDebate() {
    const { data, error } = await supabase
      .from('debates')
      .select('*')
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('Error loading debate:', error);
    } else {
      setDebate(data);
    }
    setLoading(false);
  }

  async function loadArguments() {
    if (!debate?.debate_id) return;

    const { data, error } = await supabase
      .from('arguments')
      .select(`
        *,
        users:user_id (
          username,
          profile_picture_url,
          reputation_score
        )
      `)
      .eq('debate_id', debate.debate_id)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error loading arguments:', error);
    } else {
      setDebateArguments(data || []);
    }
  }

  function subscribeToArguments() {
    const channel = supabase
      .channel('arguments-channel')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'arguments' },
        () => {
          loadArguments();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }

  async function handleSubmitArgument(e: React.FormEvent) {
    e.preventDefault();
    if (!currentUser || !debate || !newArgument.trim()) return;

    const { error } = await supabase.from('arguments').insert({
      debate_id: debate.debate_id,
      user_id: currentUser.user_id,
      content: newArgument,
      position: selectedPosition,
    });

    if (error) {
      console.error('Error submitting argument:', error);
      alert('Failed to submit argument');
    } else {
      setNewArgument('');
      loadArguments();
    }
  }

  async function handleLogout() {
    localStorage.removeItem('verbalarena_user');
    setCurrentUser(null);
  }

  async function loadUserPreferences(userId: string) {
    const { data } = await supabase
      .from('user_preferences')
      .select('category')
      .eq('user_id', userId);

    if (data) {
      setUserPreferences(data.map(p => p.category));
    }
  }

  function handleAuthSuccess(user: LocalUser) {
    setCurrentUser(user);
    setShowAuthModal(false);
    loadUserPreferences(user.user_id);
  }

  function handleDebateCreated() {
    setShowCreateDebate(false);
    loadDebate();
  }

  function handleTopicCreated() {
    setShowCreateTopic(false);
  }

  function handleTopicSelect(topic: Topic) {
    setSelectedTopic(topic);
  }

  function handleCloseTopic() {
    setSelectedTopic(null);
  }

  const supportingArguments = debateArguments.filter(a => a.position === 'supporting');
  const opposingArguments = debateArguments.filter(a => a.position === 'opposing');

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin"></div>
          <div className="text-sm font-medium text-slate-600">Loading VerbalArena...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="sticky top-0 z-50 bg-white border-b border-slate-200 nav-shadow">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-3">
                <div className="bg-gradient-to-br from-blue-600 to-blue-700 p-2.5 rounded-lg">
                  <MessageSquare className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h1 className="text-xl font-bold text-slate-900">VerbalArena</h1>
                </div>
              </div>

              <div className="hidden md:flex items-center gap-2 ml-8">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search debates..."
                    className="pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent w-64"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {currentUser ? (
                <>
                  <button
                    onClick={() => setShowTopicPreferences(true)}
                    className="hidden md:flex items-center gap-2 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 rounded-lg transition-colors"
                  >
                    <Settings className="w-4 h-4" />
                    <span>Preferences</span>
                  </button>

                  <button
                    onClick={() => setShowCreateDebate(true)}
                    className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Create Debate</span>
                  </button>

                  <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-lg">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-600 to-blue-700 flex items-center justify-center text-white font-semibold text-sm">
                      {currentUser.username[0].toUpperCase()}
                    </div>
                    <div className="hidden md:block">
                      <div className="text-sm font-semibold text-slate-900 flex items-center gap-1">
                        {currentUser.username}
                        {currentUser.role === 'master' && <Sparkles className="w-3 h-3 text-amber-500" />}
                      </div>
                      <div className="text-xs text-slate-500">{currentUser.reputation_score} pts</div>
                    </div>
                  </div>

                  <button
                    onClick={handleLogout}
                    className="p-2 text-slate-600 hover:text-slate-900 hover:bg-slate-50 rounded-lg transition-colors"
                    title="Logout"
                  >
                    <LogOut className="w-5 h-5" />
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setShowAuthModal(true)}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium text-sm transition-colors"
                >
                  Sign In
                </button>
              )}
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex gap-8">
          <div className="flex-1 max-w-4xl">
            {selectedTopic ? (
              <TopicDebateView
                topic={selectedTopic}
                userId={currentUser?.user_id}
                onClose={handleCloseTopic}
              />
            ) : debate ? (
              <>
              <div className="bg-white rounded-2xl border border-slate-200 p-8 card-shadow mb-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 bg-emerald-50 text-emerald-700 text-xs font-semibold px-3 py-1.5 rounded-full">
                      <TrendingUp className="w-3.5 h-3.5" />
                      Active
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-slate-500">
                    <div className="flex items-center gap-1.5">
                      <MessageSquare className="w-4 h-4" />
                      <span className="font-semibold">{debateArguments.length}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <ThumbsUp className="w-4 h-4" />
                      <span className="font-semibold">{debate.upvotes || 0}</span>
                    </div>
                  </div>
                </div>

                <h2 className="text-3xl font-bold text-slate-900 mb-3 leading-tight">
                  {debate.title}
                </h2>

                <p className="text-slate-600 leading-relaxed mb-6">
                  {debate.description}
                </p>

                <div className="flex gap-3">
                  <div className="flex-1 bg-emerald-50 rounded-xl p-4 border border-emerald-100">
                    <div className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-1">Support</div>
                    <div className="text-sm font-semibold text-slate-900">{debate.supporting_label}</div>
                    <div className="text-xs text-slate-500 mt-1">{supportingArguments.length} arguments</div>
                  </div>
                  <div className="flex-1 bg-orange-50 rounded-xl p-4 border border-orange-100">
                    <div className="text-xs font-semibold text-orange-700 uppercase tracking-wide mb-1">Oppose</div>
                    <div className="text-sm font-semibold text-slate-900">{debate.opposing_label}</div>
                    <div className="text-xs text-slate-500 mt-1">{opposingArguments.length} arguments</div>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                  {debateArguments.length === 0 ? (
                    <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
                      <MessageSquare className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                      <p className="text-sm font-medium text-slate-900 mb-1">No arguments yet</p>
                      <p className="text-sm text-slate-500">Be the first to share your perspective</p>
                    </div>
                  ) : (
                    debateArguments.map((arg) => {
                      const isCollapsed = collapsedCards.has(arg.argument_id);
                      return (
                        <div
                          key={arg.argument_id}
                          className={`rounded-xl border transition-all duration-200 ${
                            arg.position === 'supporting'
                              ? 'bg-emerald-50/40 border-emerald-200 hover:border-emerald-300'
                              : 'bg-orange-50/40 border-orange-200 hover:border-orange-300'
                          } ${isCollapsed ? 'p-3' : 'p-4'}`}
                        >
                          <div className="flex items-start gap-3">
                            <div className={`rounded-lg flex items-center justify-center text-white font-bold flex-shrink-0 ${
                              isCollapsed ? 'w-9 h-9 text-xs' : 'w-10 h-10 text-sm'
                            } ${
                              arg.position === 'supporting'
                                ? 'bg-emerald-600'
                                : 'bg-orange-600'
                            }`}>
                              {arg.users.username[0].toUpperCase()}
                            </div>

                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="font-bold text-slate-900 text-sm">
                                  {arg.users.username}
                                </span>
                                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${
                                  arg.position === 'supporting'
                                    ? 'bg-emerald-600 text-white'
                                    : 'bg-orange-600 text-white'
                                }`}>
                                  {arg.position === 'supporting' ? debate.supporting_label : debate.opposing_label}
                                </span>
                              </div>

                              <div className="flex items-center gap-2 text-xs text-slate-600 mb-2">
                                <span className="font-semibold">{arg.users.reputation_score} pts</span>
                                <span>•</span>
                                <span>{new Date(arg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                              </div>

                              <div className={`transition-all duration-200 ease-in-out overflow-hidden ${
                                isCollapsed ? 'max-h-0 opacity-0' : 'max-h-[2000px] opacity-100'
                              }`}>
                                <p className="text-slate-800 leading-relaxed text-sm mb-3">
                                  {arg.content}
                                </p>

                                {arg.fact_check_status && (
                                  <div className={`rounded-lg p-2 mb-3 text-xs font-semibold flex items-center gap-1.5 ${
                                    arg.fact_check_status === 'verified'
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : 'bg-amber-100 text-amber-800'
                                  }`}>
                                    {arg.fact_check_status === 'verified' ? (
                                      <>
                                        <CheckCircle2 className="w-3.5 h-3.5" />
                                        <span>FACT CHECK: TRUE</span>
                                      </>
                                    ) : (
                                      <>
                                        <AlertCircle className="w-3.5 h-3.5" />
                                        <span>FACT CHECK: MIXED</span>
                                      </>
                                    )}
                                    <ChevronDown className="w-3.5 h-3.5 ml-auto" />
                                  </div>
                                )}

                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-3">
                                    <button className="flex items-center gap-1 text-slate-600 hover:text-emerald-600 transition-colors">
                                      <ThumbsUp className="w-4 h-4" />
                                      <span className="text-xs font-semibold">0</span>
                                    </button>
                                    <button className="flex items-center gap-1 text-slate-600 hover:text-orange-600 transition-colors">
                                      <ThumbsDown className="w-4 h-4" />
                                      <span className="text-xs font-semibold">0</span>
                                    </button>
                                  </div>
                                  <button className={`text-xs font-semibold px-3 py-1 rounded ${
                                    arg.position === 'supporting'
                                      ? 'bg-orange-100 text-orange-700 hover:bg-orange-200'
                                      : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                                  } transition-colors flex items-center gap-1`}>
                                    <MessageSquare className="w-3.5 h-3.5" />
                                    Agreement
                                  </button>
                                </div>
                              </div>
                            </div>

                            <button
                              onClick={() => toggleCardCollapse(arg.argument_id)}
                              className={`p-1 rounded hover:bg-white/50 transition-all flex-shrink-0 ${
                                arg.position === 'supporting' ? 'text-emerald-600' : 'text-orange-600'
                              }`}
                              aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                            >
                              {isCollapsed ? (
                                <ChevronDown className="w-4 h-4" />
                              ) : (
                                <ChevronDown className="w-4 h-4" />
                              )}
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
              </div>

              <div className="bg-white rounded-xl border border-slate-200 p-6 card-shadow mt-6">
                  <h3 className="text-lg font-bold text-slate-900 mb-4">Share Your Opinion</h3>

                  {!currentUser ? (
                    <div className="text-center py-8">
                      <MessageSquare className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                      <p className="text-sm font-medium text-slate-900 mb-1">Join the Discussion</p>
                      <p className="text-sm text-slate-500 mb-4">Sign in to share your arguments</p>
                      <button
                        onClick={() => setShowAuthModal(true)}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium text-sm transition-colors"
                      >
                        Sign In / Sign Up
                      </button>
                    </div>
                  ) : (
                    <form onSubmit={handleSubmitArgument} className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">
                          Choose Your Position
                        </label>
                        <div className="grid grid-cols-2 gap-3">
                          <button
                            type="button"
                            onClick={() => setSelectedPosition('supporting')}
                            className={`px-4 py-3 rounded-lg font-medium text-sm transition-all ${
                              selectedPosition === 'supporting'
                                ? 'bg-emerald-600 text-white'
                                : 'bg-slate-50 text-slate-700 hover:bg-slate-100'
                            }`}
                          >
                            {debate.supporting_label}
                          </button>
                          <button
                            type="button"
                            onClick={() => setSelectedPosition('opposing')}
                            className={`px-4 py-3 rounded-lg font-medium text-sm transition-all ${
                              selectedPosition === 'opposing'
                                ? 'bg-rose-600 text-white'
                                : 'bg-slate-50 text-slate-700 hover:bg-slate-100'
                            }`}
                          >
                            {debate.opposing_label}
                          </button>
                        </div>
                      </div>

                      <div>
                        <label htmlFor="argument" className="block text-sm font-medium text-slate-700 mb-2">
                          Your Argument
                        </label>
                        <textarea
                          id="argument"
                          name="argument"
                          value={newArgument}
                          onChange={(e) => setNewArgument(e.target.value)}
                          placeholder="Share your perspective and reasoning..."
                          rows={4}
                          className="w-full px-4 py-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none text-slate-900 placeholder:text-slate-400"
                          required
                        />
                      </div>

                      <button
                        type="submit"
                        className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-lg transition-colors flex items-center justify-center gap-2"
                      >
                        <MessageSquare className="w-4 h-4" />
                        Post Argument
                      </button>
                    </form>
                  )}
                </div>
              </>
            ) : (
              <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
                <MessageSquare className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <p className="text-lg font-medium text-slate-900 mb-2">No Active Debates</p>
                <p className="text-slate-500 mb-6">Create a new debate to get started</p>
                {currentUser && (
                  <button
                    onClick={() => setShowCreateDebate(true)}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium text-sm transition-colors"
                  >
                    Create Debate
                  </button>
                )}
              </div>
            )}
          </div>

          <div className={`hidden lg:block flex-shrink-0 transition-all duration-300 ${sidebarCollapsed ? 'w-16' : 'w-80'}`}>
            <div className="sticky top-24">
              <TopicSidebar
                userId={currentUser?.user_id}
                userPreferences={userPreferences}
                onCreateTopic={() => setShowCreateTopic(true)}
                onTopicSelect={handleTopicSelect}
                selectedTopicId={selectedTopic?.topic_id}
                isCollapsed={sidebarCollapsed}
                onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
              />
            </div>
          </div>
        </div>
      </div>

      {showAuthModal && (
        <AuthModal
          onClose={() => setShowAuthModal(false)}
          onSuccess={handleAuthSuccess}
        />
      )}

      {showCreateDebate && (
        <CreateDebateModal
          userId={currentUser?.user_id || ''}
          onClose={() => setShowCreateDebate(false)}
          onSuccess={handleDebateCreated}
        />
      )}

      {showTopicPreferences && currentUser && (
        <TopicPreferencesModal
          userId={currentUser.user_id}
          currentPreferences={userPreferences}
          onClose={() => setShowTopicPreferences(false)}
          onSuccess={(preferences) => {
            setUserPreferences(preferences);
            setShowTopicPreferences(false);
          }}
        />
      )}

      {showCreateTopic && currentUser && (
        <CreateTopicModal
          userId={currentUser.user_id}
          onClose={() => setShowCreateTopic(false)}
          onSuccess={handleTopicCreated}
        />
      )}
    </div>
  );
}

export default App;
